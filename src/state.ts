/**
 * The todo-more domain and its branch reader.
 *
 * Authority: the active session branch. `todo-more` appends a full snapshot
 * entry (`TODO_MORE_ENTRY_TYPE`) on changing mutations; the host's own
 * writers that bypass the tool (`/todo`, finished-subagent auto-complete) append
 * native-shaped `user_todo_edit` entries, and sessions from before todo-more
 * hold native `todo` tool results. `readTodoMore` is a pure read rule over
 * those records; nothing is cached.
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

/** The ask waits on `entries` (a session branch, oldest first). */
export function askWaits(entries: readonly SessionEntry[]): AskWait[] {
	const open = new Map<string, number>();
	const waits: AskWait[] = [];
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === TOOL_EXECUTION_START) {
			const parsed = toolStartSchema.safeParse(entry.data);
			const start = parsed.success && parsed.data.toolName === "ask" ? Date.parse(parsed.data.startedAt) : Number.NaN;
			if (parsed.success && Number.isFinite(start)) open.set(parsed.data.toolCallId, start);
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "ask") {
			const start = open.get(entry.message.toolCallId);
			if (start === undefined) continue;
			open.delete(entry.message.toolCallId);
			waits.push({ start, end: entry.message.timestamp });
		} else if (entry.type === "custom" && entry.customType === SESSION_EXIT) {
			const end = Date.parse(entry.timestamp);
			for (const start of open.values()) waits.push({ start, end });
			open.clear();
		}
	}
	for (const start of open.values()) waits.push({ start, end: null });
	return waits;
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

const markedDetailsSchema = z.object({ [TODO_MORE_RESULT_MARK]: z.literal(true) }).passthrough();

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
	const parsed = nativeResultSchema.safeParse(entry.message);
	if (!parsed.success || parsed.data.isError === true || parsed.data.details.op === "view") return undefined;
	// todo-more's own results follow the entry that records them.
	if (markedDetailsSchema.safeParse(parsed.data.details).success) return undefined;
	return { kind: "native", phases: parsed.data.details.phases, at: Date.parse(entry.timestamp) };
}
// @upstream-end

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

/** The todo-more state on `entries` (a session branch, oldest first). */
export function readTodoMore(entries: readonly SessionEntry[]): TodoMoreState {
	const pending: Extract<Record, { kind: "native" }>[] = [];
	const join = (state: TodoMoreState, native: Extract<Record, { kind: "native" }>): TodoMoreState =>
		joinNative(native.phases, state, native.at, askWaits(entries));
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry === undefined) continue;
		const record = recordOf(entry);
		if (record === undefined) continue;
		if (record.kind === "rich") return pending.reduceRight<TodoMoreState>(join, record.state);
		pending.push(record);
		if (record.phases.every((phase) => phase.tasks.length === 0)) break;
	}
	return pending.reduceRight<TodoMoreState>(join, EMPTY);
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
