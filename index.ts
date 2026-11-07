/**
 * todo-more: OMP's todo with a goal, explanations, time budgets and commits,
 * running on top of the native todo (`todo.enabled` stays on). Built on the native implementation:
 * the tool, its reminders and its rendering are copies of OMP code, adapted to
 * a list that carries a goal ({objective, measure, doneWhen}) and items that
 * carry a title, explanation and model-estimated time budget. Copied code is marked
 * `// @upstream <verbatim|adapted> …` … `// @upstream-end` (see
 * `src/state.ts`).
 *
 * The registered `todo` shadows the built-in tool of the same name. The native
 * stop reminder, mid-run nudge and eager prelude are switched off for the
 * process with runtime (never persisted) overrides of `todo.reminders` and
 * `todo.eager`; reminders.ts runs its own, configured by this plugin's
 * settings (`reminders`, `remindersMax`, `eager`). Native goal mode's todo
 * snapshot is replaced in the request by todo-more's richer one.
 *
 * Registers the tool `todo` (tool.ts, rendered by render.ts) and the hooks of
 * reminders.ts (stop reminder, mid-run nudge, eager prelude, goal-mode
 * context), plus `before_agent_start` to keep the tool in editing subagents.
 * A completion commits the work it closes (src/git.ts) through the host's git
 * bindings: `DONE` carries the commit clause, a checkout with uncommitted work
 * refuses a completion without one, and each committed item keeps the sha. A
 * subagent whose working tree is its parent's (the parent's live session,
 * found through the registry by `ctx.agent.parentId`) commits nothing and is
 * never refused: the parent integrates that worktree.
 *
 * Also registers `ctx` (src/ctx/index.ts): the read-only context tool and its
 * post-compaction hint. src/ctx/tasklog.ts appends each successful `todo` / `goal`
 * change to the task log, which `ctx` replays into the work record.
 *
 * planning.ts wraps the registered `edit` execution so an empty list blocks
 * it (installed on session_start, before_agent_start and edit tool_call), and
 * appends a complete plan-check reminder to each real user message (`context`,
 * request-only; agent-attributed and synthetic messages are excluded).
 * Adds rich native tool descriptions, a live native progress widget, the
 * session-bound `/todo-more` editor, and synchronous `omp-todo-more:read` review
 * requests. The factory registers tools, hooks and UI synchronously, awaits Tern owner-CLI asset initialization, then subscribes the review API.
 *
 * State: the session branch is the authority (`src/state.ts` records,
 * folded by `src/branch.ts`): each changing mutation appends a full snapshot entry
 * `mouriya.omp.todo-more`; host writers that bypass the tool (`/todo`, RPC
 * `set_todos`, finished-subagent auto-complete) append `user_todo_edit`, which the reader
 * joins by title, marking new titles as lacking an explanation. Every mutation
 * also pushes the host projection (title as content, status, blocker) into the
 * session's TodoTracker, and the result details carry the same projection, so
 * the host HUD, `/todo`, branch rehydration and eval persistence keep working.
 *
 * OMP drops `todo` from subagents that are not prewalk-armed: the executor
 * strips it at spawn and filters it out of every extension-driven active-tool
 * change (`task/executor.ts`, `isParentOwnedTool`), so another plugin's later
 * `setActiveTools` (a per-turn sync) drops it again. The first
 * `before_agent_start` of a subagent session hooks the session's agent
 * (`addBeforeModelCallHook`): before each model call, a session whose enabled
 * tools include `edit` but not `todo` gets the tool back: the registered `todo`
 * is re-activated with the whole set in canonical order (builtins in registry
 * order, then the rest sorted), the order other plugins write and a forked or
 * rebuilt session computes; or, in a
 * tool-restricted session whose registry holds no extension tools, installed
 * as a host tool. Each session owns its own list.
 *
 * Reads the agent registry, the session branch and this plugin's settings;
 * writes session entries, the TodoTracker projection and runtime overrides of
 * the native todo automation settings. No config files. Hook failures are
 * logged and never reach omp.
 */
import type { AgentTool, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { AgentSession, ExtensionAPI, ExtensionContext, ToolDefinition, ToolInfo } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { registerCtx } from "./src/ctx/index.ts";
import { registerCtxTasklog } from "./src/ctx/tasklog.ts";
import { errorText } from "./src/errors.ts";
import { tr } from "./src/i18n.ts";
import { describeTodoCall, describeTodoResult } from "./src/native.ts";
import { registerOvertime } from "./src/overtime.ts";
import { registerPlanning } from "./src/planning.ts";
import { registerReminders } from "./src/reminders.ts";
import { renderTodoCall, renderTodoResult } from "./src/render.ts";
import { registerReviewApi } from "./src/review-api.ts";
import { sessionOf } from "./src/session.ts";
import { initializeTernPlugin } from "./src/tern-plugin-install.ts";
import { customFormat, DESCRIPTION, type ParentCwd, parametersSchema, runTodo, type TodoMoreDetails } from "./src/tool.ts";
import { todoDocTopics } from "./src/topics.ts";
import { registerUi } from "./src/ui.ts";

const TOOL_NAME = "todo";

/** Fields shared by the registered tool and the host-tool install, matching the native tool's. */
const TOOL_FIELDS = {
	name: TOOL_NAME,
	summary: "Write a structured todo list with a goal to track progress within a session",
	description: DESCRIPTION,
	parameters: parametersSchema,
	docTopics: todoDocTopics,
	customFormat,
	approval: "read" as const,
	loadMode: "discoverable" as const,
	strict: true,
	// The host proxies extension fields, including edit-style customFormat, unchanged.
	// Serialize complete batches; partial arguments are display-only intent.
	concurrency: "exclusive" as const,
	// The result card replaces the call card once a result exists: the streaming
	// preview is a pending-only view, never a second body above the same list.
	mergeCallAndResult: true,
	describeCall: describeTodoCall,
	describeResult: describeTodoResult,
	renderCall: renderTodoCall,
	renderResult: renderTodoResult,
};

/** The AgentSession this extension instance serves, through the registry entry of its agent id. */
const ownSession = (ctx: ExtensionContext): AgentSession | undefined => sessionOf(ctx.agent.id);

/** The spawning agent's live session cwd, looked up at each call; absent for a top-level session or a released parent. */
const parentCwdOf =
	(ctx: ExtensionContext): ParentCwd =>
	() => {
		const parentId = ctx.agent.parentId;
		return parentId === undefined ? undefined : AgentRegistry.global().get(parentId)?.session?.sessionManager.getCwd();
	};

/**
 * The canonical active-tool order the oh-my-omp plugins share: requested builtins first in
 * registry order, then every other name sorted by code point. A pure function of the set, so a
 * forked or rebuilt session lists the same tools in the same order and keeps the prompt cache.
 */
function canonicalToolOrder(all: readonly ToolInfo[], names: Iterable<string>): string[] {
	const requested = new Set(names);
	const builtins = [
		...new Set(all.filter((tool) => tool.sourceInfo.source === "builtin" && requested.has(tool.name)).map((tool) => tool.name)),
	];
	const builtinSet = new Set(builtins);
	const others = [...requested].filter((name) => !builtinSet.has(name)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	return [...builtins, ...others];
}

/** Editing subagent: put back the `todo` the host stripped, so its edit precondition stays satisfiable. */
async function restoreTodo(session: AgentSession, ctx: ExtensionContext): Promise<void> {
	const enabled = session.getEnabledToolNames();
	if (!enabled.includes("edit") || enabled.includes(TOOL_NAME)) return;
	if (session.getAllToolNames().includes(TOOL_NAME)) {
		// Direct on the session: the executor's filter strips `todo` from extension-driven changes.
		// Canonical order: the order the other plugins write, so a forked or rebuilt session matches.
		await session.setActiveToolsByName(canonicalToolOrder(session.getAllToolInfos(), [...enabled, TOOL_NAME]));
		return;
	}
	const hostTool = {
		...TOOL_FIELDS,
		get label(): string {
			return tr("Todo", "待办");
		},
		execute: async (_toolCallId: string, params: unknown) => runTodo(session, params, parentCwdOf(ctx)),
	};
	// The host registry erases each tool's parameter schema; the tool validates its input itself.
	await session.refreshRpcHostTools([hostTool as unknown as AgentTool]);
}

/** Subagent sessions whose agent already runs `restoreTodo` before each model call. */
const guardedSessions = new WeakSet<AgentSession>();

/**
 * Hooks `restoreTodo` in front of every model call of a subagent session, once per session.
 * Any later extension `setActiveTools` (another plugin's per-turn sync) passes the executor's
 * filter and drops `todo` again; the hook puts it back before the request reads the tools.
 */
function guardSubagent(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (ctx.agent.kind !== "sub") return;
	const session = ownSession(ctx);
	if (session === undefined || guardedSessions.has(session)) return;
	guardedSessions.add(session);
	session.agent.addBeforeModelCallHook(async () => {
		try {
			await restoreTodo(session, ctx);
		} catch (error) {
			pi.logger.warn("todo-more could not install todo", { error: errorText(error) });
		}
	});
}

/** The registered `todo` tool: shared fields, native describe hooks, ANSI renderers and the merge flag. */
export const TODO_TOOL_DEFINITION = {
	...TOOL_FIELDS,
	get label(): string {
		return tr("Todo", "待办");
	},
	execute: async (
		_toolCallId: string,
		params: unknown,
		_signal: AbortSignal | undefined,
		_onUpdate: AgentToolUpdateCallback<TodoMoreDetails> | undefined,
		ctx: ExtensionContext,
	) => {
		const session = ownSession(ctx);
		if (session === undefined) throw new Error(`todo: no session registered for agent ${ctx.agent.id}`);
		return runTodo(session, params, parentCwdOf(ctx));
	},
} satisfies ToolDefinition<typeof parametersSchema, TodoMoreDetails> & { docTopics(): Readonly<Record<string, string>> };

export default async function todoMore(pi: ExtensionAPI): Promise<void> {
	pi.registerTool(TODO_TOOL_DEFINITION);

	pi.on("before_agent_start", (_event, ctx) => {
		try {
			guardSubagent(pi, ctx);
		} catch (error) {
			pi.logger.warn("todo-more could not guard todo", { error: errorText(error) });
		}
	});

	registerReminders(pi);
	registerOvertime(pi);
	registerPlanning(pi);
	registerUi(pi);
	registerCtx(pi);
	registerCtxTasklog(pi);
	await initializeTernPlugin();
	// Subscribed after the Tern await: a factory rejected by Tern initialization never reaches this line, so its event-bus listener cannot outlive the dropped plugin.
	registerReviewApi(pi);
}
