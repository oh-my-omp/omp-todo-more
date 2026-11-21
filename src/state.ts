import { type SessionEntry, z } from "@oh-my-pi/pi-coding-agent";
import type { TodoPhase as HostTodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

export const TODO_MORE_ENTRY_TYPE = "mouriya.omp.todo-more";

/** The plugin's own part of the list: goal, explanations, timers and commit records. Structure and statuses live in the host list. */
export const TODO_MORE_NOTES_TYPE = `${TODO_MORE_ENTRY_TYPE}.notes`;

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

export const itemTimestampsSchema = z.object({
	startedAt: timestampSchema.optional(),
	pausedAt: timestampSchema.optional(),
	completedAt: timestampSchema.optional(),
	abandonedAt: timestampSchema.optional(),
	statusChangedAt: timestampSchema.optional(),
});
export type ItemTimestamps = z.infer<typeof itemTimestampsSchema>;

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

export function dueAtTime(time: Extract<ItemTime, { kind: "estimated" }>, now: number, waits: readonly AskWait[] = []): number | undefined {
	if (time.runningSince === null) return undefined;
	return now + (time.minutes * 60_000 - elapsedTime(time, now, waits));
}

export function transitionTimestamps(
	previousStatus: TodoStatus | undefined,
	nextStatus: TodoStatus,
	timestamps: ItemTimestamps | undefined,
	now: number,
	fallbackStartedAt?: number,
): ItemTimestamps | undefined {
	if (previousStatus === nextStatus) return timestamps;
	const startedAt = timestamps?.startedAt ?? fallbackStartedAt;
	switch (nextStatus) {
		case "in_progress":
			return { startedAt: startedAt ?? now, statusChangedAt: now };
		case "pending":
			if (previousStatus === "in_progress") {
				return {
					...(startedAt === undefined ? {} : { startedAt }),
					pausedAt: now,
					statusChangedAt: now,
				};
			}
			return { ...(startedAt === undefined ? {} : { startedAt }), statusChangedAt: now };
		case "completed":
			return {
				...(startedAt === undefined ? {} : { startedAt }),
				completedAt: now,
				statusChangedAt: now,
			};
		case "abandoned":
			return {
				...(startedAt === undefined ? {} : { startedAt }),
				abandonedAt: now,
				statusChangedAt: now,
			};
		default: {
			const unreachable: never = nextStatus;
			throw new Error(`Unexpected todo status: ${String(unreachable)}`);
		}
	}
}

export type TodoItem = {
	readonly title: string;
	readonly explanation: Explanation;
	readonly status: TodoStatus;
	readonly time: ItemTime;
	readonly timestamps?: ItemTimestamps;
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
	timestamps: itemTimestampsSchema.optional(),
});

export const todoMoreSnapshotSchema = z.object({
	goal: todoGoalSchema.nullable(),
	phases: z.array(z.object({ name: z.string(), items: z.array(itemSnapshotSchema) })),
});
export type TodoMoreSnapshot = z.infer<typeof todoMoreSnapshotSchema>;

const itemNoteSchema = z.object({
	phase: z.string(),
	title: z.string(),
	explanation: z.string().nullable(),
	time: itemTimeSchema,
	timestamps: itemTimestampsSchema.optional(),
	commit: commitRecordSchema.optional(),
});

/** What the host list cannot hold, attached to its items by phase name and title. */
export const todoNotesSchema = z.object({ goal: todoGoalSchema.nullable(), items: z.array(itemNoteSchema) });
export type TodoNotes = z.infer<typeof todoNotesSchema>;

export const NO_NOTES: TodoNotes = { goal: null, items: [] };

const hostPhasesSchema = z.array(
	z.object({
		name: z.string(),
		tasks: z.array(z.object({ content: z.string(), status: persistedStatusSchema })),
	}),
);

const hostResultSchema = z
	.object({
		role: z.literal("toolResult"),
		toolName: z.literal("todo"),
		isError: z.boolean().optional(),
		details: z.object({ op: z.string().optional(), phases: hostPhasesSchema }).passthrough(),
	})
	.passthrough();

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
						...(item.timestamps === undefined ? {} : { timestamps: item.timestamps }),
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

export function snapshotToState(snapshot: TodoMoreSnapshot): TodoMoreState {
	const phases: TodoPhase[] = snapshot.phases.map((phase) => ({
		name: phase.name,
		items: phase.items.map(
			(item): TodoItem => ({
				title: item.title,
				explanation: item.explanation === null ? { kind: "missing" } : { kind: "explained", text: item.explanation },
				status: item.status,
				time: item.time,
				...(item.timestamps === undefined ? {} : { timestamps: item.timestamps }),
				...(item.commit === undefined ? {} : { commit: item.commit }),
			}),
		),
	}));
	return stateOf(snapshot.goal === null ? { kind: "missing" } : { kind: "set", goal: snapshot.goal }, phases);
}

/** One record the list is read from: the plugin's notes, or the host list a `todo` result carried. */
export type ListRecord =
	| { readonly kind: "notes"; readonly notes: TodoNotes }
	| { readonly kind: "phases"; readonly phases: HostTodoPhase[] };

export function recordOf(entry: SessionEntry): ListRecord | undefined {
	if (entry.type === "custom") {
		if (entry.customType !== TODO_MORE_NOTES_TYPE) return undefined;
		const parsed = todoNotesSchema.safeParse(entry.data);
		return parsed.success ? { kind: "notes", notes: parsed.data } : undefined;
	}
	if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "todo") return undefined;
	const parsed = hostResultSchema.safeParse(entry.message);
	if (!parsed.success || parsed.data.isError === true || parsed.data.details.op === "view") return undefined;
	return { kind: "phases", phases: parsed.data.details.phases };
}

const noteKey = (phase: string, title: string): string => `${phase}\u0000${title}`;

/** Structure and statuses come from the host list only; a note with no matching host item contributes nothing. */
export function joinHost(phases: readonly HostTodoPhase[], notes: TodoNotes): TodoMoreState {
	const known = new Map<string, TodoNotes["items"][number]>();
	for (const note of notes.items) known.set(noteKey(note.phase, note.title), note);
	const joined = phases.map((phase) => ({
		name: phase.name,
		items: phase.tasks.map((task): TodoItem => {
			const note = known.get(noteKey(phase.name, task.content));
			return {
				title: task.content,
				explanation: note?.explanation == null ? { kind: "missing" } : { kind: "explained", text: note.explanation },
				time: note?.time ?? { kind: "missing" },
				status: task.status,
				...(note?.timestamps === undefined ? {} : { timestamps: note.timestamps }),
				...(note?.commit === undefined ? {} : { commit: note.commit }),
			};
		}),
	}));
	return stateOf(notes.goal === null ? { kind: "missing" } : { kind: "set", goal: notes.goal }, joined);
}

export function toNotes(state: TodoMoreState): TodoNotes {
	switch (state.kind) {
		case "empty":
			return NO_NOTES;
		case "list":
			return {
				goal: state.goal.kind === "set" ? state.goal.goal : null,
				items: state.phases.flatMap((phase) =>
					phase.items.map((item) => ({
						phase: phase.name,
						title: item.title,
						explanation: item.explanation.kind === "explained" ? item.explanation.text : null,
						time: item.time,
						...(item.timestamps === undefined ? {} : { timestamps: item.timestamps }),
						...(item.commit === undefined ? {} : { commit: item.commit }),
					})),
				),
			};
		default: {
			const unreachable: never = state;
			throw new Error(`Unexpected todo-more state: ${String(unreachable)}`);
		}
	}
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
