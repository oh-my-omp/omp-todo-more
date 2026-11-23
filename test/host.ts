import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { TodoPhase as HostTodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { TodoSession } from "../src/commit.ts";
import type { ModelRef } from "../src/models.ts";
import { hostPhases, TODO_MORE_NOTES_TYPE, type TodoMoreState, toNotes } from "../src/state.ts";
import { type ParentCwd, runTodo, type TodoMoreDetails } from "../src/tool.ts";

type Message = Parameters<SessionManager["appendMessage"]>[0];

/** A `todo` result as the host persists it: the list it carries is the host's record of the list. */
export function todoResultMessage(details: unknown, timestamp: number, isError = false): Message {
	return {
		role: "toolResult",
		toolCallId: `todo-${timestamp}`,
		toolName: "todo",
		content: [{ type: "text", text: "Todo updated" }],
		details,
		isError,
		timestamp,
	};
}

/** The host list of `state`, as a persisted `todo` result. */
export function stateResultMessage(state: TodoMoreState, timestamp: number): Message {
	return todoResultMessage({ op: "update", phases: hostPhases(state) }, timestamp);
}

export function appendStateResult(manager: SessionManager, state: TodoMoreState, timestamp: number): string {
	return manager.appendMessage(stateResultMessage(state, timestamp));
}

/** The branch entries a plugin write leaves: its notes, then the host's `todo` result. */
export function stateEntries(id: string, at: number, state: TodoMoreState): SessionEntry[] {
	return [
		{
			type: "custom",
			id: `${id}-notes`,
			parentId: null,
			timestamp: new Date(at).toISOString(),
			customType: TODO_MORE_NOTES_TYPE,
			data: toNotes(state),
		},
		{ type: "message", id: `${id}-result`, parentId: null, timestamp: new Date(at).toISOString(), message: stateResultMessage(state, at) },
	];
}

/** A session whose host list is a plain array, as the host's `TodoTracker` keeps it. */
export function hostSession(sessionManager: SessionManager, model?: ModelRef): TodoSession {
	let list: HostTodoPhase[] = [];
	return {
		sessionManager,
		model,
		getTodoPhases: () => structuredClone(list),
		setTodoPhases: (phases) => {
			list = structuredClone(phases);
		},
	};
}

/** Runs the tool, then persists its result the way the host does. */
export async function runPersisted(
	session: TodoSession,
	raw: unknown,
	leafMaxMinutes?: number,
	parentCwd?: ParentCwd,
): Promise<AgentToolResult<TodoMoreDetails>> {
	const result = await runTodo(session, raw, leafMaxMinutes, parentCwd);
	session.sessionManager.appendMessage(todoResultMessage(result.details, Date.now(), result.isError === true));
	return result;
}
