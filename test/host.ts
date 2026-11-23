import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { TodoPhase as HostTodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { TodoSession } from "../src/commit.ts";
import type { ModelRef } from "../src/models.ts";
import { hostPhases, TODO_NG_NOTES_TYPE, type TodoNgState, toNotes } from "../src/state.ts";
import { type ParentCwd, runTodo, type TodoNgDetails } from "../src/tool.ts";

type Message = Parameters<SessionManager["appendMessage"]>[0];

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

export function stateResultMessage(state: TodoNgState, timestamp: number): Message {
	return todoResultMessage({ op: "batch", phases: hostPhases(state) }, timestamp);
}

export function appendStateResult(manager: SessionManager, state: TodoNgState, timestamp: number): string {
	return manager.appendMessage(stateResultMessage(state, timestamp));
}

export function stateEntries(id: string, at: number, state: TodoNgState): SessionEntry[] {
	return [
		{
			type: "custom",
			id: `${id}-notes`,
			parentId: null,
			timestamp: new Date(at).toISOString(),
			customType: TODO_NG_NOTES_TYPE,
			data: toNotes(state),
		},
		{ type: "message", id: `${id}-result`, parentId: null, timestamp: new Date(at).toISOString(), message: stateResultMessage(state, at) },
	];
}

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

export async function runPersisted(
	session: TodoSession,
	raw: unknown,
	leafMaxMinutes?: number,
	parentCwd?: ParentCwd,
): Promise<AgentToolResult<TodoNgDetails>> {
	const result = await runTodo(session, raw, leafMaxMinutes, parentCwd);
	session.sessionManager.appendMessage(todoResultMessage(result.details, Date.now(), result.isError === true));
	return result;
}
