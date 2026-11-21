import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { isTodoReadRequest, TODO_READ_EVENT, type TodoReadCounts, type TodoReadResponse } from "../omomp-shared/todo-read.ts";
import { branchFacts } from "./branch.ts";
import { errorText } from "./errors.ts";
import { sessionOf } from "./session.ts";
import { actionableItems, type TodoMoreState, type TodoStatus } from "./state.ts";

function statusCounts(state: TodoMoreState): TodoReadCounts {
	const counts: Record<TodoStatus, number> = { pending: 0, in_progress: 0, completed: 0, abandoned: 0 };
	if (state.kind === "list") for (const phase of state.phases) for (const item of phase.items) counts[item.status]++;
	return counts;
}

/** Synchronous request/reply only: branch reads, no IO, cache, timers or writes. */
export function registerReviewApi(pi: ExtensionAPI): void {
	const unsubscribe = pi.events.on(TODO_READ_EVENT, (request) => {
		if (!isTodoReadRequest(request)) return;
		let response: TodoReadResponse;
		try {
			const session = sessionOf(request.agentId);
			if (session === undefined) response = { kind: "unavailable" };
			else {
				const state = branchFacts(session.sessionManager).state;
				response = {
					kind: "ok",
					goal: state.kind === "list" && state.goal.kind === "set" ? state.goal.goal : null,
					openItems: actionableItems(state).map(({ phase, item }) => ({
						phase,
						title: item.title,
						explanation: item.explanation.kind === "explained" ? item.explanation.text : null,
					})),
					counts: statusCounts(state),
				};
			}
		} catch (error) {
			pi.logger.warn("todo-more review read failed", { error: errorText(error) });
			response = { kind: "unavailable" };
		}
		request.reply(response);
	});
	pi.on("session_shutdown", () => unsubscribe());
}
