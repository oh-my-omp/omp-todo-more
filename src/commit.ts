import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { branchFacts } from "./branch.ts";
import type { ModelRef } from "./models.ts";
import { hostPhases, joinHost, TODO_NG_NOTES_TYPE, type TodoNgState, toNotes } from "./state.ts";

export type HostListSession = Pick<AgentSession, "sessionManager" | "setTodoPhases" | "getTodoPhases">;
export type TodoSession = HostListSession & {
	readonly model: ModelRef | undefined;
};

export function liveState(session: Pick<AgentSession, "sessionManager" | "getTodoPhases">): TodoNgState {
	return joinHost(session.getTodoPhases(), branchFacts(session.sessionManager).notes);
}

export function commitTodoState(session: HostListSession, next: TodoNgState): void {
	const manager = session.sessionManager;
	const notes = toNotes(next);
	if (!Bun.deepEquals(branchFacts(manager).notes, notes)) manager.appendCustomEntry(TODO_NG_NOTES_TYPE, notes);
	session.setTodoPhases(hostPhases(next));
}
