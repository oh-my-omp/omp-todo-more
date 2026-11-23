import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { TodoPhase as HostTodoPhase, TodoCompletionTransition } from "@oh-my-pi/pi-tui/tools/todo";
import { type BranchFacts, branchFacts } from "./branch.ts";
import { commitTodoState, liveState, type TodoSession } from "./commit.ts";
import { currentTimeLine, formatCompactView, formatFullView, formatOpenView, formatPhaseView } from "./format.ts";
import { type AgentRef, commitCompletion, sharedWorktreeRoot, workState } from "./git.ts";
import { participatingModels } from "./models.ts";
import {
	type AddItemParam,
	commitClauseOf,
	hasTodoMutation,
	parametersSchema,
	parseTodoParams,
	type TodoCommitClause,
	type TodoParams,
} from "./protocol.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";
import {
	type CommitRecord,
	commitRecordText,
	commitScopeText,
	type Explanation,
	type GoalState,
	hostPhases,
	type ItemTime,
	type ItemTimestamps,
	itemDisplayIds,
	phaseSlug,
	stateOf,
	TODO_MORE_RESULT_MARK,
	type TodoGoal,
	type TodoMoreSnapshot,
	type TodoMoreState,
	type TodoStatus,
	toSnapshot,
	transitionTime,
	transitionTimestamps,
} from "./state.ts";

export const DESCRIPTION =
	"Manage phased todos with goal, time budgets (<=60m/item), and status. Use for work changes (not Q&A). Call todo({}) or todo({ view }) to inspect.";

export const OPS = ["init", "goal", "add", "start", "explain", "estimate", "done", "drop"] as const;
export type Op = (typeof OPS)[number];
export const RESULT_OPS = [...OPS, "batch", "view"] as const;
export { parametersSchema };

export type TodoChange =
	| { readonly op: "goal"; readonly goal: TodoGoal }
	| {
			readonly op: "add";
			readonly phase: string;
			readonly items: { id: string; title: string; explanation: string; estimatedMinutes: number }[];
	  }
	| { readonly op: "start"; readonly id: string; readonly title: string }
	| { readonly op: "explain"; readonly id: string; readonly title: string; readonly explanation: string }
	| { readonly op: "estimate"; readonly id: string; readonly title: string; readonly estimatedMinutes: number }
	| { readonly op: "done"; readonly id: string; readonly title: string; readonly commit?: TodoCommitClause }
	| { readonly op: "drop"; readonly id: string; readonly title: string };

type WorkItem = {
	id: string;
	title: string;
	explanation: Explanation;
	time: ItemTime;
	timestamps?: ItemTimestamps;
	status: TodoStatus;
	commit?: CommitRecord;
};
type WorkPhase = { name: string; items: WorkItem[] };

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

function working(state: TodoMoreState): { phases: WorkPhase[]; allocateId: () => string } {
	if (state.kind === "empty") {
		let seq = 0;
		return { phases: [], allocateId: () => `t${++seq}` };
	}
	const ids = itemDisplayIds(state.phases);
	const used = new Set<string>();
	let maxNum = 0;
	const phases: WorkPhase[] = state.phases.map((phase) => ({
		name: phase.name,
		items: phase.items.map((item) => {
			const id = ids.get(item) ?? `t${++maxNum}`;
			used.add(id);
			const match = /^t(\d+)$/.exec(id);
			if (match?.[1] !== undefined) maxNum = Math.max(maxNum, Number(match[1]));
			return { ...item, id };
		}),
	}));
	const allocateId = (): string => {
		let candidate: string;
		do {
			candidate = `t${++maxNum}`;
		} while (used.has(candidate));
		used.add(candidate);
		return candidate;
	};
	return { phases, allocateId };
}

function findTaskById(phases: WorkPhase[], id: string): { item: WorkItem; phase: WorkPhase } | undefined {
	for (const phase of phases) {
		const item = phase.items.find((candidate) => candidate.id === id);
		if (item) return { item, phase };
	}
	return undefined;
}

function findTaskByTitle(phases: WorkPhase[], title: string): { item: WorkItem; phase: WorkPhase } | undefined {
	for (const phase of phases) {
		const item = phase.items.find((candidate) => candidate.title === title);
		if (item) return { item, phase };
	}
	return undefined;
}

function completionTransitions(previous: WorkPhase[], updated: WorkPhase[]): TodoCompletionTransition[] {
	const previousStatuses = new Map<string, TodoStatus>();
	for (const phase of previous) {
		for (const item of phase.items) previousStatuses.set(`${phase.name}\u0000${item.title}`, item.status);
	}
	const transitions: TodoCompletionTransition[] = [];
	for (const phase of updated) {
		for (const item of phase.items) {
			if (item.status !== "completed") continue;
			const previousStatus = previousStatuses.get(`${phase.name}\u0000${item.title}`);
			if (previousStatus && previousStatus !== "completed") transitions.push({ phase: phase.name, content: item.title });
		}
	}
	return transitions;
}

function normalizeInProgress(phases: WorkPhase[]): void {
	const ordered = phases.flatMap((phase) => phase.items);
	if (ordered.length === 0) return;
	const inProgress = ordered.filter((item) => item.status === "in_progress");
	if (inProgress.length > 1) {
		for (const item of inProgress.slice(1)) item.status = "pending";
	}
	if (inProgress.length > 0) return;
	const firstPending = ordered.find((item) => item.status === "pending");
	if (firstPending) firstPending.status = "in_progress";
}

type BudgetRules = { readonly leafMaxMinutes: number; readonly overtimeWarned: ReadonlySet<string> };

const overCap = (title: string, minutes: number, cap: number): string =>
	`Task "${title}" estimate ${minutes} min exceeds the ${cap}-minute limit for one item: split the work into several items of at most ${cap} min each`;

function resolveId(phases: WorkPhase[], id: string, errors: string[]): { item: WorkItem; phase: WorkPhase } | undefined {
	const hit = findTaskById(phases, id);
	if (!hit) errors.push(`Task ID "${id}" not found`);
	return hit;
}

const storageOf = (session: TodoSession): "session" | "memory" => (session.sessionManager.getSessionFile() ? "session" : "memory");

type PriorItem = { readonly status: TodoStatus; readonly runningSince: number | null };

function priorItems(phases: readonly WorkPhase[]): Map<string, PriorItem> {
	const map = new Map<string, PriorItem>();
	for (const phase of phases) {
		for (const item of phase.items) {
			map.set(`${phase.name}\u0000${item.title}`, {
				status: item.status,
				runningSince: item.time.kind === "estimated" ? item.time.runningSince : null,
			});
		}
	}
	return map;
}

function stampTransitions(phases: WorkPhase[], prior: ReadonlyMap<string, PriorItem>, now: number): void {
	for (const phase of phases) {
		for (const item of phase.items) {
			const prev = prior.get(`${phase.name}\u0000${item.title}`);
			const fallbackStartedAt = prev?.status === "in_progress" ? (prev.runningSince ?? undefined) : undefined;
			const nextTimestamps = transitionTimestamps(prev?.status, item.status, item.timestamps, now, fallbackStartedAt);
			if (nextTimestamps !== undefined) item.timestamps = nextTimestamps;
		}
	}
}

function result(
	session: TodoSession,
	state: TodoMoreState,
	text: string,
	extra: {
		op?: TodoMoreDetails["op"];
		operations?: Op[];
		changes?: TodoChange[];
		completedTasks?: TodoCompletionTransition[];
		isError?: true;
	},
): AgentToolResult<TodoMoreDetails> {
	const details: TodoMoreDetails = {
		phases: hostPhases(state),
		storage: storageOf(session),
		[TODO_MORE_RESULT_MARK]: true,
		more: toSnapshot(state),
	};
	if (extra.op !== undefined) details.op = extra.op;
	if (extra.completedTasks !== undefined && extra.completedTasks.length > 0) details.completedTasks = extra.completedTasks;
	if (extra.operations !== undefined) details.operations = extra.operations;
	if (extra.changes !== undefined) details.changes = extra.changes;
	return extra.isError ? { content: [{ type: "text", text }], details, isError: true } : { content: [{ type: "text", text }], details };
}

function newWorkItem(id: string, item: AddItemParam): WorkItem {
	return {
		id,
		title: item.title,
		explanation: { kind: "explained", text: item.detail },
		time: {
			kind: "estimated",
			budgetId: crypto.randomUUID(),
			minutes: item.minutes,
			elapsedMs: 0,
			runningSince: null,
		},
		status: "pending",
	};
}

function validateAndApply(
	params: TodoParams,
	previous: TodoMoreState,
	phases: WorkPhase[],
	allocateId: () => string,
	rules: BudgetRules,
	waits: BranchFacts["waits"],
	now: number,
):
	| { readonly kind: "rejected"; readonly errors: string[] }
	| {
			readonly kind: "ok";
			readonly state: TodoMoreState;
			readonly operations: Op[];
			readonly changes: TodoChange[];
			readonly explainedTitles: Set<string>;
			readonly completed: WorkItem | undefined;
	  } {
	const errors: string[] = [];
	const wasEmpty = previous.kind === "empty";
	const hasGoal = previous.kind === "list" && previous.goal.kind === "set";
	if (params.goal === undefined && !hasGoal) {
		errors.push(
			wasEmpty ? "Todo list is empty: provide goal and add to create it" : "The list has no goal: provide goal before other mutations",
		);
	}
	if (wasEmpty && (params.add === undefined || params.add.length === 0)) {
		errors.push("Todo list is empty: provide at least one item in add");
	}

	const operations: Op[] = [];
	const changes: TodoChange[] = [];
	const explainedTitles = new Set<string>();

	let goalState: GoalState = previous.kind === "list" ? previous.goal : { kind: "missing" };
	if (params.goal !== undefined) {
		const goal: TodoGoal = {
			objective: params.goal.title,
			measure: params.goal.summary,
			doneWhen: params.goal.acceptance,
		};
		goalState = { kind: "set", goal };
		operations.push(wasEmpty ? "init" : "goal");
		changes.push({ op: "goal", goal });
	}

	if (params.add !== undefined && params.add.length > 0) {
		const seenTitles = new Set<string>();
		const addedByPhase = new Map<string, { id: string; title: string; explanation: string; estimatedMinutes: number }[]>();
		for (const item of params.add) {
			if (seenTitles.has(item.title) || findTaskByTitle(phases, item.title)) {
				errors.push(`Task "${item.title}" already exists`);
			}
			seenTitles.add(item.title);
			if (item.minutes > rules.leafMaxMinutes) errors.push(overCap(item.title, item.minutes, rules.leafMaxMinutes));
			const phaseName = item.phase?.trim() || "Tasks";
			let phase = phases.find((candidate) => candidate.name === phaseName);
			if (!phase) {
				phase = { name: phaseName, items: [] };
				phases.push(phase);
			}
			const id = allocateId();
			phase.items.push(newWorkItem(id, item));
			const group = addedByPhase.get(phaseName) ?? [];
			group.push({ id, title: item.title, explanation: item.detail, estimatedMinutes: item.minutes });
			addedByPhase.set(phaseName, group);
		}
		if (!wasEmpty) operations.push("add");
		for (const [phase, items] of addedByPhase) {
			changes.push({ op: "add", phase, items });
		}
	}

	if (params.explain !== undefined && params.explain.length > 0) {
		operations.push("explain");
		for (const entry of params.explain) {
			const hit = resolveId(phases, entry.id, errors);
			if (hit) {
				hit.item.explanation = { kind: "explained", text: entry.note };
				explainedTitles.add(hit.item.title);
				changes.push({ op: "explain", id: hit.item.id, title: hit.item.title, explanation: entry.note });
			}
		}
	}

	if (params.estimate !== undefined && params.estimate.length > 0) {
		operations.push("estimate");
		for (const entry of params.estimate) {
			const hit = resolveId(phases, entry.id, errors);
			if (entry.minutes > rules.leafMaxMinutes) {
				errors.push(overCap(hit?.item.title ?? entry.id, entry.minutes, rules.leafMaxMinutes));
			}
			if (
				hit !== undefined &&
				hit.item.time.kind === "estimated" &&
				hit.item.time.minutes !== entry.minutes &&
				rules.overtimeWarned.has(hit.item.time.budgetId)
			) {
				errors.push(
					`Task "${hit.item.title}" (${entry.id}) already received an overtime warning, so its ${hit.item.time.minutes}-minute estimate is closed and estimate cannot change it. Find out why it overran, then add the remaining work as new items with add (phase ${JSON.stringify(hit.phase.name)}), each at most ${rules.leafMaxMinutes} min`,
				);
			}
			if (hit) {
				const time = hit.item.time;
				if (time.kind !== "estimated" || time.minutes !== entry.minutes) {
					hit.item.time = {
						kind: "estimated",
						budgetId: crypto.randomUUID(),
						minutes: entry.minutes,
						elapsedMs: time.kind === "estimated" ? time.elapsedMs : 0,
						runningSince: time.kind === "estimated" ? time.runningSince : null,
					};
				}
				changes.push({ op: "estimate", id: hit.item.id, title: hit.item.title, estimatedMinutes: entry.minutes });
			}
		}
	}

	const dropSet = new Set(params.drop_ids ?? []);

	let completed: WorkItem | undefined;
	if (params.done_id !== undefined) {
		operations.push("done");
		const hit = resolveId(phases, params.done_id, errors);
		if (hit) {
			if (hit.item.status !== "completed") completed = hit.item;
			else if (params.commit !== undefined) {
				errors.push(`Task "${hit.item.title}" (${params.done_id}) is already completed, so no completion owes this commit`);
			}
			hit.item.status = "completed";
			const commit = params.commit === undefined ? undefined : commitClauseOf(params.commit);
			changes.push({ op: "done", id: hit.item.id, title: hit.item.title, ...(commit === undefined ? {} : { commit }) });
		}
	}

	if (params.drop_ids !== undefined && params.drop_ids.length > 0) {
		operations.push("drop");
		for (const id of params.drop_ids) {
			if (id === params.done_id) errors.push(`Task ID "${id}" cannot be both done_id and in drop_ids`);
			const hit = resolveId(phases, id, errors);
			if (hit) {
				hit.item.status = "abandoned";
				changes.push({ op: "drop", id: hit.item.id, title: hit.item.title });
			}
		}
	}

	if (params.start_id !== undefined) {
		operations.push("start");
		const hit = resolveId(phases, params.start_id, errors);
		if (params.start_id === params.done_id || dropSet.has(params.start_id)) {
			errors.push(`Task ID "${params.start_id}" cannot be started and closed in the same call`);
		}
		if (hit) {
			for (const phase of phases) {
				for (const item of phase.items) {
					if (item.status === "in_progress" && item !== hit.item) item.status = "pending";
				}
			}
			hit.item.status = "in_progress";
			changes.push({ op: "start", id: hit.item.id, title: hit.item.title });
		}
	}

	if (errors.length > 0) return { kind: "rejected", errors };

	const goalOnly = operations.length === 1 && operations[0] === "goal";
	if (!goalOnly) {
		normalizeInProgress(phases);
		for (const phase of phases) {
			for (const item of phase.items) item.time = transitionTime(item.time, item.status, now, waits);
		}
	}

	return { kind: "ok", state: stateOf(goalState, phases), operations, changes, explainedTitles, completed };
}

export type TodoPreview = { kind: "state"; state: TodoMoreState } | { kind: "rejected" };

export function previewTodo(
	facts: Pick<BranchFacts, "waits" | "overtimeWarned">,
	previous: TodoMoreState,
	raw: unknown,
	leafMaxMinutes: number,
): TodoPreview {
	const parsed = parseTodoParams(raw);
	if (parsed.kind === "invalid") return { kind: "rejected" };
	if (!hasTodoMutation(parsed.params)) return { kind: "state", state: previous };
	const { phases, allocateId } = working(previous);
	const prior = priorItems(phases);
	const rules: BudgetRules = { leafMaxMinutes, overtimeWarned: facts.overtimeWarned };
	const now = Date.now();
	const applied = validateAndApply(parsed.params, previous, phases, allocateId, rules, facts.waits, now);
	if (applied.kind === "rejected") return { kind: "rejected" };
	if (previous.kind === "empty") prior.clear();
	stampTransitions(phases, prior, now);
	return { kind: "state", state: stateOf(applied.state.kind === "list" ? applied.state.goal : { kind: "missing" }, phases) };
}

function viewTodo(session: TodoSession, state: TodoMoreState, waits: BranchFacts["waits"], rawView: string | undefined, now: number) {
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
	return result(session, state, formatPhaseView(phase, now, waits, itemDisplayIds(state.phases)), { op: "view" });
}

export type ParentCwd = () => string | undefined;

const TOP_LEVEL: ParentCwd = () => undefined;
const MAIN_AGENT: AgentRef = { id: MAIN_AGENT_ID, parentId: undefined };

type CompletionStep = { readonly kind: "ok"; readonly note?: string } | { readonly kind: "refused"; readonly message: string };

const INERT_NOTES = {
	"no-repository": "No git repository here: the commit committed nothing.",
	clean: "Nothing to commit: the working tree is clean, so the commit committed nothing.",
	foreign: "Nothing to commit: none of the uncommitted changes are this agent's, so the commit committed nothing.",
} as const;

async function completeWithCommit(
	session: TodoSession,
	clause: TodoCommitClause | undefined,
	completed: WorkItem,
	parentCwd: ParentCwd,
	agent: AgentRef,
): Promise<CompletionStep> {
	const cwd = session.sessionManager.getCwd();
	const artifactsDir = session.sessionManager.getArtifactsDir();
	const parent = parentCwd();
	const shared = parent === undefined ? null : sharedWorktreeRoot(cwd, parent);
	if (shared !== null) {
		return {
			kind: "ok",
			note: `Shared worktree with the parent agent (${shared}): this completion committed nothing; the parent agent integrates and commits these changes.`,
		};
	}
	const named = `Task ${JSON.stringify(completed.title)} (${completed.id})`;
	if (clause === undefined) {
		const state = await workState(cwd, artifactsDir, agent);
		switch (state.kind) {
			case "failed":
				return { kind: "refused", message: state.message };
			case "no-repository":
			case "clean":
			case "foreign":
				return { kind: "ok" };
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
			completed.commit = outcome.commit;
			return {
				kind: "ok",
				note: `Committed ${commitRecordText(outcome.commit)} (${commitScopeText(outcome.commit.scope)}) in ${outcome.root}.`,
			};
		case "inert":
			return { kind: "ok", note: INERT_NOTES[outcome.because] };
		case "failed":
			return { kind: "refused", message: outcome.message };
		default: {
			const unreachable: never = outcome;
			throw new Error(`Unexpected commit outcome: ${String(unreachable)}`);
		}
	}
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
	const before = working(previous).phases;
	const prior = priorItems(before);
	const { phases, allocateId } = working(previous);
	const rules: BudgetRules = { leafMaxMinutes, overtimeWarned: facts.overtimeWarned };
	const applied = validateAndApply(parsed.params, previous, phases, allocateId, rules, waits, now);
	if (applied.kind === "rejected") {
		return result(session, previous, formatCompactView(previous, now, waits, { errors: applied.errors, readOnly: true }), {
			isError: true,
		});
	}
	if (previous.kind === "empty") prior.clear();
	stampTransitions(phases, prior, now);
	const op: TodoMoreDetails["op"] = applied.operations.length === 1 ? applied.operations[0] : "batch";
	const notes: string[] = [];
	if (applied.completed !== undefined) {
		const clause = parsed.params.commit === undefined ? undefined : commitClauseOf(parsed.params.commit);
		const step = await completeWithCommit(session, clause, applied.completed, parentCwd, agent);
		if (step.kind === "refused") {
			return result(session, previous, formatCompactView(previous, now, waits, { errors: [step.message], readOnly: true }), {
				op,
				operations: applied.operations,
				isError: true,
			});
		}
		if (step.note !== undefined) notes.push(step.note);
	}
	const next = stateOf(applied.state.kind === "list" ? applied.state.goal : { kind: "missing" }, phases);
	commitTodoState(session, next);
	const summary = formatCompactView(next, now, waits, {
		notes,
		...(applied.explainedTitles.size > 0 ? { highlightExplanations: applied.explainedTitles } : {}),
	});
	return result(session, next, summary, {
		op,
		operations: applied.operations,
		changes: applied.changes,
		completedTasks: completionTransitions(before, phases),
	});
}
