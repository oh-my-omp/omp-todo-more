import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createDeltaStream, type Delta } from "../omomp-shared/context-delta.ts";
import { branchFacts, contextBranch } from "./branch.ts";
import { errorText } from "./errors.ts";
import { sessionOf } from "./session.ts";
import { type TodoMoreState, toSnapshot } from "./state.ts";

const INIT_REMINDER =
	'Todo is empty. Work phase (this request changes files, config, git or external state): before the first change, initialize with one complete Todo document: INIT "objective" "measure" "doneWhen", PHASE "name", and ADD "title" "explanation" minutes for every step, between *** Begin Todo and *** End Todo. Estimate each item yourself in positive integer minutes; no fractions or defaults. edit is blocked until the complete document succeeds and the list has items. Non-work phase (discussion, investigation, explanation, answering questions): no todo.';

function reminderBody(state: TodoMoreState): string {
	switch (state.kind) {
		case "empty":
			return INIT_REMINDER;
		case "list":
			return [
				'Discussion, investigation, explanation and questions add no items. Check that this todo matches your current plan and latest user instructions. Update the goal, steps, explanations, estimates and statuses wherever they disagree; do not omit or narrow work. The complete snapshot includes completed and abandoned items. A null goal/explanation is missing; time.kind missing requires ESTIMATE "title" minutes with your own positive integer estimate. Batch related changes in one Todo document. Budgets are forecasts, not permission to reduce scope or quality. You do not need VIEW to check this snapshot.',
				JSON.stringify(toSnapshot(state), null, 2),
			].join("\n");
		default: {
			const unreachable: never = state;
			throw new Error(`Unexpected todo-more state: ${String(unreachable)}`);
		}
	}
}

export function registerPlanning(pi: ExtensionAPI): void {
	const deltas = createDeltaStream("omp-todo-more/planning");
	const current = (ctx: ExtensionContext): Delta => ({
		kind: "text",
		body: reminderBody(branchFacts(contextBranch(ctx)).state),
	});
	const guarded = new WeakSet<AgentTool>();
	const installEditGuard = (ctx: ExtensionContext): void => {
		const session = sessionOf(ctx.agent.id);
		const tool = session?.getToolByName("edit");
		if (session === undefined || tool === undefined || guarded.has(tool)) return;
		const execute = tool.execute.bind(tool);
		tool.execute = async (...args) => {
			try {
				if (branchFacts(session.sessionManager).state.kind === "empty") {
					return { isError: true, content: [{ type: "text", text: INIT_REMINDER }] };
				}
			} catch (error) {
				pi.logger.warn("todo-more edit precondition failed", { error: errorText(error) });
				return {
					isError: true,
					content: [{ type: "text", text: "Cannot read the todo list. Resolve the todo state before retrying edit." }],
				};
			}
			return execute(...args);
		};
		guarded.add(tool);
	};
	const installSafely = (ctx: ExtensionContext): void => {
		try {
			installEditGuard(ctx);
		} catch (error) {
			pi.logger.warn("todo-more could not install edit precondition", { error: errorText(error) });
		}
	};
	pi.on("session_start", (_event, ctx) => installSafely(ctx));
	pi.on("before_agent_start", (event, ctx) => {
		if (event.reason === "revive") return;
		installSafely(ctx);
		try {
			return deltas.atPrompt(ctx, current(ctx));
		} catch (error) {
			pi.logger.warn("todo-more user-message reminder failed", { error: errorText(error) });
		}
	});
	pi.on("tool_call", (event, ctx) => {
		// Install
		// here after registry refreshes, but read todo only inside execute so
		// init/edit and rm/edit in one batch see their actual execution state.
		if (event.toolName === "edit") installSafely(ctx);
	});
	pi.on("tool_result", (_event, ctx) => {
		try {
			return deltas.afterTools(ctx, current(ctx));
		} catch (error) {
			pi.logger.warn("todo-more todo snapshot reminder failed", { error: errorText(error) });
		}
	});
	pi.on("turn_start", () => deltas.turnStarted());
}
