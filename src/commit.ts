import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { branchFacts } from "./branch.ts";
import type { ModelRef } from "./models.ts";
import { hostPhases, joinHost, TODO_MORE_NOTES_TYPE, type TodoMoreState, toNotes } from "./state.ts";

export type HostListSession = Pick<AgentSession, "sessionManager" | "setTodoPhases" | "getTodoPhases">;
export type TodoSession = HostListSession & {
	readonly model: ModelRef | undefined;
};

/**
 * The list as the host holds it right now, with the plugin's notes attached.
 * A `todo` result reaches the branch asynchronously, so a call that follows
 * another in the same turn reads the live host list, not the branch.
 */
export function liveState(session: Pick<AgentSession, "sessionManager" | "getTodoPhases">): TodoMoreState {
	return joinHost(session.getTodoPhases(), branchFacts(session.sessionManager).notes);
}

/** Records the plugin's part of `next`; the entry is on the branch when this returns. */
export function recordNotes(session: Pick<AgentSession, "sessionManager">, next: TodoMoreState): void {
	const manager = session.sessionManager;
	const notes = toNotes(next);
	if (!Bun.deepEquals(branchFacts(manager).notes, notes)) manager.appendCustomEntry(TODO_MORE_NOTES_TYPE, notes);
}

/** Writes the host list and the plugin's part of it, with no await between. */
export function commitTodoState(session: HostListSession, next: TodoMoreState): void {
	recordNotes(session, next);
	session.setTodoPhases(hostPhases(next));
}
