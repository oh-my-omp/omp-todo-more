/**
 * The in-process `AgentSession` behind an agent id. The registry hands out the
 * cross-thread `AgentSessionHandle`; todo-more needs the session itself (its
 * manager, settings, todo projection and tools), which only a session living in
 * this process is. A remote session is not one, and is left alone.
 */
import { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

export function sessionOf(agentId: string): AgentSession | undefined {
	const session = AgentRegistry.global().get(agentId)?.session;
	return session instanceof AgentSession ? session : undefined;
}
