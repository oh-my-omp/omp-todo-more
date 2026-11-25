import { z } from "@oh-my-pi/omptype/zod";
import type { SessionEntry, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { SESSION_EXIT_CUSTOM_TYPE, TOOL_EXECUTION_START_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import type { TodoPhase as HostTodoPhase } from "@oh-my-pi/pi-coding-agent/tools/details/todo";
import {
	type AskWait,
	type BranchRecord,
	EMPTY,
	joinHost,
	NO_NOTES,
	OVERTIME_TYPE,
	overtimeDetailsSchema,
	PLANNING_DELIVERY_TYPE,
	planningDeliverySchema,
	REMINDER_TYPE,
	recordOf,
	semanticStateKey,
	type TodoNgState,
	type TodoNotes,
} from "./state.ts";

export type SeenList = { readonly key: string; readonly state: TodoNgState };

export type PlanningFacts = {
	readonly delivered: string | null;
	readonly seen: SeenList | null;
	readonly recovered: boolean;
};

export type BranchFacts = {
	readonly state: TodoNgState;
	readonly notes: TodoNotes;
	readonly waits: readonly AskWait[];
	readonly overtimeWarned: ReadonlySet<string>;
	readonly remindersSinceUserMessage: number;
	readonly modelsSinceCommit: readonly string[];
	readonly planning: PlanningFacts;
};

type Accumulator = {
	length: number;
	lastId: string | undefined;
	phases: HostTodoPhase[];
	notes: TodoNotes;
	state: TodoNgState;
	readonly openAsks: Map<string, number>;
	readonly closedWaits: AskWait[];
	readonly overtimeWarned: Set<string>;
	remindersSinceUserMessage: number;
	readonly commitShas: Set<string>;
	modelsSinceCommit: string[];
	planning: PlanningFacts;
	facts: BranchFacts | undefined;
};

function emptyAccumulator(): Accumulator {
	return {
		length: 0,
		lastId: undefined,
		phases: [],
		notes: NO_NOTES,
		state: EMPTY,
		openAsks: new Map(),
		closedWaits: [],
		overtimeWarned: new Set(),
		remindersSinceUserMessage: 0,
		commitShas: new Set(),
		modelsSinceCommit: [],
		planning: { delivered: null, seen: null, recovered: true },
		facts: undefined,
	};
}

const toolStartSchema = z.object({ toolCallId: z.string(), toolName: z.string(), startedAt: z.string() });

function waitsOf(acc: Accumulator): AskWait[] {
	const waits = acc.closedWaits.slice();
	for (const start of acc.openAsks.values()) waits.push({ start, end: null });
	return waits;
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

function foldState(acc: Accumulator, entry: SessionEntry, record: BranchRecord | undefined): void {
	if (record === undefined) return;
	switch (record.kind) {
		case "notes":
			acc.notes = record.notes;
			acc.state = joinHost(acc.phases, acc.notes);
			return;
		case "phases":
			acc.phases = record.phases;
			acc.state = joinHost(acc.phases, acc.notes);
			break;
		case "view":
			break;
		default: {
			const unreachable: never = record;
			throw new Error(`Unexpected todo record: ${String(unreachable)}`);
		}
	}
	const key = semanticStateKey(acc.state, Date.parse(entry.timestamp), waitsOf(acc));
	acc.planning = { ...acc.planning, seen: { key, state: acc.state } };
}

function foldPlanning(acc: Accumulator, entry: SessionEntry): void {
	if (entry.type === "compaction" || entry.type === "branch_summary") {
		acc.planning = { ...acc.planning, recovered: false };
		return;
	}
	if (entry.type !== "custom" || entry.customType !== PLANNING_DELIVERY_TYPE) return;
	const parsed = planningDeliverySchema.safeParse(entry.data);
	if (parsed.success) acc.planning = { delivered: parsed.data.key, seen: { key: parsed.data.key, state: acc.state }, recovered: true };
}

function foldModels(acc: Accumulator, entry: SessionEntry, record: BranchRecord | undefined): void {
	const shas = record?.kind === "notes" ? record.notes.items.flatMap((note) => (note.commit === null ? [] : [note.commit.sha])) : [];
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
		if (entry.message.role === "user" && entry.message.synthetic !== true) acc.remindersSinceUserMessage = 0;
		return;
	}
	if (entry.type !== "custom_message") return;
	if (entry.customType === REMINDER_TYPE) acc.remindersSinceUserMessage++;
	if (entry.customType === OVERTIME_TYPE) {
		const parsed = overtimeDetailsSchema.safeParse(entry.details);
		if (parsed.success) acc.overtimeWarned.add(parsed.data.budgetId);
	}
}

function foldEntry(acc: Accumulator, entry: SessionEntry): void {
	const record = recordOf(entry);
	foldAsk(acc, entry);
	foldState(acc, entry, record);
	foldPlanning(acc, entry);
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
		notes: acc.notes,
		waits: waitsOf(acc),
		overtimeWarned: acc.overtimeWarned,
		remindersSinceUserMessage: acc.remindersSinceUserMessage,
		modelsSinceCommit: acc.modelsSinceCommit,
		planning: acc.planning,
	};
	return acc.facts;
}

export function foldBranch(entries: readonly SessionEntry[]): BranchFacts {
	const acc = emptyAccumulator();
	foldFrom(acc, entries);
	return factsOf(acc);
}

export type FactsAtEntry = Pick<BranchFacts, "state" | "waits">;

export function foldBranchAt(entries: readonly SessionEntry[], indices: ReadonlySet<number>): Map<number, FactsAtEntry> {
	const acc = emptyAccumulator();
	const facts = new Map<number, FactsAtEntry>();
	for (let index = 0; facts.size < indices.size && index < entries.length; index++) {
		const entry = entries[index];
		if (entry === undefined) continue;
		foldEntry(acc, entry);
		if (indices.has(index)) facts.set(index, { state: acc.state, waits: waitsOf(acc) });
	}
	return facts;
}
export type BranchSource = Pick<SessionManager, "getBranchView" | "getLeafId">;

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
