import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { createDeltaStream, type Delta } from "../omomp-shared/context-delta.ts";
import { type BranchSource, branchFacts, contextBranch } from "./branch.ts";
import { errorText } from "./errors.ts";
import { readSettings } from "./settings.ts";
import { type TodoMoreState, toSnapshot } from "./state.ts";
import { previewTodo } from "./tool.ts";

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
	// The host emits `tool_call` for every call of an assistant message before it executes any of them, so an `edit`
	// that follows a `todo` in the same message sees the list as it was before that `todo`. `pending` holds the state
	// the earlier `todo` calls of the message will leave, until the first of them executes.
	const pending = new WeakMap<BranchSource, TodoMoreState>();
	const settled = (ctx: ExtensionContext): void => {
		pending.delete(contextBranch(ctx));
	};
	const previewTodoCall = async (input: Record<string, unknown>, ctx: ExtensionContext): Promise<void> => {
		const branch = contextBranch(ctx);
		const facts = branchFacts(branch);
		const settings = await readSettings(pi, ctx);
		const preview = previewTodo(facts, pending.get(branch) ?? facts.state, input, settings.leafMaxMinutes);
		if (preview.kind === "state") pending.set(branch, preview.state);
	};
	const guardEdit = (ctx: ExtensionContext): ToolCallEventResult | undefined => {
		const branch = contextBranch(ctx);
		return (pending.get(branch) ?? branchFacts(branch).state).kind === "empty" ? { block: true, reason: INIT_REMINDER } : undefined;
	};
	pi.on("before_agent_start", (event, ctx) => {
		if (event.reason === "revive") return;
		try {
			return deltas.atPrompt(ctx, current(ctx));
		} catch (error) {
			pi.logger.warn("todo-more user-message reminder failed", { error: errorText(error) });
		}
	});
	pi.on("tool_call", async (event, ctx) => {
		try {
			switch (event.toolName) {
				case "todo":
					await previewTodoCall(event.input, ctx);
					return undefined;
				case "edit":
					return guardEdit(ctx);
				default:
					return undefined;
			}
		} catch (error) {
			pi.logger.warn("todo-more planning gate failed", { tool: event.toolName, error: errorText(error) });
			if (event.toolName !== "edit") return undefined;
			return { block: true, reason: "Cannot read the todo list. Resolve the todo state before retrying edit." };
		}
	});
	pi.on("tool_result", (_event, ctx) => {
		settled(ctx);
		try {
			return deltas.afterTools(ctx, current(ctx));
		} catch (error) {
			pi.logger.warn("todo-more todo snapshot reminder failed", { error: errorText(error) });
		}
	});
	pi.on("turn_start", (_event, ctx) => {
		settled(ctx);
		deltas.turnStarted();
	});
	pi.on("turn_end", (_event, ctx) => settled(ctx));
}
