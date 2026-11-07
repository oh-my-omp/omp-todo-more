/**
 * Enforce a non-empty todo before `edit`, and annotate every real user
 * message with the todo snapshot: an empty list asks for a todo only for
 * work (changes to files, config, git or external state), never for
 * discussion or investigation. `context` rewrites only provider input, not the
 * stored human text. Keeping the user role also lets OMP deliver mid-response
 * steering live.
 */
import type { AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { branchFacts, contextBranch, isHumanMessage, stateForHumanMessage } from "./branch.ts";
import { errorText } from "./errors.ts";
import { sessionOf } from "./session.ts";
import { type TodoMoreState, toSnapshot } from "./state.ts";

const INIT_REMINDER =
	'Todo is empty. Work phase (this request changes files, config, git or external state): before the first change, initialize with one complete Todo document: INIT "objective" "measure" "doneWhen", PHASE "name", and ADD "title" "explanation" minutes for every step, between *** Begin Todo and *** End Todo. Estimate each item yourself in positive integer minutes; no fractions or defaults. edit is blocked until the complete document succeeds and the list has items. Non-work phase (discussion, investigation, explanation, answering questions): no todo.';

function reminder(state: TodoMoreState): string {
	switch (state.kind) {
		case "empty":
			return `<system-reminder source="todo-more">\n${INIT_REMINDER}\n</system-reminder>`;
		case "list":
			return [
				'<system-reminder source="todo-more">',
				'Discussion, investigation, explanation and questions add no items. Check that this todo matches your current plan and latest user instructions. Update the goal, steps, explanations, estimates and statuses wherever they disagree; do not omit or narrow work. The complete snapshot includes completed, abandoned and blocked items. A null goal/explanation is missing; time.kind missing requires ESTIMATE "title" minutes with your own positive integer estimate. Batch related changes in one Todo document. Budgets are forecasts, not permission to reduce scope or quality. You do not need VIEW to check this snapshot.',
				JSON.stringify(toSnapshot(state), null, 2),
				"</system-reminder>",
			].join("\n");
		default: {
			const unreachable: never = state;
			throw new Error(`Unexpected todo-more state: ${String(unreachable)}`);
		}
	}
}

export function registerPlanning(pi: ExtensionAPI): void {
	// Installation identity, not todo state. A refreshed registry may supply a
	// new edit tool; each tool instance receives exactly one execution wrapper.
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
	pi.on("before_agent_start", (_event, ctx) => installSafely(ctx));
	pi.on("tool_call", (event, ctx) => {
		// tool_call prepares the whole batch before anything executes. Install
		// here after registry refreshes, but read todo only inside execute so
		// init/edit and rm/edit in one batch see their actual execution state.
		if (event.toolName === "edit") installSafely(ctx);
	});

	pi.on("context", (event, ctx) => {
		try {
			const facts = branchFacts(contextBranch(ctx));
			const messages = event.messages.map((message): AgentMessage => {
				if (!isHumanMessage(message)) return message;
				const note = { type: "text" as const, text: reminder(stateForHumanMessage(facts, message)) };
				const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
				return { ...message, content: [...content, note] };
			});
			return { messages };
		} catch (error) {
			pi.logger.warn("todo-more user-message reminder failed", { error: errorText(error) });
			return undefined;
		}
	});
}
