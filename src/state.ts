/**
 * The todo-more domain and its branch reader.
 *
 * Authority: the active session branch. `todo-more` appends a full snapshot
 * entry (`TODO_MORE_ENTRY_TYPE`) on changing mutations; the host's own
 * writers that bypass the tool (`/todo`, finished-subagent auto-complete) append
 * native-shaped `user_todo_edit` entries, and sessions from before todo-more
 * hold native `todo` tool results. `readTodoMore` is a pure read rule over
 * those records; nothing is cached across calls.
 *
 * Reading cost: an entry is discriminated by its cheap fields (`type`,
 * `customType`, `role`, `toolName`) before any schema parse, so only entries
 * that can define the list or an ask wait reach zod. `readTodoMore` walks back
 * from the leaf to the newest snapshot and reads the ask waits at most once,
 * only when a native record joins. A caller that needs the state and the ask
 * waits together takes `readTodoMoreWithWaits`; one that needs the state at
 * several branch positions takes `todoMoreHistory`. Both read the branch in a
 * single forward pass, and an optional visitor lets the caller observe the
 * same pass instead of walking the branch again.
 *
 * Copy markers: code taken from OMP is wrapped in
 * `// @upstream <verbatim|adapted> <package>@<version> <path>#<symbol>` …
 * `// @upstream-end`. `verbatim` means the block is character-for-character the
 * upstream text; `adapted` means it was changed (rich items, strict types).
 *
 * An item also carries the commit its completion made (git.ts takes it): a
 * copy of git's answer, written once and never refreshed.
 */
import { type SessionEntry, z } from "@oh-my-pi/pi-coding-agent";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { TodoPhase as HostTodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

export const TODO_MORE_ENTRY_TYPE = "mouriya.omp.todo-more";

/** Set on todo-more's own tool result details, so the reader skips them (the entry before them is the record). */
export const TODO_MORE_RESULT_MARK = "todoMore";

export const TODO_STATUSES = ["pending", "in_progress", "completed", "abandoned", "blocked"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

/** What the work is, how its result is measured, and how far it must go to count as done. */
export type TodoGoal = { readonly objective: string; readonly measure: string; readonly doneWhen: string };

/** `missing`: the list has items but no goal yet (it was built by `/todo`); the next tool mutation must set one. */
export type GoalState = { readonly kind: "set"; readonly goal: TodoGoal } | { readonly kind: "missing" };

/** `missing`: the item was added outside the tool (`/todo`, an older session) and still needs one. */
export type Explanation = { readonly kind: "explained"; readonly text: string } | { readonly kind: "missing" };

/** What a completion's commit covers: `all` is the whole checkout, `paths` the listed pathspecs only. */
export type CommitScope = { readonly kind: "all" } | { readonly kind: "paths"; readonly files: string[] };

/**
 * The commit a completion made, as git answered it. Git is the authority for
 * what was committed; this is the copy the list keeps, taken once at the
 * commit and never refreshed, so it can be read back without asking git again.
 * `message` is the completion's own message; git's copy also ends with the
 * `Model` trailers of the committing session (`models.ts`).
 */
export type CommitRecord = { readonly sha: string; readonly message: string; readonly scope: CommitScope };

export const commitScopeSchema = z.union([
	z.object({ kind: z.literal("all") }),
	z.object({ kind: z.literal("paths"), files: z.array(z.string().min(1)).min(1) }),
]);

export const commitRecordSchema = z.object({
	sha: z.string().min(1),
	message: z.string().min(1),
	scope: commitScopeSchema,
});

/** Estimates are model-owned; imported items have no invented budget or historical clock. */
export const estimatedMinutesSchema = z
	.number()
	.int()
	.positive()
	.max(Math.floor(Number.MAX_SAFE_INTEGER / 60_000));
const timestampSchema = z.number().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const itemTimeSchema = z.union([
	z.object({ kind: z.literal("missing") }),
	z.object({
		kind: z.literal("estimated"),
		budgetId: z.string().min(1),
		minutes: estimatedMinutesSchema,
		elapsedMs: timestampSchema,
		runningSince: timestampSchema.nullable(),
	}),
]);
export type ItemTime = z.infer<typeof itemTimeSchema>;

/**
 * A span the session spent waiting on the user in `ask`, read from the branch:
 * the host's `tool_execution_start` record of an `ask` call opens it (its
 * `startedAt`), the call's tool result closes it (the result's `timestamp`), or
 * the host's `session_exit` record does when the process ended while the ask
 * was open. `end` is null while the ask is still open.
 */
export type AskWait = { readonly start: number; readonly end: number | null };

/** Host custom entry types (`pi-coding-agent` `session/exit-diagnostics.ts`). */
const TOOL_EXECUTION_START = "tool_execution_start";
const SESSION_EXIT = "session_exit";
const toolStartSchema = z.object({ toolCallId: z.string(), toolName: z.string(), startedAt: z.string() });

/** One ask-wait fact of the branch, in branch order. */
type AskEvent =
	| { readonly kind: "start"; readonly callId: string; readonly at: number }
	| { readonly kind: "result"; readonly callId: string; readonly at: number }
	| { readonly kind: "exit"; readonly at: number };

/** Discriminants before zod: only `ask` starts parse. */
function askEventOf(entry: SessionEntry): AskEvent | undefined {
	if (entry.type === "custom") {
		if (entry.customType === SESSION_EXIT) return { kind: "exit", at: Date.parse(entry.timestamp) };
		if (entry.customType !== TOOL_EXECUTION_START) return undefined;
		const data: unknown = entry.data;
		if (typeof data !== "object" || data === null || !("toolName" in data) || data.toolName !== "ask") return undefined;
		const parsed = toolStartSchema.safeParse(data);
		const start = parsed.success ? Date.parse(parsed.data.startedAt) : Number.NaN;
		return parsed.success && Number.isFinite(start) ? { kind: "start", callId: parsed.data.toolCallId, at: start } : undefined;
	}
	if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "ask") {
		return { kind: "result", callId: entry.message.toolCallId, at: entry.message.timestamp };
	}
	return undefined;
}

/** Waits during a forward pass: `open` maps an ask call to its start, `closed` holds finished spans. */
type WaitScan = { readonly open: Map<string, number>; readonly closed: AskWait[] };

function stepWaits(scan: WaitScan, event: AskEvent): void {
	switch (event.kind) {
		case "start":
			scan.open.set(event.callId, event.at);
			return;
		case "result": {
			const start = scan.open.get(event.callId);
			if (start === undefined) return;
			scan.open.delete(event.callId);
			scan.closed.push({ start, end: event.at });
			return;
		}
		case "exit":
			for (const start of scan.open.values()) scan.closed.push({ start, end: event.at });
			scan.open.clear();
			return;
		default: {
			const unreachable: never = event;
			throw new Error(`Unexpected ask event: ${String(unreachable)}`);
		}
	}
}

/** Ends the scan: its finished spans, then the still-open ones. */
function finishWaits(scan: WaitScan): AskWait[] {
	for (const start of scan.open.values()) scan.closed.push({ start, end: null });
	scan.open.clear();
	return scan.closed;
}

/** The ask waits on `entries` (a session branch, oldest first). */
export function askWaits(entries: readonly SessionEntry[]): AskWait[] {
	const scan: WaitScan = { open: new Map(), closed: [] };
	for (const entry of entries) {
		const event = askEventOf(entry);
		if (event !== undefined) stepWaits(scan, event);
	}
	return finishWaits(scan);
}

/** Milliseconds of [from, to) spent in `waits` (an open wait runs to `to`); overlapping waits count once. */
function waitedIn(waits: readonly AskWait[], from: number, to: number): number {
	const spans = waits
		.map((wait) => [Math.max(from, wait.start), Math.min(to, wait.end ?? to)] as const)
		.filter(([start, end]) => end > start)
		.sort((left, right) => left[0] - right[0]);
	let total = 0;
	let reached = from;
	for (const [start, end] of spans) {
		const begin = Math.max(start, reached);
		if (end > begin) total += end - begin;
		reached = Math.max(reached, end);
	}
	return total;
}

/** Only in_progress wall time counts, minus the time spent waiting on the user in `ask`; leaving in_progress closes the interval. */
export function transitionTime(time: ItemTime, status: TodoStatus, now: number, waits: readonly AskWait[] = []): ItemTime {
	if (time.kind === "missing") return time;
	if (status === "in_progress") return time.runningSince === null ? { ...time, runningSince: now } : time;
	return time.runningSince === null ? time : { ...time, elapsedMs: elapsedTime(time, now, waits), runningSince: null };
}

export function elapsedTime(time: Extract<ItemTime, { kind: "estimated" }>, now: number, waits: readonly AskWait[] = []): number {
	if (time.runningSince === null) return time.elapsedMs;
	return time.elapsedMs + Math.max(0, now - time.runningSince - waitedIn(waits, time.runningSince, now));
}

export function timeEstimateText(time: ItemTime): string {
	return time.kind === "estimated" ? `Estimate: ${time.minutes} min` : "(no time estimate yet: add one with ESTIMATE)";
}

export type TodoItem = {
	readonly title: string;
	readonly explanation: Explanation;
	readonly status: TodoStatus;
	readonly time: ItemTime;
	/** The commit this item's completion made; absent when nothing was committed for it. */
	readonly commit?: CommitRecord;
	readonly blocker?: string;
};

export type TodoPhase = { readonly name: string; readonly items: readonly TodoItem[] };

/** `empty`: no items at all; an empty list carries no goal. */
export type TodoMoreState =
	| { readonly kind: "empty" }
	| { readonly kind: "list"; readonly goal: GoalState; readonly phases: readonly TodoPhase[] };

export const EMPTY: TodoMoreState = { kind: "empty" };

const nonEmpty = z.string().refine((value) => value.trim().length > 0, "must not be empty");

export const todoGoalSchema = z.object({ objective: nonEmpty, measure: nonEmpty, doneWhen: nonEmpty });

const statusSchema = z.enum(TODO_STATUSES);

/** Older snapshots and native imports are explicitly unestimated. */
export const itemSnapshotSchema = z.object({
	title: z.string(),
	explanation: z.string().nullable(),
	status: statusSchema,
	blocker: z.string().optional(),
	commit: commitRecordSchema.optional(),
	time: itemTimeSchema.default(() => ({ kind: "missing" })),
});

/** The persisted snapshot: `explanation: null` and `goal: null` encode the `missing` variants. */
export const todoMoreSnapshotSchema = z.object({
	goal: todoGoalSchema.nullable(),
	phases: z.array(z.object({ name: z.string(), items: z.array(itemSnapshotSchema) })),
});
export type TodoMoreSnapshot = z.infer<typeof todoMoreSnapshotSchema>;

const nativePhasesSchema = z.array(
	z.object({
		name: z.string(),
		tasks: z.array(z.object({ content: z.string(), status: statusSchema, blocker: z.string().optional() }).passthrough()),
	}),
);
type NativePhases = z.infer<typeof nativePhasesSchema>;

const userEditSchema = z.object({ phases: nativePhasesSchema }).passthrough();

const nativeResultSchema = z
	.object({
		role: z.literal("toolResult"),
		toolName: z.literal("todo"),
		isError: z.boolean().optional(),
		details: z.object({ op: z.string().optional(), phases: nativePhasesSchema }).passthrough(),
	})
	.passthrough();

export function itemCount(phases: readonly TodoPhase[]): number {
	return phases.reduce((total, phase) => total + phase.items.length, 0);
}

/** A state from phases and goal: no items means `empty`. */
export function stateOf(goal: GoalState, phases: readonly TodoPhase[]): TodoMoreState {
	return itemCount(phases) === 0 ? EMPTY : { kind: "list", goal, phases };
}

export function toSnapshot(state: TodoMoreState): TodoMoreSnapshot {
	switch (state.kind) {
		case "empty":
			return { goal: null, phases: [] };
		case "list":
			return {
				goal: state.goal.kind === "set" ? state.goal.goal : null,
				phases: state.phases.map((phase) => ({
					name: phase.name,
					items: phase.items.map((item) => ({
						title: item.title,
						explanation: item.explanation.kind === "explained" ? item.explanation.text : null,
						status: item.status,
						time: item.time,
						...(item.blocker === undefined ? {} : { blocker: item.blocker }),
						...(item.commit === undefined ? {} : { commit: item.commit }),
					})),
				})),
			};
		default: {
			const unreachable: never = state;
			throw new Error(`Unexpected todo-more state: ${String(unreachable)}`);
		}
	}
}

function fromSnapshot(snapshot: TodoMoreSnapshot): TodoMoreState {
	const goal: GoalState = snapshot.goal === null ? { kind: "missing" } : { kind: "set", goal: snapshot.goal };
	const phases = snapshot.phases.map((phase) => ({
		name: phase.name,
		items: phase.items.map(
			(item): TodoItem => ({
				title: item.title,
				explanation: item.explanation === null ? { kind: "missing" } : { kind: "explained", text: item.explanation },
				status: item.status,
				time: item.time,
				...(item.blocker === undefined ? {} : { blocker: item.blocker }),
				...(item.commit === undefined ? {} : { commit: item.commit }),
			}),
		),
	}));
	return stateOf(goal, phases);
}

/** One branch record that defines the list, newest first. */
type Record =
	| { readonly kind: "rich"; readonly state: TodoMoreState }
	| { readonly kind: "native"; readonly phases: NativePhases; readonly at: number };

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/tools/todo.ts#canonicalTodoPhases
function recordOf(entry: SessionEntry): Record | undefined {
	if (entry.type === "custom") {
		if (entry.customType === TODO_MORE_ENTRY_TYPE) {
			const parsed = todoMoreSnapshotSchema.safeParse(entry.data);
			return parsed.success ? { kind: "rich", state: fromSnapshot(parsed.data) } : undefined;
		}
		if (entry.customType === USER_TODO_EDIT_CUSTOM_TYPE) {
			const parsed = userEditSchema.safeParse(entry.data);
			return parsed.success ? { kind: "native", phases: parsed.data.phases, at: Date.parse(entry.timestamp) } : undefined;
		}
		return undefined;
	}
	if (entry.type !== "message") return undefined;
	// Discriminants before zod: only the native `todo` tool's results can define the list,
	// and todo-more's own results follow the entry that records them.
	const message = entry.message;
	if (message.role !== "toolResult" || message.toolName !== "todo" || isMarked(message.details)) return undefined;
	const parsed = nativeResultSchema.safeParse(message);
	if (!parsed.success || parsed.data.isError === true || parsed.data.details.op === "view") return undefined;
	return { kind: "native", phases: parsed.data.details.phases, at: Date.parse(entry.timestamp) };
}
// @upstream-end

/** A todo-more tool result's details carry `TODO_MORE_RESULT_MARK: true`. */
function isMarked(details: unknown): boolean {
	return typeof details === "object" && details !== null && TODO_MORE_RESULT_MARK in details && details[TODO_MORE_RESULT_MARK] === true;
}

/** The entries `recordOf` may map to a record: the same discriminants, no parse. */
function mayDefine(entry: SessionEntry): boolean {
	if (entry.type === "custom") return entry.customType === TODO_MORE_ENTRY_TYPE || entry.customType === USER_TODO_EDIT_CUSTOM_TYPE;
	return entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "todo";
}

/**
 * A native-shaped snapshot (host edit or pre-todo-more result) joined with the
 * nearest earlier rich snapshot: titles keep their explanation, the goal carries
 * over, new titles are `missing`. An empty snapshot in between ends the join.
 */
function joinNative(phases: NativePhases, base: TodoMoreState, at: number, waits: readonly AskWait[]): TodoMoreState {
	const known = new Map<string, TodoItem>();
	if (base.kind === "list") for (const item of base.phases.flatMap((phase) => phase.items)) known.set(item.title, item);
	const joined = phases.map((phase) => ({
		name: phase.name,
		items: phase.tasks.map((task): TodoItem => {
			const previous = known.get(task.content);
			return {
				title: task.content,
				explanation: previous?.explanation ?? { kind: "missing" },
				time: transitionTime(previous?.time ?? { kind: "missing" }, task.status, at, waits),
				status: task.status,
				...(task.blocker === undefined ? {} : { blocker: task.blocker }),
				...(previous?.commit === undefined ? {} : { commit: previous.commit }),
			};
		}),
	}));
	return stateOf(base.kind === "list" ? base.goal : { kind: "missing" }, joined);
}

type NativeRecord = Extract<Record, { kind: "native" }>;

/**
 * The list from records newest first: `recordAt(k)` for `k` from `count - 1`
 * down to 0. Native records after the newest rich one join onto it; `waits`
 * is called at most once, and only when a native record joins.
 */
function foldRecords(count: number, recordAt: (k: number) => Record | undefined, waits: () => readonly AskWait[]): TodoMoreState {
	const pending: NativeRecord[] = [];
	let base: TodoMoreState = EMPTY;
	for (let k = count - 1; k >= 0; k--) {
		const record = recordAt(k);
		if (record === undefined) continue;
		if (record.kind === "rich") {
			base = record.state;
			break;
		}
		pending.push(record);
		if (record.phases.every((phase) => phase.tasks.length === 0)) break;
	}
	if (pending.length === 0) return base;
	const known = waits();
	return pending.reduceRight<TodoMoreState>((state, native) => joinNative(native.phases, state, native.at, known), base);
}

/** The todo-more state on `entries` (a session branch, oldest first). */
export function readTodoMore(entries: readonly SessionEntry[]): TodoMoreState {
	return foldRecords(
		entries.length,
		(index) => {
			const entry = entries[index];
			return entry === undefined ? undefined : recordOf(entry);
		},
		() => askWaits(entries),
	);
}

/** Observes every entry of a reader's single pass, oldest first. */
export type BranchVisitor = (entry: SessionEntry, index: number) => void;

/** What one forward pass keeps: where the list may be defined, and the ask-wait facts with their positions. */
type BranchScan = {
	readonly candidates: number[];
	readonly events: AskEvent[];
	readonly eventAt: number[];
};

function scanBranch(entries: readonly SessionEntry[], visit: BranchVisitor | undefined): BranchScan {
	const scan: BranchScan = { candidates: [], events: [], eventAt: [] };
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (entry === undefined) continue;
		visit?.(entry, index);
		if (mayDefine(entry)) scan.candidates.push(index);
		const event = askEventOf(entry);
		if (event === undefined) continue;
		scan.events.push(event);
		scan.eventAt.push(index);
	}
	return scan;
}

/** The ask waits from the scan's first `count` events. */
function replayWaits(events: readonly AskEvent[], count: number): AskWait[] {
	const scan: WaitScan = { open: new Map(), closed: [] };
	for (let k = 0; k < count; k++) {
		const event = events[k];
		if (event !== undefined) stepWaits(scan, event);
	}
	return finishWaits(scan);
}

/** How many of the ascending `positions` are at or before `index`. */
function countThrough(positions: readonly number[], index: number): number {
	let low = 0;
	let high = positions.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if ((positions[middle] ?? Number.POSITIVE_INFINITY) <= index) low = middle + 1;
		else high = middle;
	}
	return low;
}

/** The state and the ask waits of one branch read. */
export type TodoMoreRead = { readonly state: TodoMoreState; readonly waits: readonly AskWait[] };

/**
 * `readTodoMore(entries)` and `askWaits(entries)` from one forward pass over
 * `entries`; `visit` sees every entry of that pass.
 */
export function readTodoMoreWithWaits(entries: readonly SessionEntry[], visit?: BranchVisitor): TodoMoreRead {
	const scan = scanBranch(entries, visit);
	const waits = replayWaits(scan.events, scan.events.length);
	const state = foldRecords(
		scan.candidates.length,
		(k) => {
			const entry = entries[scan.candidates[k] ?? -1];
			return entry === undefined ? undefined : recordOf(entry);
		},
		() => waits,
	);
	return { state, waits };
}

/** The todo-more state at positions of one branch. */
export type TodoMoreHistory = {
	/** The state on `entries[0..index]`: equal to `readTodoMore(entries.slice(0, index + 1))`. */
	at(index: number): TodoMoreState;
};

/**
 * Positional state queries over `entries`, built in one forward pass (`visit`
 * sees every entry of it). A query resolves only the records at or before its
 * position; records parse once per build, and positions with the same records
 * (and, when a native record joins, the same ask-wait facts) share one state
 * object. The build holds nothing beyond its own lifetime.
 */
export function todoMoreHistory(entries: readonly SessionEntry[], visit?: BranchVisitor): TodoMoreHistory {
	const scan = scanBranch(entries, visit);
	const records: (Record | null | undefined)[] = [];
	const recordAt = (k: number): Record | undefined => {
		const known = records[k];
		if (known !== undefined) return known ?? undefined;
		const entry = entries[scan.candidates[k] ?? -1];
		const record = entry === undefined ? undefined : recordOf(entry);
		records[k] = record ?? null;
		return record;
	};
	// Per count of records: the state when no native record joins, or the states per count of ask-wait facts.
	const resolved: (
		| { readonly kind: "plain"; readonly state: TodoMoreState }
		| { readonly kind: "joined"; readonly states: Map<number, TodoMoreState> }
	)[] = [];
	return {
		at(index: number): TodoMoreState {
			const count = countThrough(scan.candidates, index);
			const events = countThrough(scan.eventAt, index);
			const known = resolved[count];
			if (known?.kind === "plain") return known.state;
			const memo = known?.states.get(events);
			if (memo !== undefined) return memo;
			let joined = false;
			const state = foldRecords(count, recordAt, () => {
				joined = true;
				return replayWaits(scan.events, events);
			});
			if (!joined) resolved[count] = { kind: "plain", state };
			else if (known === undefined) resolved[count] = { kind: "joined", states: new Map([[events, state]]) };
			else known.states.set(events, state);
			return state;
		},
	};
}

/** The host's view of the list: what `session.setTodoPhases`, the HUD and native tool-result consumers take. */
export function hostPhases(state: TodoMoreState): HostTodoPhase[] {
	switch (state.kind) {
		case "empty":
			return [];
		case "list":
			return state.phases.map((phase) => ({
				name: phase.name,
				tasks: phase.items.map((item) =>
					item.blocker === undefined
						? { content: item.title, status: item.status }
						: { content: item.title, status: item.status, blocker: item.blocker },
				),
			}));
		default: {
			const unreachable: never = state;
			throw new Error(`Unexpected todo-more state: ${String(unreachable)}`);
		}
	}
}

/** Pending or in-progress items, in list order, with their phase name: what the stop reminder lists. */
export function actionableItems(state: TodoMoreState): { readonly phase: string; readonly item: TodoItem }[] {
	if (state.kind === "empty") return [];
	return state.phases.flatMap((phase) =>
		phase.items.filter((item) => item.status === "pending" || item.status === "in_progress").map((item) => ({ phase: phase.name, item })),
	);
}

/** Items that still need an explanation. */
export function unexplainedItems(state: TodoMoreState): TodoItem[] {
	if (state.kind === "empty") return [];
	return state.phases.flatMap((phase) => phase.items.filter((item) => item.explanation.kind === "missing"));
}

/** The goal as three labelled lines. */
export function goalLines(goal: TodoGoal): string[] {
	return [`Objective: ${goal.objective}`, `Measure: ${goal.measure}`, `Done when: ${goal.doneWhen}`];
}

/** An item's explanation for display: the text, or a marker asking for one. */
export function explanationText(item: TodoItem): string {
	switch (item.explanation.kind) {
		case "explained":
			return item.explanation.text;
		case "missing":
			return "(no explanation yet: add one with EXPLAIN)";
		default: {
			const unreachable: never = item.explanation;
			throw new Error(`Unexpected explanation: ${String(unreachable)}`);
		}
	}
}

/** A commit for display: short sha and the message git recorded. */
export function commitRecordText(commit: CommitRecord): string {
	return `${commit.sha.slice(0, 7)} ${JSON.stringify(commit.message)}`;
}

/** A commit's scope for display. */
export function commitScopeText(scope: CommitScope): string {
	return scope.kind === "all" ? "all changes" : scope.files.join(" ");
}
