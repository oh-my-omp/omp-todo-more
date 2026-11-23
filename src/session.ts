import { AgentSession, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ParentCwd } from "./tool.ts";

export function sessionOf(agentId: string): AgentSession | undefined {
	const session = AgentRegistry.global().get(agentId)?.session;
	return session instanceof AgentSession ? session : undefined;
}

export const parentCwdOf =
	(ctx: ExtensionContext): ParentCwd =>
	() => {
		const parentId = ctx.agent.parentId;
		return parentId === undefined ? undefined : AgentRegistry.global().get(parentId)?.session?.sessionManager.getCwd();
	};
