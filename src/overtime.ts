import type { AgentSession, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { escapeXmlText } from "@oh-my-pi/pi-utils";
import { deferDuringCompaction, isCompacting } from "../omomp-shared/compact-handoff.ts";
import { createDeltaStream } from "../omomp-shared/context-delta.ts";
import { branchFacts } from "./branch.ts";
import { liveState } from "./commit.ts";
import { errorText } from "./errors.ts";
import { currentTimeLine, formatClock } from "./format.ts";
import { readProjectConfig } from "./project-config.ts";
import { sessionOf } from "./session.ts";
import { dueAt, elapsedOf, OVERTIME_TYPE } from "./state.ts";

type DeadlineBinding = {
	readonly ctx: ExtensionContext;
	readonly session: AgentSession;
	timer?: { readonly handle: Timer; readonly deadline: number };
};

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

function overtimeBody(title: string, phase: string, dueAt: number, now: number): string {
	return `${currentTimeLine(now)}
SERIOUS: todo item "${escapeXmlText(title)}" is past its target completion time of ${formatClock(dueAt, now)} (overdue as of ${formatClock(now, now)}). An overrun means the plan or the approach is wrong; treat it as a serious problem, not a note to acknowledge and move past.
Before any other step on this task, investigate why it overran:
1. Check the evidence: what this item's work actually took, what is still missing, and what blocked, slowed or expanded it.
2. Decide whether the approach must change. If the cause is unclear, discuss it with a subagent; if you are a subagent, raise it with your parent.
3. In your next message, state the cause you found and the approach you will take from here.
This item's estimate is closed: estimate on it is rejected. If the work needs more time, add the remaining work as new items with add (phase ${escapeXmlText(JSON.stringify(phase))}), each within the per-item limit, then continue with them.
Do not lower the expected outcome, acceptance criteria or quality, and do not reset the list or remove and recreate this item to escape the overrun.`;
}

export function registerOvertime(pi: ExtensionAPI): void {
	const deltas = createDeltaStream("omp-todo-ng/overtime");
	let active: DeadlineBinding | undefined;
	const pending = new Set<string>();
	const cancelTimer = (binding: DeadlineBinding): void => {
		if (binding.timer === undefined) return;
		binding.ctx.clearTimer(binding.timer.handle);
		delete binding.timer;
	};
	const stop = (): void => {
		if (active !== undefined) {
			cancelTimer(active);
			active = undefined;
		}
		pending.clear();
	};
	const reschedule = (binding: DeadlineBinding): void => {
		if (active !== binding) return;
		if (isCompacting(binding.session.sessionManager)) {
			deferDuringCompaction(binding.session.sessionManager, "omp-todo-ng:overtime", () => changed());
			return;
		}
		try {
			const project = readProjectConfig(pi.logger, binding.ctx.cwd);
			if (project.kind === "invalid" || !project.config.effects.overtime) {
				cancelTimer(binding);
				return;
			}
			const facts = branchFacts(binding.session.sessionManager);
			for (const budgetId of pending) {
				if (facts.overtimeWarned.has(budgetId)) pending.delete(budgetId);
			}
			const state = liveState(binding.session);
			const now = Date.now();
			const waiting = facts.waits.some((wait) => wait.end === null);
			let nextDeadline: number | undefined;
			if (state.kind === "list" && !waiting) {
				for (const phase of state.phases) {
					for (const item of phase.items) {
						const { estimate } = item;
						const due = dueAt(item, now, facts.waits);
						if (due === undefined || estimate.kind === "missing") continue;
						if (pending.has(estimate.budgetId) || facts.overtimeWarned.has(estimate.budgetId)) continue;
						if (due > now) {
							if (nextDeadline === undefined || due < nextDeadline) nextDeadline = due;
							continue;
						}
						const elapsedMs = elapsedOf(item.progress, now, facts.waits);
						const details = { budgetId: estimate.budgetId, title: item.title, estimatedMinutes: estimate.minutes, elapsedMs };
						try {
							const notice = deltas.atPrompt(binding.ctx, {
								kind: "text",
								body: overtimeBody(item.title, phase.name, due, now),
							});
							if (notice === undefined) continue;
							pending.add(estimate.budgetId);
							pi.sendMessage(
								{ ...notice.message, customType: OVERTIME_TYPE, display: true, details },
								binding.ctx.isIdle() ? { triggerTurn: false } : { deliverAs: "aside" },
							);
						} catch (error) {
							pending.delete(estimate.budgetId);
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
					reschedule(binding);
				},
				Math.min(MAX_TIMEOUT_MS, Math.max(1, nextDeadline - Date.now())),
			);
			binding.timer = { handle, deadline: nextDeadline };
		} catch (error) {
			pi.logger.warn("todo-ng overtime warning failed", { error: errorText(error) });
		}
	};
	let queued = false;
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
		const binding: DeadlineBinding = { ctx, session };
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
	pi.on("turn_start", () => deltas.turnStarted());
	pi.on("session_shutdown", stop);
}
