import type { TodoCompletionTransition } from "@oh-my-pi/pi-coding-agent/tools/details/todo";
import { commitClauseOf, type TodoCommitClause, type TodoParams } from "./protocol.ts";
import {
	type AskWait,
	type CommitRecord,
	EMPTY,
	type Estimate,
	type Explanation,
	FRESH,
	type GoalState,
	idAllocator,
	type Progress,
	roundOf,
	stateOf,
	type TailRule,
	type TodoGoal,
	type TodoItem,
	type TodoNgState,
	type TodoStatus,
	transition,
} from "./state.ts";

export const OPS = ["init", "goal", "add", "start", "explain", "estimate", "done", "drop"] as const;
export type Op = (typeof OPS)[number];

export type AddedItem = { readonly id: string; readonly title: string; readonly explanation: string; readonly estimatedMinutes: number };

export type TodoChange =
	| { readonly op: "goal"; readonly goal: TodoGoal }
	| { readonly op: "add"; readonly phase: string; readonly items: readonly AddedItem[] }
	| { readonly op: "start"; readonly id: string; readonly title: string }
	| { readonly op: "explain"; readonly id: string; readonly title: string; readonly explanation: string }
	| { readonly op: "estimate"; readonly id: string; readonly title: string; readonly estimatedMinutes: number }
	| { readonly op: "done"; readonly id: string; readonly title: string; readonly commit: TodoCommitClause | null }
	| { readonly op: "drop"; readonly id: string; readonly title: string };

export type Located = { readonly item: TodoItem; readonly phase: string };

export function locate(state: TodoNgState): Map<string, Located> {
	const byId = new Map<string, Located>();
	if (state.kind === "list")
		for (const phase of state.phases) for (const item of phase.items) byId.set(item.id, { item, phase: phase.name });
	return byId;
}

type Staged = Located & { readonly added: AddedItem };

function stageAdds(params: TodoParams, previous: TodoNgState): Staged[] {
	const allocate = idAllocator(previous.kind === "list" ? previous.phases.flatMap((phase) => phase.items.map((item) => item.id)) : []);
	return (params.add ?? []).map((param) => {
		const id = allocate();
		return {
			phase: param.phase?.trim() || "Tasks",
			item: {
				id,
				title: param.title,
				explanation: { kind: "explained", text: param.detail },
				estimate: { kind: "estimated", budgetId: crypto.randomUUID(), minutes: param.minutes },
				progress: FRESH,
				commit: null,
				tailRule: null,
			},
			added: { id, title: param.title, explanation: param.detail, estimatedMinutes: param.minutes },
		};
	});
}

const overCap = (title: string, minutes: number, cap: number): string =>
	`Task "${title}" estimate ${minutes} min exceeds the ${cap}-minute limit for one item: split the work into several items of at most ${cap} min each`;

function validate(params: TodoParams, previous: TodoNgState, staged: readonly Staged[], leafMaxMinutes: number): string[] {
	const errors: string[] = [];
	const byId = locate(previous);
	const resolve = (id: string): Located | undefined => {
		const hit = byId.get(id);
		if (hit === undefined) errors.push(`Task ID "${id}" not found`);
		return hit;
	};
	const wasEmpty = previous.kind === "empty";
	if (params.goal === undefined && (previous.kind === "empty" || previous.goal.kind === "missing")) {
		errors.push(
			wasEmpty ? "Todo list is empty: provide goal and add to create it" : "The list has no goal: provide goal before other mutations",
		);
	}
	if (wasEmpty && params.add === undefined) errors.push("Todo list is empty: provide at least one item in add");
	const titles = new Set([...byId.values()].map(({ item }) => item.title));
	for (const entry of staged) {
		const { title, estimatedMinutes } = entry.added;
		if (titles.has(title)) errors.push(`Task "${title}" already exists`);
		titles.add(title);
		byId.set(entry.item.id, entry);
		if (estimatedMinutes > leafMaxMinutes) errors.push(overCap(title, estimatedMinutes, leafMaxMinutes));
	}
	for (const entry of params.explain ?? []) resolve(entry.id);
	for (const entry of params.estimate ?? []) {
		const hit = resolve(entry.id);
		if (entry.minutes > leafMaxMinutes) errors.push(overCap(hit?.item.title ?? entry.id, entry.minutes, leafMaxMinutes));
	}
	if (params.done_id !== undefined) {
		const hit = resolve(params.done_id);
		if (hit?.item.progress.status === "completed" && params.commit !== undefined) {
			errors.push(`Task "${hit.item.title}" (${params.done_id}) is already completed, so no completion owes this commit`);
		}
	}
	const dropped = new Set(params.drop_ids ?? []);
	for (const id of dropped) {
		if (id === params.done_id) errors.push(`Task ID "${id}" cannot be both done_id and in drop_ids`);
		resolve(id);
	}
	if (params.start_id !== undefined) {
		resolve(params.start_id);
		if (params.start_id === params.done_id || dropped.has(params.start_id)) {
			errors.push(`Task ID "${params.start_id}" cannot be started and closed in the same call`);
		}
	}
	return errors;
}

type Draft = {
	readonly id: string;
	readonly title: string;
	readonly base: Progress;
	readonly commit: CommitRecord | null;
	readonly tailRule: TailRule | null;
	explanation: Explanation;
	estimate: Estimate;
	status: TodoStatus;
};

export type Completion = { readonly id: string; readonly title: string };

export type Planned = {
	readonly base: TodoNgState;
	readonly next: TodoNgState;
	readonly operations: Op[];
	readonly changes: TodoChange[];
	readonly explained: ReadonlySet<string>;
	readonly completion: Completion | null;
	readonly completedTasks: TodoCompletionTransition[];
};

function normalizeInProgress(drafts: readonly Draft[]): void {
	const inProgress = drafts.filter((draft) => draft.status === "in_progress");
	for (const draft of inProgress.slice(1)) draft.status = "pending";
	if (inProgress.length > 0) return;
	const firstPending = drafts.find((draft) => draft.status === "pending");
	if (firstPending !== undefined) firstPending.status = "in_progress";
}

function toDraft(item: TodoItem): Draft {
	return {
		id: item.id,
		title: item.title,
		base: item.progress,
		commit: item.commit,
		tailRule: item.tailRule,
		explanation: item.explanation,
		estimate: item.estimate,
		status: item.progress.status,
	};
}

function apply(params: TodoParams, previous: TodoNgState, staged: readonly Staged[], now: number, waits: readonly AskWait[]): Planned {
	const phases: { readonly name: string; readonly drafts: Draft[] }[] =
		previous.kind === "empty" ? [] : previous.phases.map((phase) => ({ name: phase.name, drafts: phase.items.map(toDraft) }));
	const byId = new Map(phases.flatMap((phase) => phase.drafts.map((draft) => [draft.id, draft] as const)));
	const draftOf = (id: string): Draft => {
		const draft = byId.get(id);
		if (draft === undefined) throw new Error(`Validated task ID ${id} is missing`);
		return draft;
	};
	const operations: Op[] = [];
	const changes: TodoChange[] = [];
	const explained = new Set<string>();

	let goal: GoalState = previous.kind === "list" ? previous.goal : { kind: "missing" };
	if (params.goal !== undefined) {
		const set: TodoGoal = { objective: params.goal.title, measure: params.goal.summary, doneWhen: params.goal.acceptance };
		goal = { kind: "set", goal: set };
		operations.push(previous.kind === "empty" ? "init" : "goal");
		changes.push({ op: "goal", goal: set });
	}

	if (staged.length > 0) {
		const groups = new Map<string, AddedItem[]>();
		for (const { phase: name, item, added } of staged) {
			let phase = phases.find((candidate) => candidate.name === name);
			if (phase === undefined) {
				phase = { name, drafts: [] };
				phases.push(phase);
			}
			const draft = toDraft(item);
			phase.drafts.push(draft);
			byId.set(draft.id, draft);
			const group = groups.get(name) ?? [];
			group.push(added);
			groups.set(name, group);
		}
		if (previous.kind === "list") operations.push("add");
		for (const [phase, items] of groups) changes.push({ op: "add", phase, items });
	}

	if (params.explain !== undefined) {
		operations.push("explain");
		for (const entry of params.explain) {
			const draft = draftOf(entry.id);
			draft.explanation = { kind: "explained", text: entry.note };
			explained.add(draft.id);
			changes.push({ op: "explain", id: draft.id, title: draft.title, explanation: entry.note });
		}
	}

	if (params.estimate !== undefined) {
		operations.push("estimate");
		for (const entry of params.estimate) {
			const draft = draftOf(entry.id);
			if (draft.estimate.kind === "missing" || draft.estimate.minutes !== entry.minutes) {
				draft.estimate = { kind: "estimated", budgetId: crypto.randomUUID(), minutes: entry.minutes };
			}
			changes.push({ op: "estimate", id: draft.id, title: draft.title, estimatedMinutes: entry.minutes });
		}
	}

	let completion: Completion | null = null;
	if (params.done_id !== undefined) {
		operations.push("done");
		const draft = draftOf(params.done_id);
		if (draft.status !== "completed") completion = { id: draft.id, title: draft.title };
		draft.status = "completed";
		changes.push({
			op: "done",
			id: draft.id,
			title: draft.title,
			commit: params.commit === undefined ? null : commitClauseOf(params.commit),
		});
	}

	if (params.drop_ids !== undefined) {
		operations.push("drop");
		for (const id of params.drop_ids) {
			const draft = draftOf(id);
			draft.status = "abandoned";
			changes.push({ op: "drop", id: draft.id, title: draft.title });
		}
	}

	if (params.start_id !== undefined) {
		operations.push("start");
		const target = draftOf(params.start_id);
		for (const draft of byId.values()) if (draft.status === "in_progress") draft.status = "pending";
		target.status = "in_progress";
		changes.push({ op: "start", id: target.id, title: target.title });
	}

	const goalOnly = operations.length === 1 && operations[0] === "goal";
	if (!goalOnly) normalizeInProgress(phases.flatMap((phase) => phase.drafts));

	const completedTasks: TodoCompletionTransition[] = [];
	const next = stateOf(
		goal,
		phases.map((phase) => ({
			name: phase.name,
			items: phase.drafts.map((draft): TodoItem => {
				if (draft.status === "completed" && draft.base.status !== "completed")
					completedTasks.push({ phase: phase.name, content: draft.title });
				return {
					id: draft.id,
					title: draft.title,
					explanation: draft.explanation,
					estimate: draft.estimate,
					progress: transition(draft.base, draft.status, now, waits),
					commit: draft.commit,
					tailRule: draft.tailRule,
				};
			}),
		})),
	);
	return { base: previous, next, operations, changes, explained, completion, completedTasks };
}

export type Plan = { readonly kind: "rejected"; readonly errors: string[] } | ({ readonly kind: "planned" } & Planned);

const CLOSED_ROUND_NEEDS_GOAL =
	"Every item of this list is completed or abandoned, so add starts a new round that does not carry over the finished goal and items: provide goal together with add";

export function planTodo(params: TodoParams, previous: TodoNgState, leafMaxMinutes: number, now: number, waits: readonly AskWait[]): Plan {
	const startsRound = params.add !== undefined && roundOf(previous) === "closed";
	if (startsRound && params.goal === undefined) return { kind: "rejected", errors: [CLOSED_ROUND_NEEDS_GOAL] };
	const base = startsRound ? EMPTY : previous;
	const staged = stageAdds(params, base);
	const errors = validate(params, base, staged, leafMaxMinutes);
	return errors.length > 0 ? { kind: "rejected", errors } : { kind: "planned", ...apply(params, base, staged, now, waits) };
}
