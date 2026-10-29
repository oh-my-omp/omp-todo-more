import { type ExtensionAPI, type ExtensionContext, type SessionEntry, z } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { escapeXmlText } from "@oh-my-pi/pi-utils";
import { errorText } from "./errors.ts";
import { askWaits, elapsedTime, readTodoMore, TODO_MORE_ENTRY_TYPE } from "./state.ts";

export const OVERTIME_TYPE = `${TODO_MORE_ENTRY_TYPE}.overtime`;
export const overtimeDetailsSchema = z.object({
	budgetId: z.string(),
	title: z.string(),
	estimatedMinutes: z.number(),
	elapsedMs: z.number(),
});

/** A delivered custom message is the notification fact; todo snapshots never copy it. */
export function hasOvertimeWarning(branch: readonly SessionEntry[], budgetId: string): boolean {
	return branch.some((entry) => {
		if (entry.type !== "custom_message" || entry.customType !== OVERTIME_TYPE) return false;
		const parsed = overtimeDetailsSchema.safeParse(entry.details);
		return parsed.success && parsed.data.budgetId === budgetId;
	});
}

/** A handle is only a derived wake-up, never a cached todo or notification fact. */
type DeadlineBinding = {
	readonly ctx: ExtensionContext;
	readonly manager: SessionManager;
	readonly restore: () => void;
	timer?: { readonly handle: Timer; readonly deadline: number };
};

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** The host's record that an `ask` call started (`tool_execution_start`, written before the tool runs). */
function isAskStart(customType: string, data: unknown): boolean {
	return (
		customType === "tool_execution_start" && typeof data === "object" && data !== null && "toolName" in data && data.toolName === "ask"
	);
}

/**
 * Observe accepted todo journal writes, not projection setters or end events:
 * native todo results can persist later, and a rich commit can be accepted even
 * if its host projection fails. Never take over the collab replication callback.
 */
export function registerOvertime(pi: ExtensionAPI): void {
	let active: DeadlineBinding | undefined;
	// Queued notification intents last until the authority records their message.
	const pending = new Set<string>();
	const cancelTimer = (binding: DeadlineBinding): void => {
		if (binding.timer === undefined) return;
		binding.ctx.clearTimer(binding.timer.handle);
		delete binding.timer;
	};
	const stop = (): void => {
		if (active !== undefined) {
			cancelTimer(active);
			active.restore();
			active = undefined;
		}
		pending.clear();
	};
	const reschedule = (binding: DeadlineBinding): void => {
		if (active !== binding) return;
		try {
			const branch = binding.manager.getBranch();
			for (const budgetId of pending) {
				if (hasOvertimeWarning(branch, budgetId)) pending.delete(budgetId);
			}
			const state = readTodoMore(branch);
			const now = Date.now();
			// Waiting on the user in `ask` is not work time: no deadline runs while an ask is open,
			// and the ask's start or result re-reads the clock.
			const waits = askWaits(branch);
			const waiting = waits.some((wait) => wait.end === null);
			let nextDeadline: number | undefined;
			if (state.kind === "list" && !waiting) {
				for (const phase of state.phases) {
					for (const item of phase.items) {
						const time = item.time;
						if (item.status !== "in_progress" || time.kind === "missing" || time.runningSince === null) continue;
						if (pending.has(time.budgetId) || hasOvertimeWarning(branch, time.budgetId)) continue;
						const elapsedMs = elapsedTime(time, now, waits);
						const remainingMs = time.minutes * 60_000 - elapsedMs;
						if (remainingMs > 0) {
							const deadline = now + remainingMs;
							if (nextDeadline === undefined || deadline < nextDeadline) nextDeadline = deadline;
							continue;
						}
						const details = { budgetId: time.budgetId, title: item.title, estimatedMinutes: time.minutes, elapsedMs };
						const content = `<system-reminder source="todo-more" kind="overtime">
Todo item "${escapeXmlText(item.title)}" has exceeded its estimated time: estimate ${time.minutes} min; elapsed ${(elapsedMs / 60_000).toFixed(2)} min of in_progress wall time.
The estimate is a forecast, not a deadline or permission to reduce scope. Do not lower the expected outcome, acceptance criteria, or quality, and do not stop because of this warning.
Verify why this item is taking longer than estimated. Check the evidence and current blockers, decide whether the approach needs to change, and continue advancing the full task. Consider discussing the cause and next approach with a subagent; if you are a subagent, communicate with your parent where useful.
Keep the todo aligned with actual progress. Do not reset the list or inflate an estimate just to hide an overrun.
</system-reminder>`;
						pending.add(time.budgetId);
						try {
							pi.sendMessage(
								{ customType: OVERTIME_TYPE, content, display: true, details, attribution: "agent" },
								binding.ctx.isIdle() ? { triggerTurn: false } : { deliverAs: "aside" },
							);
						} catch (error) {
							pending.delete(time.budgetId);
							throw error;
						}
					}
				}
			}
			if (nextDeadline === undefined) {
				cancelTimer(binding);
				return;
			}
			if (binding.timer?.deadline === nextDeadline) return;
			cancelTimer(binding);
			const handle = binding.ctx.setTimeout(
				() => {
					if (binding.timer?.handle !== handle) return;
					delete binding.timer;
					// Re-read at the deadline: the budget/status/branch may have changed.
					reschedule(binding);
				},
				Math.min(MAX_TIMEOUT_MS, Math.max(1, nextDeadline - Date.now())),
			);
			binding.timer = { handle, deadline: nextDeadline };
		} catch (error) {
			pi.logger.warn("todo-more overtime warning failed", { error: errorText(error) });
		}
	};
	const start = (ctx: ExtensionContext): void => {
		stop();
		const manager = AgentRegistry.global().get(ctx.agent.id)?.session?.sessionManager;
		if (manager === undefined) return;
		const appendEntry = manager.appendCustomEntry;
		const appendMessage = manager.appendMessage;
		const appendCustomMessage = manager.appendCustomMessageEntry;
		const ingestReplicatedEntry = manager.ingestReplicatedEntry;
		let queued = false;
		const changed = (): void => {
			if (queued) return;
			queued = true;
			// Coalesce synchronous writes without assuming their final branch.
			// The microtask reads current authority, including any batch rollback.
			queueMicrotask(() => {
				queued = false;
				reschedule(binding);
			});
		};
		const observedEntry: typeof appendEntry = function (this: SessionManager, customType, data) {
			const result = appendEntry.call(this, customType, data);
			if (customType === TODO_MORE_ENTRY_TYPE || customType === USER_TODO_EDIT_CUSTOM_TYPE || isAskStart(customType, data)) changed();
			return result;
		};
		const observedMessage: typeof appendMessage = function (this: SessionManager, message) {
			const result = appendMessage.call(this, message);
			if (message.role === "toolResult" && (message.toolName === "todo" || message.toolName === "ask")) changed();
			return result;
		};
		const observedCustomMessage: typeof appendCustomMessage = function (
			this: SessionManager,
			customType,
			content,
			display,
			details,
			attribution,
			timestamp,
		) {
			const result = appendCustomMessage.call(this, customType, content, display, details, attribution, timestamp);
			if (customType === OVERTIME_TYPE) changed();
			return result;
		};
		const observedReplication: typeof ingestReplicatedEntry = function (this: SessionManager, entry) {
			const result = ingestReplicatedEntry.call(this, entry);
			if (
				(entry.type === "custom" &&
					(entry.customType === TODO_MORE_ENTRY_TYPE ||
						entry.customType === USER_TODO_EDIT_CUSTOM_TYPE ||
						isAskStart(entry.customType, entry.data))) ||
				(entry.type === "message" &&
					entry.message.role === "toolResult" &&
					(entry.message.toolName === "todo" || entry.message.toolName === "ask")) ||
				(entry.type === "custom_message" && entry.customType === OVERTIME_TYPE)
			)
				changed();
			return result;
		};
		const binding: DeadlineBinding = {
			ctx,
			manager,
			restore: () => {
				if (manager.appendCustomEntry === observedEntry) manager.appendCustomEntry = appendEntry;
				if (manager.appendMessage === observedMessage) manager.appendMessage = appendMessage;
				if (manager.appendCustomMessageEntry === observedCustomMessage) manager.appendCustomMessageEntry = appendCustomMessage;
				if (manager.ingestReplicatedEntry === observedReplication) manager.ingestReplicatedEntry = ingestReplicatedEntry;
			},
		};
		manager.appendCustomEntry = observedEntry;
		manager.appendMessage = observedMessage;
		manager.appendCustomMessageEntry = observedCustomMessage;
		manager.ingestReplicatedEntry = observedReplication;
		active = binding;
		reschedule(binding);
	};
	pi.on("session_start", (_event, ctx) => start(ctx));
	pi.on("session_switch", (_event, ctx) => start(ctx));
	pi.on("session_branch", (_event, ctx) => start(ctx));
	pi.on("session_tree", (_event, ctx) => start(ctx));
	pi.on("before_agent_start", (_event, ctx) => {
		const manager = AgentRegistry.global().get(ctx.agent.id)?.session?.sessionManager;
		if (active?.manager !== manager) start(ctx);
	});
	pi.on("session_shutdown", stop);
}
