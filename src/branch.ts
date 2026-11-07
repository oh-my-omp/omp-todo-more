/**
 * Everything todo-more reads from a session branch, as one forward fold.
 *
 * Authority: the session's active branch (root → leaf). Every fact here is a
 * pure function of the entries on it; nothing is written back.
 *
 * Near copy: `branchFacts(manager)` keeps one accumulator per session manager
 * so a read folds only the entries appended since the previous read.
 * - Derived from: `manager.getBranchView()`.
 * - Depends on: the path to the last folded entry. A node fixes its whole
 *   ancestor path, so the copy is valid while the view still holds the last
 *   folded entry's id at the same position.
 * - Invalidated by: a leaf move off that path (branch, tree navigation, a
 *   session switch, a rewritten index); the next read then folds the branch
 *   from the root.
 * - Refreshed by: every read, synchronously, before it returns.
 *
 * `readTodoMore`/`askWaits` fold a given entry list from scratch; they are the
 * same rule without the copy.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type ExtensionContext, type SessionEntry, z } from "@oh-my-pi/pi-coding-agent";
import {
	type AskWait,
	EMPTY,
	joinNative,
	type ListRecord,
	type NativeRecord,
	OVERTIME_TYPE,
	overtimeDetailsSchema,
	REMINDER_TYPE,
	recordOf,
	type TodoMoreState,
} from "./state.ts";

/** A real human message on the branch and the list as it stood when the message landed. */
export type HumanMark =
	| { readonly kind: "message"; readonly timestamp: number; readonly content: unknown; readonly state: TodoMoreState }
	| {
			readonly kind: "custom";
			readonly customType: string;
			readonly timestamp: number;
			readonly content: unknown;
			readonly state: TodoMoreState;
	  };

/** Custom session entry holding one compaction's rendered `ctx` snapshot (ctx/post-compact-hint.ts); never sent to the model itself. */
export const POST_COMPACT_SNAPSHOT_TYPE = "todo-more.post-compact-ctx";
const postCompactSnapshotSchema = z.object({ compactionId: z.string(), text: z.string() });

/** The latest compaction on the branch and the `ctx` snapshot recorded for it, if any. */
export type CompactionBoundary =
	| { readonly kind: "none" }
	| { readonly kind: "unrendered"; readonly compactionId: string }
	| { readonly kind: "rendered"; readonly compactionId: string; readonly text: string };

/** The branch facts a read hands out. Callers MUST NOT mutate the collections. */
export type BranchFacts = {
	readonly state: TodoMoreState;
	/** Closed ask waits in branch order, then the still-open ones (`end: null`). */
	readonly waits: readonly AskWait[];
	/** Budget ids an overtime warning was delivered for. */
	readonly overtimeWarned: ReadonlySet<string>;
	/** Reminder messages since the latest real (non-synthetic) user message. */
	readonly remindersSinceUserMessage: number;
	/** Distinct models since the session's previous todo commit, in order of first use. */
	readonly modelsSinceCommit: readonly string[];
	readonly humans: readonly HumanMark[];
	readonly compaction: CompactionBoundary;
};

type Accumulator = {
	length: number;
	lastId: string | undefined;
	state: TodoMoreState;
	readonly openAsks: Map<string, number>;
	readonly closedWaits: AskWait[];
	readonly overtimeWarned: Set<string>;
	remindersSinceUserMessage: number;
	readonly commitShas: Set<string>;
	modelsSinceCommit: string[];
	readonly humans: HumanMark[];
	compaction: CompactionBoundary;
	facts: BranchFacts | undefined;
};

function emptyAccumulator(): Accumulator {
	return {
		length: 0,
		lastId: undefined,
		state: EMPTY,
		openAsks: new Map(),
		closedWaits: [],
		overtimeWarned: new Set(),
		remindersSinceUserMessage: 0,
		commitShas: new Set(),
		modelsSinceCommit: [],
		humans: [],
		compaction: { kind: "none" },
		facts: undefined,
	};
}

/** Host custom entry types (`pi-coding-agent` `session/exit-diagnostics.ts`). */
const TOOL_EXECUTION_START = "tool_execution_start";
const SESSION_EXIT = "session_exit";
const toolStartSchema = z.object({ toolCallId: z.string(), toolName: z.string(), startedAt: z.string() });

function waitsOf(acc: Accumulator): AskWait[] {
	const waits = acc.closedWaits.slice();
	for (const start of acc.openAsks.values()) waits.push({ start, end: null });
	return waits;
}

/** Match OMP's user-authored queue predicate, excluding synthetic continuations. */
export function isHumanMessage(message: AgentMessage): message is Extract<AgentMessage, { role: "user" | "custom" }> {
	if (message.role === "user") return message.attribution !== "agent" && !message.synthetic;
	return message.role === "custom" && message.attribution === "user" && message.display !== false;
}

function foldAsk(acc: Accumulator, entry: SessionEntry): void {
	if (entry.type === "custom" && entry.customType === TOOL_EXECUTION_START) {
		const parsed = toolStartSchema.safeParse(entry.data);
		const start = parsed.success && parsed.data.toolName === "ask" ? Date.parse(parsed.data.startedAt) : Number.NaN;
		if (parsed.success && Number.isFinite(start)) acc.openAsks.set(parsed.data.toolCallId, start);
	} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "ask") {
		const start = acc.openAsks.get(entry.message.toolCallId);
		if (start === undefined) return;
		acc.openAsks.delete(entry.message.toolCallId);
		acc.closedWaits.push({ start, end: entry.message.timestamp });
	} else if (entry.type === "custom" && entry.customType === SESSION_EXIT) {
		const end = Date.parse(entry.timestamp);
		for (const start of acc.openAsks.values()) acc.closedWaits.push({ start, end });
		acc.openAsks.clear();
	}
}

/**
 * The list record fold. A native record joins the list as it stands, with the
 * ask waits seen so far: a join only counts waits that started before it and
 * clips them at its own time, so later entries cannot change it.
 */
function foldState(acc: Accumulator, record: ListRecord | undefined): void {
	if (record === undefined) return;
	switch (record.kind) {
		case "rich":
			acc.state = record.state;
			return;
		case "native":
			acc.state = joinNative(record.phases, nativeBase(acc.state, record), record.at, waitsOf(acc));
			return;
		default: {
			const unreachable: never = record;
			throw new Error(`Unexpected todo record: ${String(unreachable)}`);
		}
	}
}

/** An empty native snapshot ends the join chain: the list restarts from nothing. */
function nativeBase(state: TodoMoreState, record: NativeRecord): TodoMoreState {
	return record.phases.every((phase) => phase.tasks.length === 0) ? EMPTY : state;
}

/** Commit shas recorded by a rich snapshot (the record `foldEntry` already parsed). */
function commitShasOf(record: ListRecord | undefined): string[] {
	if (record?.kind !== "rich" || record.state.kind !== "list") return [];
	return record.state.phases.flatMap((phase) => phase.items.flatMap((item) => (item.commit === undefined ? [] : [item.commit.sha])));
}

function foldModels(acc: Accumulator, entry: SessionEntry, record: ListRecord | undefined): void {
	const shas = commitShasOf(record);
	if (shas.some((sha) => !acc.commitShas.has(sha))) {
		for (const sha of shas) acc.commitShas.add(sha);
		acc.modelsSinceCommit = [];
		return;
	}
	// A failed request produced nothing; an aborted one may already have acted through its tool calls.
	if (entry.type !== "message" || entry.message.role !== "assistant" || entry.message.stopReason === "error") return;
	const model = `${entry.message.provider}/${entry.message.model}`;
	if (!acc.modelsSinceCommit.includes(model)) acc.modelsSinceCommit.push(model);
}

function foldMessages(acc: Accumulator, entry: SessionEntry): void {
	if (entry.type === "message") {
		const message = entry.message;
		if (message.role === "user" && message.synthetic !== true) acc.remindersSinceUserMessage = 0;
		if (isHumanMessage(message)) {
			acc.humans.push({ kind: "message", timestamp: message.timestamp, content: message.content, state: acc.state });
		}
		return;
	}
	if (entry.type !== "custom_message") return;
	if (entry.customType === REMINDER_TYPE) acc.remindersSinceUserMessage++;
	if (entry.customType === OVERTIME_TYPE) {
		const parsed = overtimeDetailsSchema.safeParse(entry.details);
		if (parsed.success) acc.overtimeWarned.add(parsed.data.budgetId);
	}
	if (entry.attribution === "user" && entry.display !== false) {
		acc.humans.push({
			kind: "custom",
			customType: entry.customType,
			timestamp: Date.parse(entry.timestamp),
			content: entry.content,
			state: acc.state,
		});
	}
}

/** The latest snapshot after the latest compaction decides: rendered when it names that compaction. */
function foldCompaction(acc: Accumulator, entry: SessionEntry): void {
	if (entry.type === "compaction") {
		acc.compaction = { kind: "unrendered", compactionId: entry.id };
		return;
	}
	if (acc.compaction.kind === "none" || entry.type !== "custom" || entry.customType !== POST_COMPACT_SNAPSHOT_TYPE) return;
	const parsed = postCompactSnapshotSchema.safeParse(entry.data);
	if (!parsed.success) return;
	const compactionId = acc.compaction.compactionId;
	acc.compaction =
		parsed.data.compactionId === compactionId
			? { kind: "rendered", compactionId, text: parsed.data.text }
			: { kind: "unrendered", compactionId };
}

function foldEntry(acc: Accumulator, entry: SessionEntry): void {
	// Parsed once: the list fold and the commit-sha fold read the same record.
	const record = recordOf(entry);
	foldAsk(acc, entry);
	foldCompaction(acc, entry);
	foldState(acc, record);
	foldModels(acc, entry, record);
	foldMessages(acc, entry);
}

function foldFrom(acc: Accumulator, entries: readonly SessionEntry[]): void {
	const length = entries.length;
	if (length === acc.length) return;
	let last: SessionEntry | undefined;
	for (let index = acc.length; index < length; index++) {
		last = entries[index];
		if (last !== undefined) foldEntry(acc, last);
	}
	acc.facts = undefined;
	acc.length = length;
	acc.lastId = last?.id;
}

function factsOf(acc: Accumulator): BranchFacts {
	acc.facts ??= {
		state: acc.state,
		waits: waitsOf(acc),
		overtimeWarned: acc.overtimeWarned,
		remindersSinceUserMessage: acc.remindersSinceUserMessage,
		modelsSinceCommit: acc.modelsSinceCommit,
		humans: acc.humans,
		compaction: acc.compaction,
	};
	return acc.facts;
}

/** The branch facts of `entries` (a session branch, oldest first), folded from scratch. */
export function foldBranch(entries: readonly SessionEntry[]): BranchFacts {
	const acc = emptyAccumulator();
	foldFrom(acc, entries);
	return factsOf(acc);
}

/** The todo-more state on `entries` (a session branch, oldest first). */
export function readTodoMore(entries: readonly SessionEntry[]): TodoMoreState {
	return foldBranch(entries).state;
}

/** The ask waits on `entries` (a session branch, oldest first). */
export function askWaits(entries: readonly SessionEntry[]): AskWait[] {
	return foldBranch(entries).waits.slice();
}

/** A session manager's live branch: `getBranchView` exists on the concrete manager, which the extension pick types omit. */
export type BranchSource = { getBranchView(): readonly SessionEntry[]; getLeafId(): string | null };

/** The live branch behind `ctx.sessionManager`. */
export function contextBranch(ctx: Pick<ExtensionContext, "sessionManager">): BranchSource {
	// The host hands extensions its concrete SessionManager; `ReadonlySessionManager` only narrows the type.
	return ctx.sessionManager as unknown as BranchSource;
}

const accumulators = new WeakMap<BranchSource, Accumulator>();

/** The current branch facts of `manager`, folding only what was appended since the last read. */
export function branchFacts(manager: BranchSource): BranchFacts {
	const view = manager.getBranchView();
	let acc = accumulators.get(manager);
	// Same leaf, same length: nothing to fold, no entry read.
	if (acc !== undefined && view.length === acc.length && manager.getLeafId() === (acc.lastId ?? null)) return factsOf(acc);
	if (acc === undefined || view.length < acc.length || (acc.length > 0 && view[acc.length - 1]?.id !== acc.lastId)) {
		acc = emptyAccumulator();
		accumulators.set(manager, acc);
	}
	foldFrom(acc, view);
	return factsOf(acc);
}

/** The list as it stood when `message` (a real human message) landed; the current list when it is not on the branch yet. */
export function stateForHumanMessage(facts: BranchFacts, message: Extract<AgentMessage, { role: "user" | "custom" }>): TodoMoreState {
	if (message.role === "custom") {
		// OMP can stamp the stored custom_message a millisecond after the live
		// message. Use the first matching record at or after its emission, not
		// exact equality or the newest matching text (which conflates repeats).
		const mark = facts.humans.find(
			(human) =>
				human.kind === "custom" &&
				human.customType === message.customType &&
				human.timestamp >= message.timestamp &&
				Bun.deepEquals(human.content, message.content),
		);
		return mark?.state ?? facts.state;
	}
	const mark = facts.humans.findLast(
		(human) => human.kind === "message" && human.timestamp === message.timestamp && Bun.deepEquals(human.content, message.content),
	);
	return mark?.state ?? facts.state;
}
