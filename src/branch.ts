import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type ExtensionContext, type SessionEntry, type SessionManager, z } from "@oh-my-pi/pi-coding-agent";
import { SESSION_EXIT_CUSTOM_TYPE, TOOL_EXECUTION_START_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
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

export type HumanMark =
	| { readonly kind: "message"; readonly timestamp: number; readonly content: unknown; readonly state: TodoMoreState }
	| {
			readonly kind: "custom";
			readonly customType: string;
			readonly timestamp: number;
			readonly content: unknown;
			readonly state: TodoMoreState;
	  };

/** Callers MUST NOT mutate the collections. */
export type BranchFacts = {
	readonly state: TodoMoreState;
	readonly waits: readonly AskWait[];
	readonly overtimeWarned: ReadonlySet<string>;
	readonly remindersSinceUserMessage: number;
	readonly modelsSinceCommit: readonly string[];
	readonly humans: readonly HumanMark[];
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
		facts: undefined,
	};
}

const toolStartSchema = z.object({ toolCallId: z.string(), toolName: z.string(), startedAt: z.string() });

function waitsOf(acc: Accumulator): AskWait[] {
	const waits = acc.closedWaits.slice();
	for (const start of acc.openAsks.values()) waits.push({ start, end: null });
	return waits;
}

export function isHumanMessage(message: AgentMessage): message is Extract<AgentMessage, { role: "user" | "custom" }> {
	if (message.role === "user") return message.attribution !== "agent" && !message.synthetic;
	return message.role === "custom" && message.attribution === "user" && message.display !== false;
}

function foldAsk(acc: Accumulator, entry: SessionEntry): void {
	if (entry.type === "custom" && entry.customType === TOOL_EXECUTION_START_CUSTOM_TYPE) {
		const parsed = toolStartSchema.safeParse(entry.data);
		const start = parsed.success && parsed.data.toolName === "ask" ? Date.parse(parsed.data.startedAt) : Number.NaN;
		if (parsed.success && Number.isFinite(start)) acc.openAsks.set(parsed.data.toolCallId, start);
	} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "ask") {
		const start = acc.openAsks.get(entry.message.toolCallId);
		if (start === undefined) return;
		acc.openAsks.delete(entry.message.toolCallId);
		acc.closedWaits.push({ start, end: entry.message.timestamp });
	} else if (entry.type === "custom" && entry.customType === SESSION_EXIT_CUSTOM_TYPE) {
		const end = Date.parse(entry.timestamp);
		for (const start of acc.openAsks.values()) acc.closedWaits.push({ start, end });
		acc.openAsks.clear();
	}
}

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

function nativeBase(state: TodoMoreState, record: NativeRecord): TodoMoreState {
	return record.phases.every((phase) => phase.tasks.length === 0) ? EMPTY : state;
}

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

function foldEntry(acc: Accumulator, entry: SessionEntry): void {
	const record = recordOf(entry);
	foldAsk(acc, entry);
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
	};
	return acc.facts;
}

export function foldBranch(entries: readonly SessionEntry[]): BranchFacts {
	const acc = emptyAccumulator();
	foldFrom(acc, entries);
	return factsOf(acc);
}

export function readTodoMore(entries: readonly SessionEntry[]): TodoMoreState {
	return foldBranch(entries).state;
}

export function askWaits(entries: readonly SessionEntry[]): AskWait[] {
	return foldBranch(entries).waits.slice();
}

export type BranchSource = Pick<SessionManager, "getBranchView" | "getLeafId">;

export function contextBranch(ctx: Pick<ExtensionContext, "sessionManager">): BranchSource {
	return ctx.sessionManager as SessionManager;
}

const accumulators = new WeakMap<BranchSource, Accumulator>();

export function branchFacts(manager: BranchSource): BranchFacts {
	const view = manager.getBranchView();
	let acc = accumulators.get(manager);
	if (acc !== undefined && view.length === acc.length && manager.getLeafId() === (acc.lastId ?? null)) return factsOf(acc);
	if (acc === undefined || view.length < acc.length || (acc.length > 0 && view[acc.length - 1]?.id !== acc.lastId)) {
		acc = emptyAccumulator();
		accumulators.set(manager, acc);
	}
	foldFrom(acc, view);
	return factsOf(acc);
}

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
