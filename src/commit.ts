import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { branchFacts } from "./branch.ts";
import type { ModelRef } from "./models.ts";
import { hostPhases, joinHost, TODO_MORE_NOTES_TYPE, type TodoMoreState, toNotes } from "./state.ts";

export type HostListSession = Pick<AgentSession, "sessionManager" | "setTodoPhases" | "getTodoPhases">;
export type TodoSession = HostListSession & {
	readonly model: ModelRef | undefined;
};

export function liveState(session: Pick<AgentSession, "sessionManager" | "getTodoPhases">): TodoMoreState {
	return joinHost(session.getTodoPhases(), branchFacts(session.sessionManager).notes);
}

export function commitTodoState(session: HostListSession, next: TodoMoreState): void {
	const manager = session.sessionManager;
	const notes = toNotes(next);
	if (!Bun.deepEquals(branchFacts(manager).notes, notes)) manager.appendCustomEntry(TODO_MORE_NOTES_TYPE, notes);
	session.setTodoPhases(hostPhases(next));
}
