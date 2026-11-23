import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { TodoPhase as HostTodoPhase, TodoCompletionTransition } from "@oh-my-pi/pi-tui/tools/todo";
import { type BranchFacts, branchFacts } from "./branch.ts";
import { commitTodoState, liveState, type TodoSession } from "./commit.ts";
import { currentTimeLine, formatCompactView, formatFullView, formatOpenView, formatPhaseView } from "./format.ts";
import { type AgentRef, commitCompletion, sharedWorktreeRoot, workState } from "./git.ts";
import { participatingModels } from "./models.ts";
import { commitClauseOf, hasTodoMutation, parametersSchema, parseTodoParams, type TodoCommitClause, type TodoParams } from "./protocol.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";
import {
	type AskWait,
	type CommitRecord,
	commitRecordText,
	commitScopeText,
	type Estimate,
	type Explanation,
	FRESH,
	type GoalState,
	hostPhases,
	idAllocator,
	type Progress,
	phaseSlug,
	stateOf,
	TODO_MORE_RESULT_MARK,
	type TodoGoal,
	type TodoItem,
	type TodoMoreSnapshot,
	type TodoMoreState,
	type TodoStatus,
	toSnapshot,
	transition,
} from "./state.ts";

export const DESCRIPTION =
	"Manage phased todos with goal, per-item time budgets (each at most the leafMaxMinutes setting), and status. Use for work changes (not Q&A). Call todo({}) or todo({ view }) to inspect.";

export const OPS = ["init", "goal", "add", "start", "explain", "estimate", "done", "drop"] as const;
export type Op = (typeof OPS)[number];
export const RESULT_OPS = [...OPS, "batch", "view"] as const;
export { parametersSchema };

export type AddedItem = { readonly id: string; readonly title: string; readonly explanation: string; readonly estimatedMinutes: number };

export type TodoChange =
	| { readonly op: "goal"; readonly goal: TodoGoal }
	| { readonly op: "add"; readonly phase: string; readonly items: readonly AddedItem[] }
	| { readonly op: "start"; readonly id: string; readonly title: string }
	| { readonly op: "explain"; readonly id: string; readonly title: string; readonly explanation: string }
	| { readonly op: "estimate"; readonly id: string; readonly title: string; readonly estimatedMinutes: number }
	| { readonly op: "done"; readonly id: string; readonly title: string; readonly commit: TodoCommitClause | null }
	| { readonly op: "drop"; readonly id: string; readonly title: string };

export type TodoMoreDetails = {
	op?: (typeof RESULT_OPS)[number];
	operations?: Op[];
	changes?: TodoChange[];
	phases: HostTodoPhase[];
	storage: "session" | "memory";
	completedTasks?: TodoCompletionTransition[];
	[TODO_MORE_RESULT_MARK]: true;
	more: TodoMoreSnapshot;
};

type Rules = { readonly leafMaxMinutes: number; readonly overtimeWarned: ReadonlySet<string> };

type Located = { readonly item: TodoItem; readonly phase: string };

function locate(state: TodoMoreState): Map<string, Located> {
	const byId = new Map<string, Located>();
	if (state.kind === "list")
		for (const phase of state.phases) for (const item of phase.items) byId.set(item.id, { item, phase: phase.name });
	return byId;
}

type Staged = Located & { readonly added: AddedItem };

function stageAdds(params: TodoParams, previous: TodoMoreState): Staged[] {
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
			},
			added: { id, title: param.title, explanation: param.detail, estimatedMinutes: param.minutes },
		};
	});
}

const overCap = (title: string, minutes: number, cap: number): string =>
	`Task "${title}" estimate ${minutes} min exceeds the ${cap}-minute limit for one item: split the work into several items of at most ${cap} min each`;

function validate(params: TodoParams, previous: TodoMoreState, staged: readonly Staged[], rules: Rules): string[] {
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
		if (estimatedMinutes > rules.leafMaxMinutes) errors.push(overCap(title, estimatedMinutes, rules.leafMaxMinutes));
	}
	for (const entry of params.explain ?? []) resolve(entry.id);
	for (const entry of params.estimate ?? []) {
		const hit = resolve(entry.id);
		if (entry.minutes > rules.leafMaxMinutes) errors.push(overCap(hit?.item.title ?? entry.id, entry.minutes, rules.leafMaxMinutes));
		const estimate = hit?.item.estimate;
		if (
			hit !== undefined &&
			estimate?.kind === "estimated" &&
			estimate.minutes !== entry.minutes &&
			rules.overtimeWarned.has(estimate.budgetId)
		) {
			errors.push(
				`Task "${hit.item.title}" (${entry.id}) already received an overtime warning, so its ${estimate.minutes}-minute estimate is closed and estimate cannot change it. Find out why it overran, then add the remaining work as new items with add (phase ${JSON.stringify(hit.phase)}), each at most ${rules.leafMaxMinutes} min`,
			);
		}
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
	explanation: Explanation;
	estimate: Estimate;
	status: TodoStatus;
};

type Completion = { readonly id: string; readonly title: string };

type Planned = {
	readonly next: TodoMoreState;
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
		explanation: item.explanation,
		estimate: item.estimate,
		status: item.progress.status,
	};
}

function apply(params: TodoParams, previous: TodoMoreState, staged: readonly Staged[], now: number, waits: readonly AskWait[]): Planned {
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
				};
			}),
		})),
	);
	return { next, operations, changes, explained, completion, completedTasks };
}

type Plan = { readonly kind: "rejected"; readonly errors: string[] } | ({ readonly kind: "planned" } & Planned);

function planTodo(params: TodoParams, previous: TodoMoreState, rules: Rules, now: number, waits: readonly AskWait[]): Plan {
	const staged = stageAdds(params, previous);
	const errors = validate(params, previous, staged, rules);
	return errors.length > 0 ? { kind: "rejected", errors } : { kind: "planned", ...apply(params, previous, staged, now, waits) };
}

export type PreviewOutcome = { readonly kind: "state"; readonly state: TodoMoreState } | { readonly kind: "rejected" };

export function previewTodo(
	facts: Pick<BranchFacts, "waits" | "overtimeWarned">,
	previous: TodoMoreState,
	raw: unknown,
	leafMaxMinutes: number,
): PreviewOutcome {
	const parsed = parseTodoParams(raw);
	if (parsed.kind === "invalid") return { kind: "rejected" };
	if (!hasTodoMutation(parsed.params)) return { kind: "state", state: previous };
	const plan = planTodo(parsed.params, previous, { leafMaxMinutes, overtimeWarned: facts.overtimeWarned }, Date.now(), facts.waits);
	return plan.kind === "rejected" ? { kind: "rejected" } : { kind: "state", state: plan.next };
}

const storageOf = (session: TodoSession): "session" | "memory" => (session.sessionManager.getSessionFile() ? "session" : "memory");

type ResultExtra = {
	readonly op?: TodoMoreDetails["op"];
	readonly operations?: Op[];
	readonly changes?: TodoChange[];
	readonly completedTasks?: TodoCompletionTransition[];
	readonly isError?: true;
};

function result(session: TodoSession, state: TodoMoreState, text: string, extra: ResultExtra): AgentToolResult<TodoMoreDetails> {
	const details: TodoMoreDetails = {
		op: extra.op,
		operations: extra.operations,
		changes: extra.changes,
		phases: hostPhases(state),
		storage: storageOf(session),
		completedTasks: extra.completedTasks?.length ? extra.completedTasks : undefined,
		[TODO_MORE_RESULT_MARK]: true,
		more: toSnapshot(state),
	};
	return { content: [{ type: "text", text }], details, isError: extra.isError };
}

function viewTodo(session: TodoSession, state: TodoMoreState, waits: readonly AskWait[], rawView: string | undefined, now: number) {
	const view = rawView?.trim();
	if (view === undefined || view.toLowerCase() === "all") {
		return result(session, state, formatFullView(state, now, waits), { op: "view" });
	}
	if (view.toLowerCase() === "current") {
		return result(session, state, formatOpenView(state, now, waits), { op: "view" });
	}
	if (state.kind === "empty") {
		return result(session, state, `${currentTimeLine(now)}\nTodo list is empty.`, { isError: true });
	}
	const targetSlug = phaseSlug(view);
	const phase = state.phases.find(
		(candidate) => candidate.name.toLowerCase() === view.toLowerCase() || phaseSlug(candidate.name) === targetSlug,
	);
	if (phase === undefined) {
		const available = state.phases.map((p) => `${JSON.stringify(p.name)} (${phaseSlug(p.name)})`).join(", ");
		return result(session, state, `${currentTimeLine(now)}\nPhase ${JSON.stringify(view)} not found. Available: ${available}`, {
			isError: true,
		});
	}
	return result(session, state, formatPhaseView(phase, now, waits), { op: "view" });
}

export type ParentCwd = () => string | undefined;

const TOP_LEVEL: ParentCwd = () => undefined;
const MAIN_AGENT: AgentRef = { id: MAIN_AGENT_ID, parentId: undefined };

type CompletionStep =
	| { readonly kind: "passed"; readonly note: string | null }
	| { readonly kind: "committed"; readonly commit: CommitRecord; readonly note: string }
	| { readonly kind: "refused"; readonly message: string };

const INERT_NOTES = {
	"no-repository": "No git repository here: the commit committed nothing.",
	clean: "Nothing to commit: the working tree is clean, so the commit committed nothing.",
	foreign: "Nothing to commit: none of the uncommitted changes are this agent's, so the commit committed nothing.",
} as const;

async function completeWithCommit(
	session: TodoSession,
	clause: TodoCommitClause | null,
	completed: Completion,
	parentCwd: ParentCwd,
	agent: AgentRef,
): Promise<CompletionStep> {
	const cwd = session.sessionManager.getCwd();
	const artifactsDir = session.sessionManager.getArtifactsDir();
	const parent = parentCwd();
	const shared = parent === undefined ? null : sharedWorktreeRoot(cwd, parent);
	if (shared !== null) {
		return {
			kind: "passed",
			note: `Shared worktree with the parent agent (${shared}): this completion committed nothing; the parent agent integrates and commits these changes.`,
		};
	}
	const named = `Task ${JSON.stringify(completed.title)} (${completed.id})`;
	if (clause === null) {
		const state = await workState(cwd, artifactsDir, agent);
		switch (state.kind) {
			case "failed":
				return { kind: "refused", message: state.message };
			case "no-repository":
			case "clean":
			case "foreign":
				return { kind: "passed", note: null };
			case "own":
				return {
					kind: "refused",
					message: `${named} would leave this agent's uncommitted work in ${state.root}: call todo again with commit ({ message }) to commit this agent's changes, or with commit.paths to commit a scope.`,
				};
			case "unattributed":
				return {
					kind: "refused",
					message: `${named} would leave uncommitted work in ${state.root}, and this session keeps no change record to tell whose it is: call todo again with commit ({ message, paths }) to commit named paths.`,
				};
			default: {
				const unreachable: never = state;
				throw new Error(`Unexpected work state: ${String(unreachable)}`);
			}
		}
	}
	const outcome = await commitCompletion(
		cwd,
		artifactsDir,
		agent,
		clause.scope,
		clause.message,
		participatingModels(branchFacts(session.sessionManager), session.model),
	);
	switch (outcome.kind) {
		case "committed":
			return {
				kind: "committed",
				commit: outcome.commit,
				note: `Committed ${commitRecordText(outcome.commit)} (${commitScopeText(outcome.commit.scope)}) in ${outcome.root}.`,
			};
		case "inert":
			return { kind: "passed", note: INERT_NOTES[outcome.because] };
		case "failed":
			return { kind: "refused", message: outcome.message };
		default: {
			const unreachable: never = outcome;
			throw new Error(`Unexpected commit outcome: ${String(unreachable)}`);
		}
	}
}

function withCommit(state: TodoMoreState, id: string, commit: CommitRecord): TodoMoreState {
	if (state.kind === "empty") return state;
	return {
		...state,
		phases: state.phases.map((phase) => ({
			...phase,
			items: phase.items.map((item) => (item.id === id ? { ...item, commit } : item)),
		})),
	};
}

export async function runTodo(
	session: TodoSession,
	raw: unknown,
	leafMaxMinutes: number = DEFAULT_SETTINGS.leafMaxMinutes,
	parentCwd: ParentCwd = TOP_LEVEL,
	agent: AgentRef = MAIN_AGENT,
): Promise<AgentToolResult<TodoMoreDetails>> {
	const facts = branchFacts(session.sessionManager);
	const previous = liveState(session);
	const now = Date.now();
	const waits = facts.waits;
	const parsed = parseTodoParams(raw);
	if (parsed.kind === "invalid") {
		return result(session, previous, `${currentTimeLine(now)}\n${parsed.message}`, { isError: true });
	}
	if (!hasTodoMutation(parsed.params)) {
		return viewTodo(session, previous, waits, parsed.params.view, now);
	}
	const plan = planTodo(parsed.params, previous, { leafMaxMinutes, overtimeWarned: facts.overtimeWarned }, now, waits);
	if (plan.kind === "rejected") {
		return result(session, previous, formatCompactView(previous, now, waits, { errors: plan.errors, readOnly: true }), {
			isError: true,
		});
	}
	const op: TodoMoreDetails["op"] = plan.operations.length === 1 ? plan.operations[0] : "batch";
	const notes: string[] = [];
	let next = plan.next;
	if (plan.completion !== null) {
		const clause = parsed.params.commit === undefined ? null : commitClauseOf(parsed.params.commit);
		const step = await completeWithCommit(session, clause, plan.completion, parentCwd, agent);
		switch (step.kind) {
			case "refused":
				return result(session, previous, formatCompactView(previous, now, waits, { errors: [step.message], readOnly: true }), {
					op,
					operations: plan.operations,
					isError: true,
				});
			case "committed":
				next = withCommit(next, plan.completion.id, step.commit);
				notes.push(step.note);
				break;
			case "passed":
				if (step.note !== null) notes.push(step.note);
				break;
			default: {
				const unreachable: never = step;
				throw new Error(`Unexpected completion step: ${String(unreachable)}`);
			}
		}
	}
	commitTodoState(session, next);
	return result(session, next, formatCompactView(next, now, waits, { notes, highlightExplanations: plan.explained }), {
		op,
		operations: plan.operations,
		changes: plan.changes,
		completedTasks: plan.completedTasks,
	});
}
