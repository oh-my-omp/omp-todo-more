import { type SessionEntry, z } from "@oh-my-pi/pi-coding-agent";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { TodoPhase as HostTodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

export const TODO_MORE_ENTRY_TYPE = "mouriya.omp.todo-more";

export const TODO_MORE_RESULT_MARK = "todoMore";

export const REMINDER_TYPE = `${TODO_MORE_ENTRY_TYPE}.reminder`;

export const OVERTIME_TYPE = `${TODO_MORE_ENTRY_TYPE}.overtime`;
export const overtimeDetailsSchema = z.object({
	budgetId: z.string(),
	title: z.string(),
	estimatedMinutes: z.number(),
	elapsedMs: z.number(),
});

export const TODO_STATUSES = ["pending", "in_progress", "completed", "abandoned"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export type TodoGoal = { readonly objective: string; readonly measure: string; readonly doneWhen: string };

export type GoalState = { readonly kind: "set"; readonly goal: TodoGoal } | { readonly kind: "missing" };

export type Explanation = { readonly kind: "explained"; readonly text: string } | { readonly kind: "missing" };

export type CommitScope = { readonly kind: "all" } | { readonly kind: "paths"; readonly files: string[] };

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

export type AskWait = { readonly start: number; readonly end: number | null };

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
	readonly commit?: CommitRecord;
};

export type TodoPhase = { readonly name: string; readonly items: readonly TodoItem[] };

export type TodoMoreState =
	| { readonly kind: "empty" }
	| { readonly kind: "list"; readonly goal: GoalState; readonly phases: readonly TodoPhase[] };

export const EMPTY: TodoMoreState = { kind: "empty" };

const nonEmpty = z.string().refine((value) => value.trim().length > 0, "must not be empty");

export const todoGoalSchema = z.object({ objective: nonEmpty, measure: nonEmpty, doneWhen: nonEmpty });

// Session data written before the blocked status was removed still says "blocked"; it reads back as pending, as the host reads it.
export const persistedStatusSchema = z
	.enum([...TODO_STATUSES, "blocked"])
	.transform((status): TodoStatus => (status === "blocked" ? "pending" : status));

const itemSnapshotSchema = z.object({
	title: z.string(),
	explanation: z.string().nullable(),
	status: persistedStatusSchema,
	commit: commitRecordSchema.optional(),
	time: itemTimeSchema.default(() => ({ kind: "missing" })),
});

export const todoMoreSnapshotSchema = z.object({
	goal: todoGoalSchema.nullable(),
	phases: z.array(z.object({ name: z.string(), items: z.array(itemSnapshotSchema) })),
});
export type TodoMoreSnapshot = z.infer<typeof todoMoreSnapshotSchema>;

const nativePhasesSchema = z.array(
	z.object({
		name: z.string(),
		tasks: z.array(z.object({ content: z.string(), status: persistedStatusSchema })),
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
				...(item.commit === undefined ? {} : { commit: item.commit }),
			}),
		),
	}));
	return stateOf(goal, phases);
}

export type NativeRecord = { readonly kind: "native"; readonly phases: NativePhases; readonly at: number };

export type ListRecord = { readonly kind: "rich"; readonly state: TodoMoreState } | NativeRecord;

export function recordOf(entry: SessionEntry): ListRecord | undefined {
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
	if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "todo") return undefined;
	const parsed = nativeResultSchema.safeParse(entry.message);
	if (!parsed.success || parsed.data.isError === true || parsed.data.details.op === "view") return undefined;
	if (markedDetailsSchema.safeParse(parsed.data.details).success) return undefined;
	return { kind: "native", phases: parsed.data.details.phases, at: Date.parse(entry.timestamp) };
}

export function joinNative(phases: NativePhases, base: TodoMoreState, at: number, waits: readonly AskWait[]): TodoMoreState {
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
				...(previous?.commit === undefined ? {} : { commit: previous.commit }),
			};
		}),
	}));
	return stateOf(base.kind === "list" ? base.goal : { kind: "missing" }, joined);
}

export function hostPhases(state: TodoMoreState): HostTodoPhase[] {
	switch (state.kind) {
		case "empty":
			return [];
		case "list":
			return state.phases.map((phase) => ({
				name: phase.name,
				tasks: phase.items.map((item) => ({ content: item.title, status: item.status })),
			}));
		default: {
			const unreachable: never = state;
			throw new Error(`Unexpected todo-more state: ${String(unreachable)}`);
		}
	}
}

export function actionableItems(state: TodoMoreState): { readonly phase: string; readonly item: TodoItem }[] {
	if (state.kind === "empty") return [];
	return state.phases.flatMap((phase) =>
		phase.items.filter((item) => item.status === "pending" || item.status === "in_progress").map((item) => ({ phase: phase.name, item })),
	);
}

export function unexplainedItems(state: TodoMoreState): TodoItem[] {
	if (state.kind === "empty") return [];
	return state.phases.flatMap((phase) => phase.items.filter((item) => item.explanation.kind === "missing"));
}

export function goalLines(goal: TodoGoal): string[] {
	return [`Objective: ${goal.objective}`, `Measure: ${goal.measure}`, `Done when: ${goal.doneWhen}`];
}

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

export function commitRecordText(commit: CommitRecord): string {
	return `${commit.sha.slice(0, 7)} ${JSON.stringify(commit.message)}`;
}

export function commitScopeText(scope: CommitScope): string {
	return scope.kind === "all" ? "this agent's changes" : scope.files.join(" ");
}
