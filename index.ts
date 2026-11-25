import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { AgentSession, ExtensionAPI, ExtensionContext, ToolDefinition, ToolRenderResultOptions } from "@oh-my-pi/pi-coding-agent";
import { logger } from "@oh-my-pi/pi-utils";
import { canonicalToolOrder } from "./omomp-shared/active-tools.ts";
import { tr } from "./omomp-shared/i18n.ts";
import { acceptanceGuard } from "./src/acceptance.ts";
import { errorText } from "./src/errors.ts";
import { renderTodoCall, renderTodoResult } from "./src/native.tsx";
import { registerOvertime } from "./src/overtime.ts";
import { registerPlanning } from "./src/planning.ts";
import { readProjectConfig } from "./src/project-config.ts";
import { registerReminders } from "./src/reminders.tsx";
import { registerReviewApi } from "./src/review-api.ts";
import { parentCwdOf, sessionOf } from "./src/session.ts";
import { readSettings } from "./src/settings.ts";
import { initializeTernPlugin } from "./src/tern-plugin-install.ts";
import { DESCRIPTION, parametersSchema, runTodo, type TodoNgDetails } from "./src/tool.ts";
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
	renderCall: (args: unknown) => renderTodoCall(args),
	renderResult: (result: AgentToolResult<unknown>, options: ToolRenderResultOptions) => renderTodoResult(result, options),
};

const ownSession = (ctx: ExtensionContext): AgentSession | undefined => sessionOf(ctx.agent.id);

async function executeTodo(session: AgentSession, params: unknown, ctx: ExtensionContext, signal: AbortSignal | undefined) {
	const settings = await readSettings({ logger }, ctx);
	const project = readProjectConfig(logger, ctx.cwd);
	return runTodo(session, params, {
		leafMaxMinutes: settings.leafMaxMinutes,
		parentCwd: parentCwdOf(ctx),
		agent: ctx.agent,
		project,
		signal,
		host: ctx,
		acceptance: [acceptanceGuard(session.settings)],
	});
}

async function restoreTodo(session: AgentSession, ctx: ExtensionContext): Promise<void> {
	const enabled = session.getEnabledToolNames();
	if (!enabled.includes("edit") || enabled.includes(TOOL_NAME)) return;
	if (session.getAllToolNames().includes(TOOL_NAME)) {
		await session.setActiveToolsByName(canonicalToolOrder(session.getAllToolInfos(), [...enabled, TOOL_NAME]));
		return;
	}
	const hostTool: AgentTool<typeof parametersSchema, TodoNgDetails> = {
		...TOOL_FIELDS,
		get label(): string {
			return tr("Todo", "待办");
		},
		execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal) => executeTodo(session, params, ctx, signal),
	};
	await session.refreshRpcHostTools([hostTool]);
}

const guardedSessions = new WeakSet<AgentSession>();

function guardSubagent(ctx: ExtensionContext): void {
	if (ctx.agent.kind !== "sub") return;
	const session = ownSession(ctx);
	if (session === undefined || guardedSessions.has(session)) return;
	guardedSessions.add(session);
	session.agent.addBeforeModelCallHook(async () => {
		try {
			const project = readProjectConfig(logger, ctx.cwd);
			if (project.kind === "ok" && !project.config.effects.editGate) return;
			await restoreTodo(session, ctx);
		} catch (error) {
			logger.warn("todo-ng could not install todo", { error: errorText(error) });
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
		signal: AbortSignal | undefined,
		_onUpdate: AgentToolUpdateCallback<TodoNgDetails> | undefined,
		ctx: ExtensionContext,
	) => {
		const session = ownSession(ctx);
		if (session === undefined) throw new Error(`todo: no session registered for agent ${ctx.agent.id}`);
		return executeTodo(session, params, ctx, signal);
	},
} satisfies ToolDefinition<typeof parametersSchema, TodoNgDetails>;

export default async function todoNg(pi: ExtensionAPI): Promise<void> {
	pi.registerTool(TODO_TOOL_DEFINITION);

	pi.on("before_agent_start", (_event, ctx) => {
		try {
			guardSubagent(ctx);
		} catch (error) {
			pi.logger.warn("todo-ng could not guard todo", { error: errorText(error) });
		}
	});

	registerReminders(pi);
	registerOvertime(pi);
	registerPlanning(pi);
	registerUi(pi);
	await initializeTernPlugin();
	registerReviewApi(pi);
}
