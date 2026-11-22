import type { AgentTool, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { AgentSession, ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import type { ToolRenderer } from "@oh-my-pi/pi-tui/tools/renderer";
import { logger } from "@oh-my-pi/pi-utils";
import { canonicalToolOrder } from "./omomp-shared/active-tools.ts";
import { tr } from "./omomp-shared/i18n.ts";
import { registerInternalScheme } from "./omomp-shared/internal-url.ts";
import { errorText } from "./src/errors.ts";
import { describeTodoCall, describeTodoResult } from "./src/native.ts";
import { registerOvertime } from "./src/overtime.ts";
import { registerPlanning } from "./src/planning.ts";
import { registerReminders } from "./src/reminders.ts";
import { renderTodoCall, renderTodoResult } from "./src/render.ts";
import { registerReviewApi } from "./src/review-api.ts";
import { sessionOf } from "./src/session.ts";
import { readSettings } from "./src/settings.ts";
import { initializeTernPlugin } from "./src/tern-plugin-install.ts";
import { todoScheme } from "./src/todo-scheme.ts";
import { DESCRIPTION, parametersSchema, runTodo, type TodoMoreDetails } from "./src/tool.ts";
import { registerUi } from "./src/ui.ts";

const TOOL_NAME = "todo";

const TOOL_FIELDS = {
	name: TOOL_NAME,
	summary: "Write a structured todo list with a goal to track progress within a session",
	description: DESCRIPTION,
	parameters: parametersSchema,
	approval: "read" as const,
	loadMode: "essential" as const,
	concurrency: "exclusive" as const,
	mergeCallAndResult: true,
	describeCall: describeTodoCall,
	describeResult: describeTodoResult,
	renderCall: renderTodoCall,
	renderResult: renderTodoResult,
};

const ownSession = (ctx: ExtensionContext): AgentSession | undefined => sessionOf(ctx.agent.id);

async function executeTodo(session: AgentSession, params: unknown, ctx: ExtensionContext) {
	const settings = await readSettings({ logger }, ctx);
	return runTodo(session, params, settings.leafMaxMinutes);
}

async function restoreTodo(session: AgentSession, ctx: ExtensionContext): Promise<void> {
	const enabled = session.getEnabledToolNames();
	if (!enabled.includes("edit") || enabled.includes(TOOL_NAME)) return;
	if (session.getAllToolNames().includes(TOOL_NAME)) {
		await session.setActiveToolsByName(canonicalToolOrder(session.getAllToolInfos(), [...enabled, TOOL_NAME]));
		return;
	}
	const hostTool = {
		...TOOL_FIELDS,
		get label(): string {
			return tr("Todo", "待办");
		},
		execute: async (_toolCallId: string, params: unknown) => executeTodo(session, params, ctx),
	} satisfies AgentTool<typeof parametersSchema, TodoMoreDetails, Theme> & ToolRenderer;
	// refreshRpcHostTools' AgentTool[] parameter cannot express a Theme-typed renderCall in strict variance; the satisfies above pins the real shape.
	await session.refreshRpcHostTools([hostTool as AgentTool]);
}

const guardedSessions = new WeakSet<AgentSession>();

function guardSubagent(ctx: ExtensionContext): void {
	if (ctx.agent.kind !== "sub") return;
	const session = ownSession(ctx);
	if (session === undefined || guardedSessions.has(session)) return;
	guardedSessions.add(session);
	session.agent.addBeforeModelCallHook(async () => {
		try {
			await restoreTodo(session, ctx);
		} catch (error) {
			logger.warn("todo-more could not install todo", { error: errorText(error) });
		}
	});
}

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
		return executeTodo(session, params, ctx);
	},
} satisfies ToolDefinition<typeof parametersSchema, TodoMoreDetails>;

function registerScheme(pi: ExtensionAPI): void {
	const result = registerInternalScheme(InternalUrlRouter.instance(), "omp-todo-more", todoScheme);
	switch (result.kind) {
		case "registered":
			return;
		case "builtin":
		case "held":
			pi.logger.warn(`omp-todo-more: ${result.reason}`);
			return;
		default: {
			const unreachable: never = result;
			throw new Error(`Unhandled register result ${String(unreachable)}`);
		}
	}
}

export default async function todoMore(pi: ExtensionAPI): Promise<void> {
	try {
		registerScheme(pi);
	} catch (error) {
		pi.logger.warn("omp-todo-more: todo:// registration failed", { error: errorText(error) });
	}
	pi.registerTool(TODO_TOOL_DEFINITION);

	pi.on("before_agent_start", (_event, ctx) => {
		try {
			guardSubagent(ctx);
		} catch (error) {
			pi.logger.warn("todo-more could not guard todo", { error: errorText(error) });
		}
	});

	registerReminders(pi);
	registerOvertime(pi);
	registerPlanning(pi);
	registerUi(pi);
	await initializeTernPlugin();
	// Subscribed after the Tern await: a factory rejected by Tern initialization never reaches this line, so its event-bus listener cannot outlive the dropped plugin.
	registerReviewApi(pi);
}
