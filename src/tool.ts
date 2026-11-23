import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { TodoPhase as HostTodoPhase, TodoCompletionTransition } from "@oh-my-pi/pi-tui/tools/todo";
import { logger } from "@oh-my-pi/pi-utils";
import { type BranchFacts, branchFacts } from "./branch.ts";
import { commitTodoState, liveState, type TodoSession } from "./commit.ts";
import { commitGuard } from "./commit-guard.ts";
import { currentTimeLine, formatCompactView, formatFullView, formatOpenView, formatPhaseView } from "./format.ts";
import { type AgentRef, type WorktreeScope, worktreeScope } from "./git.ts";
import type { Refusal, TransitionGuard } from "./guard.ts";
import { OPS, type Op, type TodoChange } from "./kernel.ts";
import { planTransition, runGuards } from "./pipeline.ts";
import { DEFAULT_PROJECT, type ProjectConfigState, projectConfigProblem } from "./project-config.ts";
import { hasTodoMutation, parametersSchema, parseTodoParams } from "./protocol.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";
import { type AskWait, hostPhases, phaseSlug, TODO_NG_RESULT_MARK, type TodoNgSnapshot, type TodoNgState, toSnapshot } from "./state.ts";

export const DESCRIPTION =
	"Manage phased todos with goal, per-item time budgets (each at most the leafMaxMinutes setting), and status. Use for work changes (not Q&A). Call todo({}) or todo({ view }) to inspect.";

export const RESULT_OPS = [...OPS, "batch", "view"] as const;
export { parametersSchema };

export type TodoNgDetails = {
	op?: (typeof RESULT_OPS)[number];
	operations?: Op[];
	changes?: TodoChange[];
	phases: HostTodoPhase[];
	storage: "session" | "memory";
	completedTasks?: TodoCompletionTransition[];
	[TODO_NG_RESULT_MARK]: true;
	more: TodoNgSnapshot;
};

export type PreviewOutcome = { readonly kind: "state"; readonly state: TodoNgState } | { readonly kind: "rejected" };

export type PreviewEnv = { readonly leafMaxMinutes: number; readonly project: ProjectConfigState; readonly scope: WorktreeScope };

export function previewTodo(
	facts: Pick<BranchFacts, "waits" | "overtimeWarned">,
	previous: TodoNgState,
	raw: unknown,
	env: PreviewEnv,
): PreviewOutcome {
	const parsed = parseTodoParams(raw);
	if (parsed.kind === "invalid") return { kind: "rejected" };
	if (!hasTodoMutation(parsed.params)) return { kind: "state", state: previous };
	if (env.project.kind === "invalid") return { kind: "rejected" };
	const plan = planTransition(
		parsed.params,
		previous,
		facts,
		{ leafMaxMinutes: env.leafMaxMinutes, project: env.project.config, scope: env.scope },
		Date.now(),
	);
	if (plan.kind === "rejected") return { kind: "rejected" };
	return { kind: "state", state: plan.patches.reduce((state, patch) => patch(state), plan.transition.planned.next) };
}

const storageOf = (session: TodoSession): "session" | "memory" => (session.sessionManager.getSessionFile() ? "session" : "memory");

type ResultExtra = {
	readonly op?: TodoNgDetails["op"];
	readonly operations?: Op[];
	readonly changes?: TodoChange[];
	readonly completedTasks?: TodoCompletionTransition[];
	readonly isError?: true;
};

function result(session: TodoSession, state: TodoNgState, text: string, extra: ResultExtra): AgentToolResult<TodoNgDetails> {
	const details: TodoNgDetails = {
		op: extra.op,
		operations: extra.operations,
		changes: extra.changes,
		phases: hostPhases(state),
		storage: storageOf(session),
		completedTasks: extra.completedTasks?.length ? extra.completedTasks : undefined,
		[TODO_NG_RESULT_MARK]: true,
		more: toSnapshot(state),
	};
	return { content: [{ type: "text", text }], details, isError: extra.isError };
}

function viewText(state: TodoNgState, waits: readonly AskWait[], view: string | undefined, now: number): { text: string; found: boolean } {
	if (view === undefined || view.toLowerCase() === "all") return { text: formatFullView(state, now, waits), found: true };
	if (view.toLowerCase() === "current") return { text: formatOpenView(state, now, waits), found: true };
	if (state.kind === "empty") return { text: `${currentTimeLine(now)}\nTodo list is empty.`, found: false };
	const targetSlug = phaseSlug(view);
	const phase = state.phases.find(
		(candidate) => candidate.name.toLowerCase() === view.toLowerCase() || phaseSlug(candidate.name) === targetSlug,
	);
	if (phase !== undefined) return { text: formatPhaseView(phase, now, waits), found: true };
	const available = state.phases.map((p) => `${JSON.stringify(p.name)} (${phaseSlug(p.name)})`).join(", ");
	return { text: `${currentTimeLine(now)}\nPhase ${JSON.stringify(view)} not found. Available: ${available}`, found: false };
}

function viewTodo(
	session: TodoSession,
	state: TodoNgState,
	waits: readonly AskWait[],
	rawView: string | undefined,
	now: number,
	project: ProjectConfigState,
) {
	const { text, found } = viewText(state, waits, rawView?.trim(), now);
	const notice =
		project.kind === "invalid" ? `\n${projectConfigProblem(project)}. Todo changes are refused until the file is fixed or removed.` : "";
	return result(session, state, `${text}${notice}`, found ? { op: "view" } : { isError: true });
}

export type ParentCwd = () => string | undefined;

export type TodoEnv = {
	readonly leafMaxMinutes: number;
	readonly parentCwd: ParentCwd;
	readonly agent: AgentRef;
	readonly project: ProjectConfigState;
	readonly signal: AbortSignal | undefined;
	readonly host: ExtensionContext | undefined;
	readonly acceptance: readonly TransitionGuard[];
};

const TOP_LEVEL: ParentCwd = () => undefined;
const MAIN_AGENT: AgentRef = { id: MAIN_AGENT_ID, parentId: undefined };

function logRefusal(refusal: Refusal): void {
	logger.warn("todo-ng guard refused a todo change", { guard: refusal.guard, message: refusal.message });
}

export async function runTodo(session: TodoSession, raw: unknown, env: Partial<TodoEnv> = {}): Promise<AgentToolResult<TodoNgDetails>> {
	const leafMaxMinutes = env.leafMaxMinutes ?? DEFAULT_SETTINGS.leafMaxMinutes;
	const project = env.project ?? DEFAULT_PROJECT;
	const facts = branchFacts(session.sessionManager);
	const previous = liveState(session);
	const now = Date.now();
	const waits = facts.waits;
	const refuse = (errors: readonly string[], extra: ResultExtra = {}) =>
		result(session, previous, formatCompactView(previous, now, waits, { errors, readOnly: true }), { ...extra, isError: true });
	const parsed = parseTodoParams(raw);
	if (parsed.kind === "invalid") {
		return result(session, previous, `${currentTimeLine(now)}\n${parsed.message}`, { isError: true });
	}
	if (!hasTodoMutation(parsed.params)) {
		return viewTodo(session, previous, waits, parsed.params.view, now, project);
	}
	if (project.kind === "invalid") {
		return refuse([`${projectConfigProblem(project)}. Fix or remove the file: todo changes are refused until it parses.`]);
	}
	const scope = worktreeScope(session.sessionManager.getCwd(), (env.parentCwd ?? TOP_LEVEL)());
	const plan = planTransition(parsed.params, previous, facts, { leafMaxMinutes, project: project.config, scope }, now);
	if (plan.kind === "rejected") {
		for (const refusal of plan.refusals) logRefusal(refusal);
		return refuse([...plan.errors, ...plan.refusals.map((refusal) => refusal.message)]);
	}
	const { planned } = plan.transition;
	const op: TodoNgDetails["op"] = planned.operations.length === 1 ? planned.operations[0] : "batch";
	const outcome = await runGuards({ ...plan.transition, session, agent: env.agent ?? MAIN_AGENT, signal: env.signal, host: env.host }, [
		...(env.acceptance ?? []),
		commitGuard,
	]);
	if (outcome.kind === "refused") {
		logRefusal(outcome.refusal);
		return refuse([outcome.refusal.message], { op, operations: planned.operations });
	}
	const next = [...plan.patches, ...outcome.patches].reduce((state, patch) => patch(state), planned.next);
	commitTodoState(session, next);
	return result(
		session,
		next,
		formatCompactView(next, now, waits, { notes: [...plan.notes, ...outcome.notes], highlightExplanations: planned.explained }),
		{ op, operations: planned.operations, changes: planned.changes, completedTasks: planned.completedTasks },
	);
}
