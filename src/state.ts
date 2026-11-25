import { z } from "@oh-my-pi/omptype/zod";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import type { TodoPhase as HostTodoPhase } from "@oh-my-pi/pi-coding-agent/tools/details/todo";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";

export const TODO_NG_ENTRY_TYPE = "mouriya.omp.todo-more";

export const TODO_NG_NOTES_TYPE = `${TODO_NG_ENTRY_TYPE}.notes`;

export const PLANNING_DELIVERY_TYPE = `${TODO_NG_ENTRY_TYPE}.planning`;

export const TODO_NG_RESULT_MARK = "todoMore";

export const REMINDER_TYPE = `${TODO_NG_ENTRY_TYPE}.reminder`;

export const OVERTIME_TYPE = `${TODO_NG_ENTRY_TYPE}.overtime`;
export const overtimeDetailsSchema = z.object({
	budgetId: z.string(),
	title: z.string(),
	estimatedMinutes: z.number(),
	elapsedMs: z.number(),
});

export const planningDeliverySchema = z.object({ key: z.string() });

export const TODO_STATUSES = ["pending", "in_progress", "completed", "abandoned"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export const nonEmptyText = z.string().refine((value) => value.trim().length > 0, "must not be empty");

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

export const estimateSchema = z.union([
	z.object({ kind: z.literal("missing") }),
	z.object({ kind: z.literal("estimated"), budgetId: z.string().min(1), minutes: estimatedMinutesSchema }),
]);
export type Estimate = z.infer<typeof estimateSchema>;

export const progressSchema = z.union([
	z.object({
		status: z.literal("pending"),
		startedAt: timestampSchema.nullable(),
		elapsedMs: timestampSchema,
		pausedAt: timestampSchema.nullable(),
	}),
	z.object({
		status: z.literal("in_progress"),
		startedAt: timestampSchema.nullable(),
		elapsedMs: timestampSchema,
		runningSince: timestampSchema.nullable(),
	}),
	z.object({
		status: z.enum(["completed", "abandoned"]),
		startedAt: timestampSchema.nullable(),
		elapsedMs: timestampSchema,
		closedAt: timestampSchema.nullable(),
	}),
]);
export type Progress = z.infer<typeof progressSchema>;

export const FRESH: Progress = { status: "pending", startedAt: null, elapsedMs: 0, pausedAt: null };

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

export function elapsedOf(progress: Progress, now: number, waits: readonly AskWait[] = []): number {
	if (progress.status !== "in_progress" || progress.runningSince === null) return progress.elapsedMs;
	return progress.elapsedMs + Math.max(0, now - progress.runningSince - waitedIn(waits, progress.runningSince, now));
}

export function transition(progress: Progress, status: TodoStatus, now: number, waits: readonly AskWait[] = []): Progress {
	if (progress.status === status) return progress;
	const startedAt = progress.startedAt;
	const elapsedMs = elapsedOf(progress, now, waits);
	switch (status) {
		case "in_progress":
			return { status, startedAt: startedAt ?? now, elapsedMs, runningSince: now };
		case "pending":
			return { status, startedAt, elapsedMs, pausedAt: progress.status === "in_progress" ? now : null };
		case "completed":
		case "abandoned":
			return { status, startedAt, elapsedMs, closedAt: now };
		default: {
			const unreachable: never = status;
			throw new Error(`Unexpected todo status: ${String(unreachable)}`);
		}
	}
}

function adopt(progress: Progress, status: TodoStatus): Progress {
	if (progress.status === status) return progress;
	const { startedAt, elapsedMs } = progress;
	switch (status) {
		case "in_progress":
			return { status, startedAt, elapsedMs, runningSince: null };
		case "pending":
			return { status, startedAt, elapsedMs, pausedAt: null };
		case "completed":
		case "abandoned":
			return { status, startedAt, elapsedMs, closedAt: null };
		default: {
			const unreachable: never = status;
			throw new Error(`Unexpected todo status: ${String(unreachable)}`);
		}
	}
}

export type TailRule = { readonly ruleId: string; readonly protected: boolean };

const tailRuleSchema = z.object({ ruleId: z.string().min(1), protected: z.boolean() }).strict();

export type TodoItem = {
	readonly id: string;
	readonly title: string;
	readonly explanation: Explanation;
	readonly estimate: Estimate;
	readonly progress: Progress;
	readonly commit: CommitRecord | null;
	readonly tailRule: TailRule | null;
};

export function dueAt(item: TodoItem, now: number, waits: readonly AskWait[] = []): number | undefined {
	const { estimate, progress } = item;
	if (estimate.kind === "missing" || progress.status !== "in_progress" || progress.runningSince === null) return undefined;
	return now + estimate.minutes * 60_000 - elapsedOf(progress, now, waits);
}

export type TodoPhase = { readonly name: string; readonly items: readonly TodoItem[] };

export type TodoNgState =
	| { readonly kind: "empty" }
	| { readonly kind: "list"; readonly goal: GoalState; readonly phases: readonly TodoPhase[] };

export const EMPTY: TodoNgState = { kind: "empty" };

export const todoGoalSchema = z.object({ objective: nonEmptyText, measure: nonEmptyText, doneWhen: nonEmptyText });

export const persistedStatusSchema = z
	.enum([...TODO_STATUSES, "blocked"])
	.transform((status): TodoStatus => (status === "blocked" ? "pending" : status));

export const todoNgSnapshotSchema = z.object({
	goal: todoGoalSchema.nullable(),
	phases: z.array(
		z.object({
			name: z.string(),
			items: z.array(
				z.object({
					id: z.string(),
					title: z.string(),
					explanation: z.string().nullable(),
					status: z.enum(TODO_STATUSES),
					estimate: estimateSchema,
					commit: commitRecordSchema.nullable(),
				}),
			),
		}),
	),
});
export type TodoNgSnapshot = z.infer<typeof todoNgSnapshotSchema>;
export type SnapshotItem = TodoNgSnapshot["phases"][number]["items"][number];

const itemNoteSchema = z
	.object({
		id: z.string().min(1),
		phase: z.string(),
		title: z.string(),
		explanation: z.string().nullable(),
		estimate: estimateSchema,
		progress: progressSchema,
		commit: commitRecordSchema.nullable(),
		tailRule: tailRuleSchema.optional(),
	})
	.strict();
type ItemNote = z.infer<typeof itemNoteSchema>;

const legacyItemNoteSchema = z
	.object({
		id: z.string().min(1).optional(),
		phase: z.string(),
		title: z.string(),
		explanation: z.string().nullable(),
		time: z.union([
			z.object({ kind: z.literal("missing") }),
			z.object({
				kind: z.literal("estimated"),
				budgetId: z.string().min(1),
				minutes: estimatedMinutesSchema,
				elapsedMs: timestampSchema,
				runningSince: timestampSchema.nullable(),
			}),
		]),
		timestamps: z
			.object({
				startedAt: timestampSchema.optional(),
				pausedAt: timestampSchema.optional(),
				completedAt: timestampSchema.optional(),
				abandonedAt: timestampSchema.optional(),
			})
			.optional(),
		commit: commitRecordSchema.optional(),
	})
	.transform((legacy) => {
		const time = legacy.time;
		const stamps = legacy.timestamps ?? {};
		const elapsedMs = time.kind === "estimated" ? time.elapsedMs : 0;
		const runningSince = time.kind === "estimated" ? time.runningSince : null;
		const startedAt = stamps.startedAt ?? runningSince;
		const progress: Progress =
			runningSince !== null
				? { status: "in_progress", startedAt, elapsedMs, runningSince }
				: stamps.completedAt !== undefined
					? { status: "completed", startedAt, elapsedMs, closedAt: stamps.completedAt }
					: stamps.abandonedAt !== undefined
						? { status: "abandoned", startedAt, elapsedMs, closedAt: stamps.abandonedAt }
						: { status: "pending", startedAt, elapsedMs, pausedAt: stamps.pausedAt ?? null };
		return {
			id: legacy.id,
			phase: legacy.phase,
			title: legacy.title,
			explanation: legacy.explanation,
			estimate: time.kind === "estimated" ? { kind: "estimated" as const, budgetId: time.budgetId, minutes: time.minutes } : time,
			progress,
			commit: legacy.commit ?? null,
		};
	});

export function idAllocator(existing: Iterable<string>): () => string {
	let max = 0;
	for (const id of existing) {
		const match = /^t(\d+)$/.exec(id);
		if (match?.[1] !== undefined) max = Math.max(max, Number(match[1]));
	}
	return () => `t${++max}`;
}

export const todoNotesSchema = z
	.object({ goal: todoGoalSchema.nullable(), items: z.array(z.union([itemNoteSchema, legacyItemNoteSchema])) })
	.transform(({ goal, items }) => {
		const allocate = idAllocator(items.flatMap((item) => (item.id === undefined ? [] : [item.id])));
		return { goal, items: items.map((item): ItemNote => ({ ...item, id: item.id ?? allocate() })) };
	});
export type TodoNotes = z.infer<typeof todoNotesSchema>;

export const NO_NOTES: TodoNotes = { goal: null, items: [] };

const hostPhasesSchema = z.array(
	z.object({
		name: z.string(),
		tasks: z.array(z.object({ content: z.string(), status: persistedStatusSchema })),
	}),
);

const hostEditSchema = z.object({ phases: hostPhasesSchema });

const hostResultSchema = z.object({
	role: z.literal("toolResult"),
	toolName: z.literal("todo"),
	isError: z.boolean().optional(),
	details: z.object({ op: z.string().optional(), phases: hostPhasesSchema }),
});

export function stateOf(goal: GoalState, phases: readonly TodoPhase[]): TodoNgState {
	return phases.every((phase) => phase.items.length === 0) ? EMPTY : { kind: "list", goal, phases };
}

const goalValue = (goal: GoalState): TodoGoal | null => (goal.kind === "set" ? goal.goal : null);
export const explanationValue = (explanation: Explanation): string | null => (explanation.kind === "explained" ? explanation.text : null);

export function toSnapshot(state: TodoNgState): TodoNgSnapshot {
	if (state.kind === "empty") return { goal: null, phases: [] };
	return {
		goal: goalValue(state.goal),
		phases: state.phases.map((phase) => ({
			name: phase.name,
			items: phase.items.map((item) => ({
				id: item.id,
				title: item.title,
				explanation: explanationValue(item.explanation),
				status: item.progress.status,
				estimate: item.estimate,
				commit: item.commit,
			})),
		})),
	};
}

export type BranchRecord =
	| { readonly kind: "notes"; readonly notes: TodoNotes }
	| { readonly kind: "phases"; readonly phases: HostTodoPhase[] }
	| { readonly kind: "view" };

export function recordOf(entry: SessionEntry): BranchRecord | undefined {
	if (entry.type === "custom") {
		if (entry.customType === USER_TODO_EDIT_CUSTOM_TYPE) {
			const parsed = hostEditSchema.safeParse(entry.data);
			return parsed.success ? { kind: "phases", phases: parsed.data.phases } : undefined;
		}
		if (entry.customType !== TODO_NG_NOTES_TYPE) return undefined;
		const parsed = todoNotesSchema.safeParse(entry.data);
		return parsed.success ? { kind: "notes", notes: parsed.data } : undefined;
	}
	if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "todo") return undefined;
	const parsed = hostResultSchema.safeParse(entry.message);
	if (!parsed.success || parsed.data.isError === true) return undefined;
	return parsed.data.details.op === "view" ? { kind: "view" } : { kind: "phases", phases: parsed.data.details.phases };
}

export function joinHost(phases: readonly HostTodoPhase[], notes: TodoNotes): TodoNgState {
	const known = new Map<string, ItemNote>();
	for (const note of notes.items) known.set(`${note.phase}\u0000${note.title}`, note);
	const allocate = idAllocator(notes.items.map((note) => note.id));
	const taken = new Set<string>();
	const joined = phases.map((phase) => ({
		name: phase.name,
		items: phase.tasks.map((task): TodoItem => {
			const note = known.get(`${phase.name}\u0000${task.content}`);
			const id = note !== undefined && !taken.has(note.id) ? note.id : allocate();
			taken.add(id);
			const text = note?.explanation ?? null;
			return {
				id,
				title: task.content,
				explanation: text === null ? { kind: "missing" } : { kind: "explained", text },
				estimate: note?.estimate ?? { kind: "missing" },
				progress: adopt(note?.progress ?? FRESH, task.status),
				commit: note?.commit ?? null,
				tailRule: note?.tailRule ?? null,
			};
		}),
	}));
	return stateOf(notes.goal === null ? { kind: "missing" } : { kind: "set", goal: notes.goal }, joined);
}

export function toNotes(state: TodoNgState): TodoNotes {
	if (state.kind === "empty") return NO_NOTES;
	return {
		goal: goalValue(state.goal),
		items: state.phases.flatMap((phase) =>
			phase.items.map((item) => ({
				id: item.id,
				phase: phase.name,
				title: item.title,
				explanation: explanationValue(item.explanation),
				estimate: item.estimate,
				progress: item.progress,
				commit: item.commit,
				...(item.tailRule === null ? {} : { tailRule: item.tailRule }),
			})),
		),
	};
}

export function hostPhases(state: TodoNgState): HostTodoPhase[] {
	if (state.kind === "empty") return [];
	return state.phases.map((phase) => ({
		name: phase.name,
		tasks: phase.items.map((item) => ({ content: item.title, status: item.progress.status })),
	}));
}

export function isOpen(status: TodoStatus): boolean {
	return status === "pending" || status === "in_progress";
}

export type TodoRound = "empty" | "closed" | "open";

export function roundOf(state: TodoNgState): TodoRound {
	if (state.kind === "empty") return "empty";
	return state.phases.some((phase) => phase.items.some((item) => isOpen(item.progress.status))) ? "open" : "closed";
}

export function actionableItems(state: TodoNgState): { readonly phase: string; readonly item: TodoItem }[] {
	if (state.kind === "empty") return [];
	return state.phases.flatMap((phase) =>
		phase.items.filter((item) => isOpen(item.progress.status)).map((item) => ({ phase: phase.name, item })),
	);
}

export function unexplainedItems(state: TodoNgState): TodoItem[] {
	if (state.kind === "empty") return [];
	return state.phases.flatMap((phase) => phase.items.filter((item) => item.explanation.kind === "missing"));
}

export function goalLines(goal: TodoGoal): string[] {
	return [`Objective: ${goal.objective}`, `Measure: ${goal.measure}`, `Done when: ${goal.doneWhen}`];
}

export function explanationText(item: TodoItem): string {
	return explanationValue(item.explanation) ?? "(no explanation yet: add one with explain)";
}

export function phaseSlug(name: string): string {
	const slug = name
		.trim()
		.toLowerCase()
		.replace(/[\s_]+/g, "-")
		.replace(/[^\p{L}\p{N}-]+/gu, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || encodeURIComponent(name.trim().toLowerCase());
}

export function commitRecordText(commit: CommitRecord): string {
	return `${commit.sha.slice(0, 7)} ${JSON.stringify(commit.message)}`;
}

export function commitScopeText(scope: CommitScope): string {
	return scope.kind === "all" ? "this agent's changes" : scope.files.join(" ");
}

const minuteOf = (ms: number | null | undefined): number | null => (ms == null ? null : Math.floor(ms / 60_000));

function progressMark(item: TodoItem, now: number, waits: readonly AskWait[]): number | null {
	const progress = item.progress;
	switch (progress.status) {
		case "in_progress":
			return minuteOf(dueAt(item, now, waits));
		case "pending":
			return progress.startedAt === null ? null : minuteOf(progress.pausedAt);
		case "completed":
		case "abandoned":
			return minuteOf(progress.closedAt);
		default: {
			const unreachable: never = progress;
			throw new Error(`Unexpected progress: ${String(unreachable)}`);
		}
	}
}

export function semanticStateKey(state: TodoNgState, now: number, waits: readonly AskWait[]): string {
	if (state.kind === "empty") return "empty";
	return JSON.stringify({
		goal: goalValue(state.goal),
		phases: state.phases.map((phase) => ({
			name: phase.name,
			items: phase.items.map((item) => ({
				id: item.id,
				title: item.title,
				status: item.progress.status,
				explanation: explanationValue(item.explanation),
				minutes: item.estimate.kind === "estimated" ? item.estimate.minutes : null,
				mark: progressMark(item, now, waits),
				commit: item.commit?.sha ?? null,
			})),
		})),
	});
}
