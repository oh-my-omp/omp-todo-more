/**
 * Overtime warning: when an in_progress item's in_progress wall time (minus
 * time spent waiting on the user in `ask`) passes its estimate, one
 * `OVERTIME_TYPE` message per budget id, delivered as an aside mid-run or
 * without a turn while idle.
 *
 * The deadline is a derived wake-up, never a cached todo or notification
 * fact: every check re-reads the branch facts (`branch.ts`), and the timer
 * only schedules the next check. Checks run when the list or an ask can have
 * changed: the session's start or switch, its own and the host's todo writes
 * (tool results, `session.commitTodoPhases` for `/todo`, RPC `set_todos` and
 * subagent auto-complete), ask results, and turn and run ends. An ask opening
 * needs no check of its own: a deadline that falls inside it re-reads the
 * branch, sees the open wait and stands down. A check that reads the branch
 * before the host persisted a change is corrected by the next one.
 *
 * Only events baseline todo-more already handled are subscribed: the host
 * awaits extension handlers per event type, so a new event type would shift
 * the host's own persistence order (mode changes vs tool results).
 */
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { escapeXmlText } from "@oh-my-pi/pi-utils";
import { branchFacts } from "./branch.ts";
import { errorText } from "./errors.ts";
import { sessionOf } from "./session.ts";
import { elapsedTime, OVERTIME_TYPE } from "./state.ts";

/** One session's wake-up: the bound session, its timer, and how to undo the host-write observer. */
type DeadlineBinding = {
	readonly ctx: ExtensionContext;
	readonly session: AgentSession;
	readonly restore: () => void;
	timer?: { readonly handle: Timer; readonly deadline: number };
};

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

function overtimeText(title: string, minutes: number, elapsedMs: number): string {
	return `<system-reminder source="todo-more" kind="overtime">
Todo item "${escapeXmlText(title)}" has exceeded its estimated time: estimate ${minutes} min; elapsed ${(elapsedMs / 60_000).toFixed(2)} min of in_progress wall time.
The estimate is a forecast, not a deadline or permission to reduce scope. Do not lower the expected outcome, acceptance criteria, or quality, and do not stop because of this warning.
Verify why this item is taking longer than estimated. Check the evidence and current blockers, decide whether the approach needs to change, and continue advancing the full task. Consider discussing the cause and next approach with a subagent; if you are a subagent, communicate with your parent where useful.
Keep the todo aligned with actual progress. Do not reset the list or inflate an estimate just to hide an overrun.
</system-reminder>`;
}

export function registerOvertime(pi: ExtensionAPI): void {
	let active: DeadlineBinding | undefined;
	// Queued notification intents last until the branch records their message.
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
			const facts = branchFacts(binding.session.sessionManager);
			for (const budgetId of pending) {
				if (facts.overtimeWarned.has(budgetId)) pending.delete(budgetId);
			}
			const state = facts.state;
			const now = Date.now();
			// Waiting on the user in `ask` is not work time: no deadline runs while an ask is open,
			// and the ask's start or result re-reads the clock.
			const waiting = facts.waits.some((wait) => wait.end === null);
			let nextDeadline: number | undefined;
			if (state.kind === "list" && !waiting) {
				for (const phase of state.phases) {
					for (const item of phase.items) {
						const time = item.time;
						if (item.status !== "in_progress" || time.kind === "missing" || time.runningSince === null) continue;
						if (pending.has(time.budgetId) || facts.overtimeWarned.has(time.budgetId)) continue;
						const elapsedMs = elapsedTime(time, now, facts.waits);
						const remainingMs = time.minutes * 60_000 - elapsedMs;
						if (remainingMs > 0) {
							const deadline = now + remainingMs;
							if (nextDeadline === undefined || deadline < nextDeadline) nextDeadline = deadline;
							continue;
						}
						const details = { budgetId: time.budgetId, title: item.title, estimatedMinutes: time.minutes, elapsedMs };
						pending.add(time.budgetId);
						try {
							pi.sendMessage(
								{
									customType: OVERTIME_TYPE,
									content: overtimeText(item.title, time.minutes, elapsedMs),
									display: true,
									details,
									attribution: "agent",
								},
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
	let queued = false;
	/** Coalesce the checks of one synchronous burst; the microtask reads the branch as it then stands. */
	const changed = (): void => {
		const binding = active;
		if (binding === undefined || queued) return;
		queued = true;
		queueMicrotask(() => {
			queued = false;
			reschedule(binding);
		});
	};
	const start = (ctx: ExtensionContext): void => {
		stop();
		const session = sessionOf(ctx.agent.id);
		if (session === undefined) return;
		// The host's writes outside the todo tool (`/todo`, RPC `set_todos`, subagent
		// auto-complete) all go through this method and raise no event.
		const commit = session.commitTodoPhases;
		const observed: typeof commit = (phases) => {
			commit.call(session, phases);
			changed();
		};
		session.commitTodoPhases = observed;
		const binding: DeadlineBinding = {
			ctx,
			session,
			restore: () => {
				if (session.commitTodoPhases === observed) session.commitTodoPhases = commit;
			},
		};
		active = binding;
		reschedule(binding);
	};
	pi.on("session_start", (_event, ctx) => start(ctx));
	pi.on("session_switch", (_event, ctx) => start(ctx));
	pi.on("session_branch", (_event, ctx) => start(ctx));
	pi.on("session_tree", (_event, ctx) => start(ctx));
	pi.on("before_agent_start", (_event, ctx) => {
		const session = sessionOf(ctx.agent.id);
		if (active?.session !== session) start(ctx);
		else changed();
	});
	pi.on("tool_result", (event) => {
		if (event.toolName === "ask" || event.toolName === "todo") changed();
	});
	pi.on("message_end", (event) => {
		if (event.message.role === "toolResult" && (event.message.toolName === "ask" || event.message.toolName === "todo")) changed();
	});
	pi.on("turn_end", () => changed());
	pi.on("agent_end", () => changed());
	pi.on("session_shutdown", stop);
}
