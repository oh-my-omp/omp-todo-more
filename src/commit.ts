import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { branchFacts } from "./branch.ts";
import { errorText } from "./errors.ts";
import type { ModelRef } from "./models.ts";
import { hostPhases, TODO_MORE_ENTRY_TYPE, type TodoMoreState, toSnapshot } from "./state.ts";

/** The session a todo call serves; `model` is the one it currently runs, which a `DONE` commit names. */
export type TodoSession = Pick<AgentSession, "sessionManager" | "setTodoPhases"> & { readonly model: ModelRef | undefined };

/** `persist` means acceptance by the authority branch, not a durable disk-write acknowledgement. */
export type TodoCommitResult =
	| { kind: "saved"; state: TodoMoreState }
	| { kind: "failed"; stage: "persist" | "projection"; message: string };

/** No await between reading the branch, appending its record and projecting it. */
export function commitTodoState(session: TodoSession, next: TodoMoreState): TodoCommitResult {
	try {
		const current = branchFacts(session.sessionManager).state;
		if (!Bun.deepEquals(current, next)) {
			session.sessionManager.appendCustomEntry(TODO_MORE_ENTRY_TYPE, toSnapshot(next));
			if (!Bun.deepEquals(branchFacts(session.sessionManager).state, next)) {
				return { kind: "failed", stage: "persist", message: "Authority branch did not accept the todo snapshot." };
			}
		}
	} catch (error) {
		return { kind: "failed", stage: "persist", message: `Todo branch snapshot was not accepted: ${errorText(error)}` };
	}
	try {
		// Also repairs a prior partial projection on a no-op Save, without another snapshot.
		session.setTodoPhases(hostPhases(next));
	} catch (error) {
		return { kind: "failed", stage: "projection", message: `Todo branch state accepted, but host projection failed: ${errorText(error)}` };
	}
	return { kind: "saved", state: next };
}
