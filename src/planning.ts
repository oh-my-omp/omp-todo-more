/**
 * Enforce a non-empty todo before `edit`, and annotate every real user
 * message with the todo snapshot: an empty list asks for a todo only for
 * work (changes to files, config, git or external state), never for
 * discussion or investigation. `context` rewrites only provider input, not the
 * stored human text. Keeping the user role also lets OMP deliver mid-response
 * steering live.
 */
import type { AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { errorText } from "./errors.ts";
import { readTodoMore, type TodoMoreState, toSnapshot } from "./state.ts";

const INIT_REMINDER =
	'Todo is empty. Work phase (this request changes files, config, git or external state): before the first change, initialize with one complete Todo document: INIT "objective" "measure" "doneWhen", PHASE "name", and ADD "title" "explanation" minutes for every step, between *** Begin Todo and *** End Todo. Estimate each item yourself in positive integer minutes; no fractions or defaults. edit is blocked until the complete document succeeds and the list has items. Non-work phase (discussion, investigation, explanation, answering questions): no todo.';

type HumanMessage = Extract<AgentMessage, { role: "user" | "custom" }>;

/** Match OMP's user-authored queue predicate, excluding synthetic continuations. */
function isHumanMessage(message: AgentMessage): message is HumanMessage {
	if (message.role === "user") return message.attribution !== "agent" && !message.synthetic;
	return message.role === "custom" && message.attribution === "user" && message.display !== false;
}

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

/**
 * Historical users get the state at their delivery, not today's list. Queued
 * users may not yet be persisted when `context` runs: for those, read the
 * current branch. No snapshot cache or cursor crosses requests or branches.
 */
function stateForMessage(message: HumanMessage, branch: readonly SessionEntry[]): TodoMoreState {
	if (message.role === "custom") {
		// OMP can stamp the stored custom_message a millisecond after the live
		// message. Use the first matching record at or after its emission, not
		// exact equality or the newest matching text (which conflates repeats).
		for (let index = 0; index < branch.length; index++) {
			const entry = branch[index];
			if (
				entry?.type === "custom_message" &&
				entry.attribution === "user" &&
				entry.display !== false &&
				entry.customType === message.customType &&
				Date.parse(entry.timestamp) >= message.timestamp &&
				Bun.deepEquals(entry.content, message.content)
			) {
				return readTodoMore(branch.slice(0, index + 1));
			}
		}
		return readTodoMore(branch);
	}
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type !== "message" || !isHumanMessage(entry.message)) continue;
		if (entry.message.timestamp === message.timestamp && Bun.deepEquals(entry.message.content, message.content)) {
			return readTodoMore(branch.slice(0, index + 1));
		}
	}
	return readTodoMore(branch);
}

export function registerPlanning(pi: ExtensionAPI): void {
	// Installation identity, not todo state. A refreshed registry may supply a
	// new edit tool; each tool instance receives exactly one execution wrapper.
	const guarded = new WeakSet<AgentTool>();
	const installEditGuard = (ctx: ExtensionContext): void => {
		const session = AgentRegistry.global().get(ctx.agent.id)?.session;
		const tool = session?.getToolByName("edit");
		if (session == null || tool === undefined || guarded.has(tool)) return;
		const execute = tool.execute.bind(tool);
		tool.execute = async (...args) => {
			try {
				if (readTodoMore(session.sessionManager.getBranch()).kind === "empty") {
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
			const branch = ctx.sessionManager.getBranch();
			const messages = event.messages.map((message): AgentMessage => {
				if (!isHumanMessage(message)) return message;
				const note = { type: "text" as const, text: reminder(stateForMessage(message, branch)) };
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
