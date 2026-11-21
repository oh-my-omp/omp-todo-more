import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { TodoPhase as HostTodoPhase, TodoCompletionTransition } from "@oh-my-pi/pi-tui/tools/todo";
import { type BranchFacts, branchFacts } from "./branch.ts";
import { commitTodoState, liveState, type TodoSession } from "./commit.ts";
import { currentTimeLine, formatCompactView, formatFullView, formatItemView, formatOpenView, formatPhaseView } from "./format.ts";
import { type AgentRef, commitCompletion, sharedWorktreeRoot, workState } from "./git.ts";
import { participatingModels } from "./models.ts";
import { customFormat, parametersSchema, parseTodo, type TodoCommand, type TodoCommitClause, type TodoTarget } from "./protocol.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";
import {
	type CommitRecord,
	commitRecordText,
	commitScopeText,
	type Explanation,
	estimatedMinutesSchema,
	type GoalState,
	hostPhases,
	type ItemTime,
	type ItemTimestamps,
	stateOf,
	TODO_MORE_RESULT_MARK,
	type TodoGoal,
	type TodoMoreSnapshot,
	type TodoMoreState,
	type TodoStatus,
	todoGoalSchema,
	toSnapshot,
	transitionTime,
	transitionTimestamps,
} from "./state.ts";

export const DESCRIPTION = `Batch Todo initialization and edits in one document; do not call once per task.

Any error rejects the whole document. The call fails unless:
- Commands sit between \`*** Begin Todo\` and \`*** End Todo\`, one uppercase command per line, with JSON-quoted string arguments.
- An empty list starts with INIT "objective" "measure" "doneWhen", followed by at least one ADD; INIT is first and appears once.
- Every ADD is ADD "title" "explanation" <positive integer minutes>; outside INIT an ADD needs a preceding PHASE "name".
- No ADD or ESTIMATE gives one item more than the per-item limit (the leafMaxMinutes setting, 60 minutes by default); split longer work into several items.
- ESTIMATE cannot change the estimate of an item that already received an overtime warning; add its remaining work as new items with PHASE and ADD.
- Status commands target an existing "title" or PHASE "name", matched exactly (DONE, DROP and RM also take ALL); never use IDs or guess a title.
- VIEW is the only command in its document: VIEW (all open items), VIEW ALL (full list incl. closed and commits), VIEW PHASE "name", or VIEW "title".
- In a git checkout where this agent has uncommitted work, DONE carries a commit clause — DONE "title" "<message>" to commit this agent's changes or DONE "title" "<paths>" "<message>" to commit those paths — and the tool runs git commit itself.

Topics — read the one a call needs before making it:
- \`help://todo/protocol\` — before writing a Todo document, choosing selectors, or completing tasks with commits
- \`help://todo/lifecycle\` — before planning work, changing task state, or revising time budgets`;

export const OPS = ["init", "start", "done", "rm", "drop", "append", "view", "explain", "estimate", "goal"] as const;
export type Op = (typeof OPS)[number];
export const RESULT_OPS = [...OPS, "batch"] as const;
export { customFormat, parametersSchema };

type ItemParam = { title: string; explanation: string; estimatedMinutes: number };
type Params = {
	readonly op: Op;
	readonly goal?: TodoGoal;
	readonly list?: { phase: string; items: ItemParam[] }[];
	readonly task?: string;
	readonly phase?: string;
	readonly items?: ItemParam[];
	readonly explanation?: string;
	readonly estimatedMinutes?: number;
	readonly commit?: TodoCommitClause;
	readonly viewTarget?: TodoTarget;
};

type WorkItem = {
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
	changes?: Params[];
	phases: HostTodoPhase[];
	storage: "session" | "memory";
	completedTasks?: TodoCompletionTransition[];
	[TODO_MORE_RESULT_MARK]: true;
	more: TodoMoreSnapshot;
};

const working = (state: TodoMoreState): WorkPhase[] =>
	state.kind === "empty" ? [] : state.phases.map((phase) => ({ name: phase.name, items: phase.items.map((item) => ({ ...item })) }));

function findTask(phases: WorkPhase[], title: string): { item: WorkItem; phase: WorkPhase } | undefined {
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

function resolveTask(phases: WorkPhase[], title: string | undefined, errors: string[]): { item: WorkItem; phase: WorkPhase } | undefined {
	if (!title) {
		errors.push("Missing task content");
		return undefined;
	}
	const hit = findTask(phases, title);
	if (!hit) {
		if (/^task-\d+$/.test(title)) {
			errors.push(
				`Task "${title}" not found. Tasks are referenced by title, not by IDs — pass the task's full title from the previous result.`,
			);
		} else {
			const total = phases.reduce((sum, phase) => sum + phase.items.length, 0);
			const hint = total === 0 ? " (todo list is empty — was it replaced or not yet created?)" : "";
			errors.push(`Task "${title}" not found${hint}`);
		}
	}
	return hit;
}

function resolvePhase(phases: WorkPhase[], name: string | undefined, errors: string[]): WorkPhase | undefined {
	if (!name) {
		errors.push("Missing phase name");
		return undefined;
	}
	const phase = phases.find((candidate) => candidate.name === name);
	if (!phase) errors.push(`Phase "${name}" not found`);
	return phase;
}

function targets(phases: WorkPhase[], params: Params, errors: string[]): WorkItem[] {
	if (params.task) {
		const hit = resolveTask(phases, params.task, errors);
		return hit ? [hit.item] : [];
	}
	if (params.phase) {
		const phase = resolvePhase(phases, params.phase, errors);
		return phase ? [...phase.items] : [];
	}
	return phases.flatMap((phase) => phase.items);
}

const explained = (item: ItemParam): WorkItem => ({
	title: item.title,
	explanation: { kind: "explained", text: item.explanation },
	time: {
		kind: "estimated",
		budgetId: crypto.randomUUID(),
		minutes: item.estimatedMinutes,
		elapsedMs: 0,
		runningSince: null,
	},
	status: "pending",
});

function initPhases(params: Params, errors: string[]): WorkPhase[] {
	const list = params.list;
	if (!list) {
		errors.push("Missing list for init operation");
		return [];
	}
	const seenPhases = new Set<string>();
	const seenTasks = new Set<string>();
	for (const entry of list) {
		if (seenPhases.has(entry.phase)) errors.push(`Duplicate phase "${entry.phase}" in init list`);
		seenPhases.add(entry.phase);
		for (const item of entry.items) {
			if (seenTasks.has(item.title)) errors.push(`Duplicate task "${item.title}" in init list`);
			seenTasks.add(item.title);
		}
	}
	return list.map((entry) => ({ name: entry.phase, items: entry.items.map(explained) }));
}

function appendItems(phases: WorkPhase[], params: Params, errors: string[]): WorkPhase[] {
	if (!params.phase) {
		errors.push("Missing phase name for append operation");
		return phases;
	}
	if (!params.items || params.items.length === 0) {
		errors.push("Missing items for append operation");
		return phases;
	}
	const seen = new Set<string>();
	let duplicate = false;
	for (const item of params.items) {
		if (seen.has(item.title) || findTask(phases, item.title)) {
			errors.push(`Task "${item.title}" already exists`);
			duplicate = true;
		}
		seen.add(item.title);
	}
	if (duplicate) return phases;
	let phase = phases.find((candidate) => candidate.name === params.phase);
	if (!phase) {
		phase = { name: params.phase, items: [] };
		phases.push(phase);
	}
	phase.items.push(...params.items.map(explained));
	return phases;
}

function removeTasks(phases: WorkPhase[], params: Params, errors: string[]): WorkPhase[] {
	if (params.task) {
		const hit = resolveTask(phases, params.task, errors);
		if (hit) hit.phase.items = hit.phase.items.filter((candidate) => candidate !== hit.item);
		return phases;
	}
	if (params.phase) {
		const phase = resolvePhase(phases, params.phase, errors);
		if (phase) phase.items = [];
		return phases;
	}
	for (const phase of phases) phase.items = [];
	return phases;
}

function applyOp(phases: WorkPhase[], params: Params, errors: string[]): WorkPhase[] {
	switch (params.op) {
		case "init":
			return initPhases(params, errors);
		case "start": {
			const hit = resolveTask(phases, params.task, errors);
			if (!hit) return phases;
			for (const phase of phases) {
				for (const item of phase.items) if (item.status === "in_progress" && item !== hit.item) item.status = "pending";
			}
			hit.item.status = "in_progress";
			return phases;
		}
		case "done":
			for (const item of targets(phases, params, errors)) item.status = "completed";
			return phases;
		case "drop":
			for (const item of targets(phases, params, errors)) item.status = "abandoned";
			return phases;
		case "rm":
			return removeTasks(phases, params, errors);
		case "append":
			return appendItems(phases, params, errors);
		case "explain": {
			const hit = resolveTask(phases, params.task, errors);
			if (hit && params.explanation !== undefined) hit.item.explanation = { kind: "explained", text: params.explanation };
			return phases;
		}
		case "estimate": {
			const hit = resolveTask(phases, params.task, errors);
			if (!hit || params.estimatedMinutes === undefined) return phases;
			const time = hit.item.time;
			if (time.kind === "estimated" && time.minutes === params.estimatedMinutes) return phases;
			hit.item.time = {
				kind: "estimated",
				budgetId: crypto.randomUUID(),
				minutes: params.estimatedMinutes,
				elapsedMs: time.kind === "estimated" ? time.elapsedMs : 0,
				runningSince: time.kind === "estimated" ? time.runningSince : null,
			};
			return phases;
		}
		case "view":
		case "goal":
			return phases;
		default: {
			const unreachable: never = params.op;
			throw new Error(`Unexpected todo operation: ${String(unreachable)}`);
		}
	}
}

function addedItems(params: Params): ItemParam[] {
	switch (params.op) {
		case "init":
			return params.list?.flatMap((phase) => phase.items) ?? [];
		case "append":
			return params.items ?? [];
		case "start":
		case "done":
		case "rm":
		case "drop":
		case "view":
		case "explain":
		case "estimate":
		case "goal":
			return [];
		default: {
			const unreachable: never = params.op;
			throw new Error(`Unexpected todo operation: ${String(unreachable)}`);
		}
	}
}

type BudgetRules = { readonly leafMaxMinutes: number; readonly overtimeWarned: ReadonlySet<string> };

const overCap = (title: string, minutes: number, cap: number): string =>
	`Task "${title}" estimate ${minutes} min exceeds the ${cap}-minute limit for one item: split the work into several items of at most ${cap} min each`;

function ruleErrors(params: Params, previous: TodoMoreState, rules: BudgetRules): string[] {
	const errors: string[] = [];
	const hasGoal = previous.kind === "list" && previous.goal.kind === "set";
	if (params.op !== "view" && params.goal === undefined && !hasGoal) {
		errors.push(
			previous.kind === "empty" ? "Todo list is empty: use INIT to create it" : "The list has no goal: put GOAL before other mutations",
		);
	}
	if (params.goal !== undefined && !todoGoalSchema.safeParse(params.goal).success) {
		errors.push("goal objective, measure and doneWhen must not be empty");
	}
	for (const item of addedItems(params)) {
		if (item.title.trim().length === 0 || item.explanation.trim().length === 0) {
			errors.push(`Task "${item.title}" needs a non-empty title and explanation`);
		}
		if (!estimatedMinutesSchema.safeParse(item.estimatedMinutes).success)
			errors.push(`Task "${item.title}" needs a positive integer estimate`);
		else if (item.estimatedMinutes > rules.leafMaxMinutes) errors.push(overCap(item.title, item.estimatedMinutes, rules.leafMaxMinutes));
	}
	if (params.op === "explain" && (params.explanation === undefined || params.explanation.trim().length === 0)) {
		errors.push("explain requires a non-empty explanation");
	}
	if (params.op === "estimate" && params.estimatedMinutes === undefined) errors.push("estimate requires estimatedMinutes");
	if (params.op === "estimate" && params.estimatedMinutes !== undefined && params.task !== undefined) {
		if (params.estimatedMinutes > rules.leafMaxMinutes) errors.push(overCap(params.task, params.estimatedMinutes, rules.leafMaxMinutes));
		const phase =
			previous.kind === "list"
				? previous.phases.find((candidate) => candidate.items.some((item) => item.title === params.task))
				: undefined;
		const time = phase?.items.find((item) => item.title === params.task)?.time;
		if (
			phase !== undefined &&
			time?.kind === "estimated" &&
			time.minutes !== params.estimatedMinutes &&
			rules.overtimeWarned.has(time.budgetId)
		) {
			errors.push(
				`Task "${params.task}" already received an overtime warning, so its ${time.minutes}-minute estimate is closed and ESTIMATE cannot change it. Find out why it overran, then add the remaining work as new items with PHASE ${JSON.stringify(phase.name)} and ADD, each at most ${rules.leafMaxMinutes} min`,
			);
		}
	}
	if (params.op !== "estimate" && params.estimatedMinutes !== undefined) errors.push("estimatedMinutes is only valid on estimate");
	return errors;
}

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

function pruneRemovedPrior(prior: Map<string, PriorItem>, phases: readonly WorkPhase[]): void {
	const alive = new Set<string>();
	for (const phase of phases) {
		for (const item of phase.items) alive.add(`${phase.name}\u0000${item.title}`);
	}
	for (const key of prior.keys()) {
		if (!alive.has(key)) prior.delete(key);
	}
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

function formatView(
	state: TodoMoreState,
	target: TodoTarget | undefined,
	now: number,
	waits: BranchFacts["waits"],
): { readonly kind: "ok"; readonly text: string } | { readonly kind: "error"; readonly text: string } {
	if (target === undefined) return { kind: "ok", text: formatOpenView(state, now, waits) };
	switch (target.kind) {
		case "all":
			return { kind: "ok", text: formatFullView(state, now, waits) };
		case "phase": {
			const phase = state.kind === "list" ? state.phases.find((candidate) => candidate.name === target.name) : undefined;
			if (phase === undefined) {
				return {
					kind: "error",
					text: formatCompactView(state, now, waits, { errors: [`Phase "${target.name}" not found`], readOnly: true }),
				};
			}
			return { kind: "ok", text: formatPhaseView(phase, now, waits) };
		}
		case "task": {
			const phases = working(state);
			const errors: string[] = [];
			const hit = resolveTask(phases, target.title, errors);
			if (hit === undefined) {
				return { kind: "error", text: formatCompactView(state, now, waits, { errors, readOnly: true }) };
			}
			return { kind: "ok", text: formatItemView(hit.phase.name, hit.item, now, waits) };
		}
		default: {
			const unreachable: never = target;
			throw new Error(`Unexpected view target: ${String(unreachable)}`);
		}
	}
}

const storageOf = (session: TodoSession): "session" | "memory" => (session.sessionManager.getSessionFile() ? "session" : "memory");

function result(
	session: TodoSession,
	state: TodoMoreState,
	text: string,
	extra: { op?: TodoMoreDetails["op"]; operations?: Op[]; changes?: Params[]; completedTasks?: TodoCompletionTransition[]; isError?: true },
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

function targetParams(target: TodoTarget): Pick<Params, "task" | "phase"> {
	switch (target.kind) {
		case "task":
			return { task: target.title };
		case "phase":
			return { phase: target.name };
		case "all":
			return {};
	}
}

type Operations = { kind: "ok"; params: Params[] } | { kind: "invalid"; message: string };

function operations(commands: TodoCommand[]): Operations {
	const params: Params[] = [];
	for (let index = 0; index < commands.length; index++) {
		const command = commands[index]!;
		switch (command.kind) {
			case "init": {
				const list: NonNullable<Params["list"]> = [];
				let phase: (typeof list)[number] | undefined;
				while (index + 1 < commands.length) {
					const next = commands[index + 1]!;
					if (next.kind === "phase") {
						if (phase && phase.items.length === 0) return { kind: "invalid", message: `PHASE "${phase.phase}" needs ADD` };
						phase = { phase: next.name, items: [] };
						list.push(phase);
					} else if (next.kind === "add") {
						if (!phase) {
							phase = { phase: "Tasks", items: [] };
							list.push(phase);
						}
						phase.items.push({ title: next.title, explanation: next.explanation, estimatedMinutes: next.estimatedMinutes });
					} else break;
					index++;
				}
				if (phase && phase.items.length === 0) return { kind: "invalid", message: `PHASE "${phase.phase}" needs ADD` };
				if (list.length === 0) return { kind: "invalid", message: "INIT needs at least one ADD" };
				params.push({ op: "init", goal: command.goal, list });
				break;
			}
			case "phase": {
				const items: ItemParam[] = [];
				while (commands[index + 1]?.kind === "add") {
					const next = commands[++index]!;
					if (next.kind === "add")
						items.push({ title: next.title, explanation: next.explanation, estimatedMinutes: next.estimatedMinutes });
				}
				if (items.length === 0) return { kind: "invalid", message: `PHASE "${command.name}" needs ADD` };
				params.push({ op: "append", phase: command.name, items });
				break;
			}
			case "add":
				return { kind: "invalid", message: "ADD outside INIT requires a PHASE block" };
			case "goal":
				params.push({ op: "goal", goal: command.goal });
				break;
			case "start":
				params.push({ op: "start", task: command.title });
				break;
			case "explain":
				params.push({ op: "explain", task: command.title, explanation: command.explanation });
				break;
			case "estimate":
				params.push({ op: "estimate", task: command.title, estimatedMinutes: command.estimatedMinutes });
				break;
			case "done":
				params.push({
					op: "done",
					...targetParams(command.target),
					...(command.commit === undefined ? {} : { commit: command.commit }),
				});
				break;
			case "drop":
			case "rm":
				params.push({ op: command.kind, ...targetParams(command.target) });
				break;
			case "view":
				params.push({ op: "view", ...(command.target === undefined ? {} : { viewTarget: command.target }) });
				break;
			default: {
				const unreachable: never = command;
				throw new Error(`Unexpected todo command: ${String(unreachable)}`);
			}
		}
	}
	return { kind: "ok", params };
}

function batchOf(raw: unknown): Operations {
	const input = parametersSchema.safeParse(raw);
	if (!input.success) return { kind: "invalid", message: `Invalid todo arguments: ${input.error.message}` };
	const parsed = parseTodo(input.data.input);
	if (parsed.kind === "invalid") return { kind: "invalid", message: parsed.message };
	return operations(parsed.commands);
}

type Step = { kind: "rejected"; errors: string[] } | { kind: "applied"; phases: WorkPhase[] };

/** The rule checks and the operation itself for one command of a batch; `phases` is edited in place. */
function applyStep(phases: WorkPhase[], next: TodoMoreState, params: Params, rules: BudgetRules): Step {
	const errors = ruleErrors(params, next, rules);
	if (params.op === "goal" && next.kind === "empty") errors.push("GOAL requires a non-empty list; use INIT to create one");
	const applied = errors.length === 0 ? applyOp(phases, params, errors) : phases;
	return errors.length > 0 ? { kind: "rejected", errors } : { kind: "applied", phases: applied };
}

/** The state a batch has reached once `params` has been applied to `phases`. */
function settleStep(phases: WorkPhase[], next: TodoMoreState, params: Params, waits: BranchFacts["waits"], now: number): TodoMoreState {
	if (params.op !== "goal") {
		normalizeInProgress(phases);
		for (const phase of phases) {
			for (const item of phase.items) item.time = transitionTime(item.time, item.status, now, waits);
		}
	}
	const goal: GoalState =
		params.goal !== undefined ? { kind: "set", goal: params.goal } : next.kind === "list" ? next.goal : { kind: "missing" };
	return stateOf(goal, phases);
}

export type TodoPreview = { kind: "state"; state: TodoMoreState } | { kind: "rejected" };

/**
 * The state `raw` would leave behind `previous`, from the parse and rule checks `runTodo` runs and without executing its effects.
 * `rejected` means `batchOf` or `applyStep` fails, so `runTodo` fails too. `state` does not promise that `runTodo` succeeds: the preview
 * does not model `completeWithCommit` (a `DONE` that closes an item is refused while this agent has uncommitted work, or the session
 * keeps no change record to tell, and the `DONE` carries no commit clause, or when its commit fails): that refusal leaves the list as it was.
 */
export function previewTodo(
	facts: Pick<BranchFacts, "waits" | "overtimeWarned">,
	previous: TodoMoreState,
	raw: unknown,
	leafMaxMinutes: number,
): TodoPreview {
	const batch = batchOf(raw);
	if (batch.kind === "invalid") return { kind: "rejected" };
	if (batch.params.length === 1 && batch.params[0]!.op === "view") return { kind: "state", state: previous };
	const rules: BudgetRules = { leafMaxMinutes, overtimeWarned: facts.overtimeWarned };
	const now = Date.now();
	let phases = working(previous);
	const prior = priorItems(phases);
	let next = previous;
	for (const params of batch.params) {
		const applied = applyStep(phases, next, params, rules);
		if (applied.kind === "rejected") return { kind: "rejected" };
		phases = applied.phases;
		if (params.op === "init") prior.clear();
		else if (params.op === "rm") pruneRemovedPrior(prior, phases);
		next = settleStep(phases, next, params, facts.waits, now);
	}
	stampTransitions(phases, prior, now);
	return { kind: "state", state: stateOf(next.kind === "list" ? next.goal : { kind: "missing" }, phases) };
}

export type ParentCwd = () => string | undefined;

const TOP_LEVEL: ParentCwd = () => undefined;
const MAIN_AGENT: AgentRef = { id: MAIN_AGENT_ID, parentId: undefined };

async function completeWithCommit(
	session: TodoSession,
	clause: TodoCommitClause | undefined,
	closed: readonly WorkItem[],
	parentCwd: ParentCwd,
	agent: AgentRef,
): Promise<{ kind: "ok"; note?: string } | { kind: "refused"; message: string }> {
	const cwd = session.sessionManager.getCwd();
	const artifactsDir = session.sessionManager.getArtifactsDir();
	const parent = parentCwd();
	const shared = parent === undefined ? null : sharedWorktreeRoot(cwd, parent);
	if (shared !== null) {
		return {
			kind: "ok",
			note: `Shared worktree with the parent agent (${shared}): this DONE committed nothing; the parent agent integrates and commits these changes.`,
		};
	}
	const named = closed.length === 1 ? `Task ${JSON.stringify(closed[0]!.title)}` : `${closed.length} completed tasks`;
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
					message: `${named} would leave this agent's uncommitted work in ${state.root}: re-issue DONE "title" "<message>" to commit this agent's changes, or DONE "title" "<paths>" "<message>" to commit a scope.`,
				};
			case "unattributed":
				return {
					kind: "refused",
					message: `${named} would leave uncommitted work in ${state.root}, and this session keeps no change record to tell whose it is: re-issue DONE "title" "<paths>" "<message>" to commit named paths.`,
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
			for (const item of closed) item.commit = outcome.commit;
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

const INERT_NOTES = {
	"no-repository": "No git repository here: the commit clause committed nothing.",
	clean: "Nothing to commit: the working tree is clean, so the commit clause committed nothing.",
	foreign: "Nothing to commit: none of the uncommitted changes are this agent's, so the commit clause committed nothing.",
} as const;

export async function runTodo(
	session: TodoSession,
	raw: unknown,
	parentCwd: ParentCwd = TOP_LEVEL,
	leafMaxMinutes: number = DEFAULT_SETTINGS.leafMaxMinutes,
	agent: AgentRef = MAIN_AGENT,
): Promise<AgentToolResult<TodoMoreDetails>> {
	const facts = branchFacts(session.sessionManager);
	const previous = liveState(session);
	const now = Date.now();
	const waits = facts.waits;
	const batch = batchOf(raw);
	if (batch.kind === "invalid") {
		return result(session, previous, `${currentTimeLine(now)}\n${batch.message}`, { isError: true });
	}
	const ops = batch.params.map((params) => params.op);
	const op = ops.length === 1 ? ops[0]! : "batch";
	if (op === "view") {
		const view = formatView(previous, batch.params[0]?.viewTarget, now, waits);
		return result(session, previous, view.text, view.kind === "error" ? { op, isError: true } : { op });
	}

	const before = working(previous);
	const prior = priorItems(before);
	let phases = working(previous);
	let next = previous;
	const notes: string[] = [];
	const rules: BudgetRules = { leafMaxMinutes, overtimeWarned: facts.overtimeWarned };
	// Every step is checked and applied before any DONE commits: a later rejected step must not leave a commit behind.
	const completions: { clause: TodoCommitClause | undefined; closed: WorkItem[] }[] = [];
	const explainedTitles = new Set<string>();
	for (const params of batch.params) {
		const alreadyCompleted =
			params.op === "done"
				? new Set(
						phases
							.flatMap((phase) => phase.items)
							.filter((item) => item.status === "completed")
							.map((item) => item.title),
					)
				: undefined;
		const applied = applyStep(phases, next, params, rules);
		if (applied.kind === "rejected") {
			return result(session, previous, formatCompactView(previous, now, waits, { errors: applied.errors, readOnly: true }), {
				op,
				operations: ops,
				isError: true,
			});
		}
		phases = applied.phases;
		if (params.op === "init") prior.clear();
		else if (params.op === "rm") pruneRemovedPrior(prior, phases);
		if (params.op === "explain" && params.task !== undefined) explainedTitles.add(params.task);
		if (alreadyCompleted !== undefined) {
			const closed = phases
				.flatMap((phase) => phase.items)
				.filter((item) => item.status === "completed" && !alreadyCompleted.has(item.title));
			if (closed.length > 0) completions.push({ clause: params.commit, closed });
		}
		next = settleStep(phases, next, params, waits, now);
	}
	stampTransitions(phases, prior, now);
	next = stateOf(next.kind === "list" ? next.goal : { kind: "missing" }, phases);
	for (const completion of completions) {
		const step = await completeWithCommit(session, completion.clause, completion.closed, parentCwd, agent);
		if (step.kind === "refused") {
			return result(session, previous, formatCompactView(previous, now, waits, { errors: [step.message], readOnly: true }), {
				op,
				operations: ops,
				isError: true,
			});
		}
		if (step.note !== undefined) notes.push(step.note);
	}
	commitTodoState(session, next);
	const summary = formatCompactView(next, now, waits, {
		notes,
		...(explainedTitles.size > 0 ? { highlightExplanations: explainedTitles } : {}),
	});
	return result(session, next, summary, {
		op,
		operations: ops,
		changes: batch.params,
		completedTasks: completionTransitions(before, phases),
	});
}
