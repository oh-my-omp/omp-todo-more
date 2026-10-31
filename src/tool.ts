import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { TodoPhase as HostTodoPhase, TodoCompletionTransition } from "@oh-my-pi/pi-tui/tools/todo";
import { commitTodoState, type TodoSession } from "./commit.ts";
import { commitCompletion, sharedWorktreeRoot, worktreeState } from "./git.ts";
import { participatingModels } from "./models.ts";
import { customFormat, parametersSchema, parseTodo, type TodoCommand, type TodoCommitClause, type TodoTarget } from "./protocol.ts";
import {
	askWaits,
	type CommitRecord,
	commitRecordText,
	commitScopeText,
	type Explanation,
	estimatedMinutesSchema,
	explanationText,
	type GoalState,
	goalLines,
	hostPhases,
	type ItemTime,
	readTodoMore,
	stateOf,
	TODO_MORE_RESULT_MARK,
	type TodoGoal,
	type TodoMoreSnapshot,
	type TodoMoreState,
	type TodoStatus,
	timeEstimateText,
	todoGoalSchema,
	toSnapshot,
	transitionTime,
	unexplainedItems,
} from "./state.ts";

export const DESCRIPTION = `Batch Todo initialization and edits in one document; do not call once per task.

Topics — read the one a call needs before making it:
- \`xd://todo/protocol\` — before writing a Todo document, choosing selectors, or completing tasks with commits
- \`xd://todo/lifecycle\` — before planning work, changing task state, handling blockers, or revising time budgets`;

export const OPS = ["init", "start", "done", "rm", "drop", "block", "unblock", "append", "view", "explain", "estimate", "goal"] as const;
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
	readonly reason?: string;
	readonly explanation?: string;
	readonly estimatedMinutes?: number;
	/** The commit this completion owes, as the document asked for it. */
	readonly commit?: TodoCommitClause;
};

/** Mutable working copy of the list while one call applies. */
type WorkItem = {
	title: string;
	explanation: Explanation;
	time: ItemTime;
	status: TodoStatus;
	commit?: CommitRecord;
	blocker?: string;
};
type WorkPhase = { name: string; items: WorkItem[] };

/** Details of every result: native-compatible fields for the host, plus the marker and the snapshot for todo-more readers. */
export type TodoMoreDetails = {
	op?: (typeof RESULT_OPS)[number];
	operations?: Op[];
	/** Accepted logical operations, in application order; absent on VIEW and rejected calls. */
	changes?: Params[];
	phases: HostTodoPhase[];
	storage: "session" | "memory";
	completedTasks?: TodoCompletionTransition[];
	[TODO_MORE_RESULT_MARK]: true;
	more: TodoMoreSnapshot;
};

const working = (state: TodoMoreState): WorkPhase[] =>
	state.kind === "empty" ? [] : state.phases.map((phase) => ({ name: phase.name, items: phase.items.map((item) => ({ ...item })) }));

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/tools/todo.ts#findTaskByContent
function findTask(phases: WorkPhase[], title: string): { item: WorkItem; phase: WorkPhase } | undefined {
	for (const phase of phases) {
		const item = phase.items.find((candidate) => candidate.title === title);
		if (item) return { item, phase };
	}
	return undefined;
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/tools/todo.ts#getCompletionTransitions
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
// @upstream-end

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/tools/todo.ts#normalizeInProgressTask
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
// @upstream-end

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/tools/todo.ts#resolveTaskOrError
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
// @upstream-end

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/tools/todo.ts#resolvePhaseOrError
function resolvePhase(phases: WorkPhase[], name: string | undefined, errors: string[]): WorkPhase | undefined {
	if (!name) {
		errors.push("Missing phase name");
		return undefined;
	}
	const phase = phases.find((candidate) => candidate.name === name);
	if (!phase) errors.push(`Phase "${name}" not found`);
	return phase;
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/tools/todo.ts#getTaskTargets
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
// @upstream-end

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

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/tools/todo.ts#initPhases
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
// @upstream-end

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/tools/todo.ts#appendItems
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
// @upstream-end

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/tools/todo.ts#removeTasks
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
// @upstream-end

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/tools/todo.ts#applyEntry
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
		case "block": {
			if (!params.task && !params.phase) {
				errors.push("block requires a task or phase target");
				return phases;
			}
			// One line: the note rides on one Markdown checklist line and one HUD/summary line.
			const reason = params.reason?.replace(/\s+/g, " ").trim() || undefined;
			for (const item of targets(phases, params, errors)) {
				if (item.status !== "pending" && item.status !== "in_progress" && item.status !== "blocked") continue;
				item.status = "blocked";
				if (reason === undefined) delete item.blocker;
				else item.blocker = reason;
			}
			return phases;
		}
		case "unblock": {
			if (!params.task && !params.phase) {
				errors.push("unblock requires a task or phase target");
				return phases;
			}
			for (const item of targets(phases, params, errors)) {
				if (item.status !== "blocked") continue;
				item.status = "pending";
				delete item.blocker;
			}
			return phases;
		}
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
// @upstream-end

/** Items introduced by an initialization or append block. */
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
		case "block":
		case "unblock":
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

/** todo-more's rules on top of the native ones. */
function ruleErrors(params: Params, previous: TodoMoreState): string[] {
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
	}
	if (params.op === "explain" && (params.explanation === undefined || params.explanation.trim().length === 0)) {
		errors.push("explain requires a non-empty explanation");
	}
	if (params.op === "estimate" && params.estimatedMinutes === undefined) errors.push("estimate requires estimatedMinutes");
	if (params.op !== "estimate" && params.estimatedMinutes !== undefined) errors.push("estimatedMinutes is only valid on estimate");
	return errors;
}

const isOpen = (status: TodoStatus): boolean => status === "pending" || status === "in_progress";

// @upstream adapted @oh-my-pi/pi-coding-agent@18.10.1 src/tools/todo.ts#formatSummary
function formatSummary(state: TodoMoreState, errors: readonly string[], readOnly: boolean): string {
	const lines: string[] = [];
	if (errors.length > 0) lines.push(`Errors: ${errors.join("; ")}`);
	if (state.kind === "empty") {
		if (errors.length === 0) lines.push(readOnly ? "Todo list is empty." : "Todo list cleared.");
		return lines.join("\n");
	}
	const { phases } = state;
	if (state.goal.kind === "set") lines.push("Goal:", ...goalLines(state.goal.goal).map((line) => `  ${line}`));
	else lines.push("Goal: none yet — put GOAL first in the next Todo document.");
	const remaining = phases.flatMap((phase) =>
		phase.items.filter((item) => isOpen(item.status)).map((item) => ({ item, phase: phase.name })),
	);
	if (remaining.length === 0) {
		lines.push("Remaining items: none.");
	} else {
		lines.push(`Remaining items (${remaining.length}):`);
		for (const { item, phase } of remaining) lines.push(`  - ${item.title} [${item.status}] (${phase})`);
	}
	const items = phases.flatMap((phase) => phase.items);
	const closed = (status: TodoStatus): boolean => status === "completed" || status === "abandoned";
	let currentIndex = phases.findIndex((phase) => phase.items.some((item) => isOpen(item.status)));
	if (currentIndex === -1) currentIndex = phases.length - 1;
	const current = phases[currentIndex];
	const closedAll = items.filter((item) => closed(item.status)).length;
	const blockedAll = items.filter((item) => item.status === "blocked").length;
	const workedAhead = phases.some((phase, index) => index > currentIndex && phase.items.some((item) => closed(item.status)));
	lines.push(`Overall: ${closedAll}/${items.length} done, ${remaining.length} open${blockedAll > 0 ? `, ${blockedAll} blocked` : ""}.`);
	if (current !== undefined) {
		const done = current.items.filter((item) => closed(item.status)).length;
		lines.push(
			`Active phase ${currentIndex + 1}/${phases.length} "${current.name}" (${done}/${current.items.length})${
				workedAhead
					? " — earliest phase with open tasks; the in-progress pointer auto-advances to the earliest open task on each completion, so it can sit behind out-of-order work (nothing was un-completed)."
					: "."
			}`,
		);
	}
	for (const phase of phases) {
		lines.push(`  ${phase.name}:`);
		for (const item of phase.items) {
			const checkbox = item.status === "completed" ? "[X]" : "[ ]";
			const tag =
				item.status === "in_progress"
					? " (in progress)"
					: item.status === "abandoned"
						? " (dropped)"
						: item.status === "blocked"
							? item.blocker
								? ` (blocked: ${item.blocker})`
								: " (blocked)"
							: "";
			lines.push(`    - ${checkbox} ${item.title}${tag}`);
			if (item.commit !== undefined) lines.push(`        Commit: ${commitRecordText(item.commit)} (${commitScopeText(item.commit.scope)})`);
			if (isOpen(item.status) || item.status === "blocked") lines.push(`        ${explanationText(item)}`);
			lines.push(`        ${timeEstimateText(item.time)}`);
		}
	}
	const unexplained = unexplainedItems(state);
	if (unexplained.length > 0) {
		lines.push(
			`Items without an explanation (${unexplained.length}); batch EXPLAIN commands: ${unexplained.map((item) => JSON.stringify(item.title)).join(", ")}`,
		);
	}
	return lines.join("\n");
}
// @upstream-end

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

/** Selectors are explicit: the quoted title "ALL" never means the ALL selector. */
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

/** PHASE scopes additions only; each block is one existing logical append operation. */
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
			case "unblock":
				params.push({ op: command.kind, ...targetParams(command.target) });
				break;
			case "block":
				params.push({ op: "block", ...targetParams(command.target), reason: command.reason });
				break;
			case "view":
				params.push({ op: "view" });
				break;
			default: {
				const unreachable: never = command;
				throw new Error(`Unexpected todo command: ${String(unreachable)}`);
			}
		}
	}
	return { kind: "ok", params };
}

/**
 * The working directory of the agent that spawned the session, read when a
 * completion needs it; `undefined` for a top-level session, or when the parent's
 * registry entry or live session is gone.
 */
export type ParentCwd = () => string | undefined;

const TOP_LEVEL: ParentCwd = () => undefined;

/**
 * The git association: a completion that closes work commits it, and a
 * completion that would leave the checkout dirty is refused. A subagent in
 * its parent's worktree neither commits nor is refused: the parent integrates.
 */
async function completeWithCommit(
	session: TodoSession,
	clause: TodoCommitClause | undefined,
	closed: readonly WorkItem[],
	parentCwd: ParentCwd,
): Promise<{ kind: "ok"; note?: string } | { kind: "refused"; message: string }> {
	const cwd = session.sessionManager.getCwd();
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
		const state = await worktreeState(cwd);
		if (state.kind === "failed") return { kind: "refused", message: state.message };
		if (state.kind !== "dirty") return { kind: "ok" };
		return {
			kind: "refused",
			message: `${named} would leave uncommitted work in ${state.root}: re-issue DONE "title" "<message>" to commit every change, or DONE "title" "<paths>" "<message>" to commit a scope.`,
		};
	}
	const outcome = await commitCompletion(
		cwd,
		clause.scope,
		clause.message,
		participatingModels(session.sessionManager.getBranch(), session.model),
	);
	switch (outcome.kind) {
		case "committed":
			for (const item of closed) item.commit = outcome.commit;
			return {
				kind: "ok",
				note: `Committed ${commitRecordText(outcome.commit)} (${commitScopeText(outcome.commit.scope)}) in ${outcome.root}.`,
			};
		case "inert":
			return {
				kind: "ok",
				note:
					outcome.because === "no-repository"
						? "No git repository here: the commit clause committed nothing."
						: "Nothing to commit: the working tree is clean, so the commit clause committed nothing.",
			};
		case "failed":
			return { kind: "refused", message: outcome.message };
		default: {
			const unreachable: never = outcome;
			throw new Error(`Unexpected commit outcome: ${String(unreachable)}`);
		}
	}
}

/**
 * Complete calls have one acceptance anchor; generated prefixes never reach this state path.
 * `parentCwd` locates the spawning agent's worktree for a subagent's `DONE`.
 */
export async function runTodo(
	session: TodoSession,
	raw: unknown,
	parentCwd: ParentCwd = TOP_LEVEL,
): Promise<AgentToolResult<TodoMoreDetails>> {
	const previous = readTodoMore(session.sessionManager.getBranch());
	const input = parametersSchema.safeParse(raw);
	if (!input.success) return result(session, previous, `Invalid todo arguments: ${input.error.message}`, { isError: true });
	const parsed = parseTodo(input.data.input);
	if (parsed.kind === "invalid") return result(session, previous, parsed.message, { isError: true });
	const batch = operations(parsed.commands);
	if (batch.kind === "invalid") return result(session, previous, batch.message, { isError: true });
	const ops = batch.params.map((params) => params.op);
	const op = ops.length === 1 ? ops[0]! : "batch";
	if (op === "view") return result(session, previous, formatSummary(previous, [], true), { op });

	const before = working(previous);
	let phases = working(previous);
	let next = previous;
	const notes: string[] = [];
	// All internal transitions belong to this one atomic mutation, not separate visible work intervals.
	const now = Date.now();
	// Time spent waiting on the user in `ask` is not work time.
	const waits = askWaits(session.sessionManager.getBranch());
	for (const params of batch.params) {
		const errors = ruleErrors(params, next);
		if (params.op === "goal" && next.kind === "empty") errors.push("GOAL requires a non-empty list; use INIT to create one");
		// Git runs for the items this operation itself completes, before the branch is touched.
		const alreadyCompleted =
			params.op === "done"
				? new Set(
						phases
							.flatMap((phase) => phase.items)
							.filter((item) => item.status === "completed")
							.map((item) => item.title),
					)
				: undefined;
		if (errors.length === 0) phases = applyOp(phases, params, errors);
		if (errors.length > 0) return result(session, previous, formatSummary(previous, errors, true), { op, operations: ops, isError: true });
		if (alreadyCompleted !== undefined) {
			const closed = phases
				.flatMap((phase) => phase.items)
				.filter((item) => item.status === "completed" && !alreadyCompleted.has(item.title));
			if (closed.length > 0) {
				const step = await completeWithCommit(session, params.commit, closed, parentCwd);
				if (step.kind === "refused") {
					return result(session, previous, formatSummary(previous, [step.message], true), { op, operations: ops, isError: true });
				}
				if (step.note !== undefined) notes.push(step.note);
			}
		}
		if (params.op !== "goal") {
			normalizeInProgress(phases);
			for (const phase of phases) {
				for (const item of phase.items) item.time = transitionTime(item.time, item.status, now, waits);
			}
		}
		const goal: GoalState =
			params.goal !== undefined ? { kind: "set", goal: params.goal } : next.kind === "list" ? next.goal : { kind: "missing" };
		next = stateOf(goal, phases);
	}
	const committed = commitTodoState(session, next);
	if (committed.kind === "failed") {
		const current = readTodoMore(session.sessionManager.getBranch());
		return result(session, current, formatSummary(current, [committed.message], true), { op, operations: ops, isError: true });
	}
	const summary = formatSummary(next, [], false);
	return result(session, next, notes.length === 0 ? summary : `${summary}\n${notes.join("\n")}`, {
		op,
		operations: ops,
		changes: batch.params,
		completedTasks: completionTransitions(before, phases),
	});
}
