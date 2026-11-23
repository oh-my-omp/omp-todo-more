import type { AgentSession, ExtensionAPI, ExtensionContext, SessionManager, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { defineStatefulHarnessHandoff, registerCompactHandoff } from "../omomp-shared/compact-handoff.ts";
import { type BranchFacts, branchFacts, foldBranch } from "./branch.ts";
import { liveState } from "./commit.ts";
import { errorText } from "./errors.ts";
import { currentTimeLine, formatCompactView, formatFullView } from "./format.ts";
import { worktreeScope } from "./git.ts";
import { projectConfigProblem, readProjectConfig } from "./project-config.ts";
import { parentCwdOf, sessionOf } from "./session.ts";
import { readSettings } from "./settings.ts";
import { explanationValue, PLANNING_DELIVERY_TYPE, roundOf, semanticStateKey, type TodoNgState } from "./state.ts";
import { previewTodo } from "./tool.ts";

export const PLANNING_SOURCE = "omp-todo-ng/planning";

const SUPERSEDE_LINE = `This reminder supersedes every earlier reminder from ${PLANNING_SOURCE}; only this one applies.`;

const INIT_REMINDER =
	"Todo is empty. Work phase (this request changes files, config, git or external state): before the first change, call todo with goal ({ title, summary, acceptance }) and add ([{ phase, title, detail, minutes }]) for every step. Estimate each item in positive integer minutes (<= leafMaxMinutes, default 60). edit is blocked until todo succeeds and the list has items. Non-work phase (discussion, investigation, explanation, answering questions): no todo.";

const CLOSED_REMINDER =
	"Every item of this todo round is completed or abandoned, so the round is over. Work phase (this request changes files, config, git or external state): before the next change, start a new todo with goal ({ title, summary, acceptance }) and add ([{ phase, title, detail, minutes }]) for every step; it replaces the finished round, whose goal and items are not carried over. edit is blocked until the new round has open items. Non-work phase (discussion, investigation, explanation, answering questions): no todo.";

function noOpenItems(state: TodoNgState): string | undefined {
	const round = roundOf(state);
	switch (round) {
		case "empty":
			return INIT_REMINDER;
		case "closed":
			return CLOSED_REMINDER;
		case "open":
			return undefined;
		default: {
			const unreachable: never = round;
			throw new Error(`Unexpected todo round: ${String(unreachable)}`);
		}
	}
}

const COMPACT_PREAMBLE =
	"Discussion, investigation, explanation and questions add no items. Check that this todo matches your current plan and latest user instructions. Batch updates (goal, add, explain, estimate, start_id, done_id, drop_ids) in one todo call wherever they disagree; do not omit or narrow work. Budgets are forecasts, not permission to reduce scope or quality.";

const FULL_SNAPSHOT_LINE =
	"Full todo snapshot restored after context compaction or branch transition (includes all completed and abandoned items).";

const FULL_PREAMBLE = `${FULL_SNAPSHOT_LINE} ${COMPACT_PREAMBLE}`;

type Reminder = { readonly key: string; readonly body: string };

function changedPendingExplanations(seen: TodoNgState | undefined, current: TodoNgState): Set<string> {
	const changed = new Set<string>();
	if (seen === undefined || seen.kind === "empty" || current.kind === "empty") return changed;
	const previous = new Map<string, string | null>();
	for (const phase of seen.phases) for (const item of phase.items) previous.set(item.id, explanationValue(item.explanation));
	for (const phase of current.phases) {
		for (const item of phase.items) {
			if (item.progress.status !== "pending") continue;
			const before = previous.get(item.id);
			const after = explanationValue(item.explanation);
			if (before !== undefined && after !== null && before !== after) changed.add(item.id);
		}
	}
	return changed;
}

function ownSession(ctx: ExtensionContext): AgentSession {
	const session = sessionOf(ctx.agent.id);
	if (session === undefined) throw new Error(`No session is registered for agent ${ctx.agent.id}`);
	return session;
}

function deliver(session: AgentSession, delivered: string | null, reminder: Reminder): string {
	session.sessionManager.appendCustomEntry(PLANNING_DELIVERY_TYPE, { key: reminder.key });
	const supersede = delivered === null ? "" : `${SUPERSEDE_LINE}\n\n`;
	return `<system-reminder source="${PLANNING_SOURCE}">\n${supersede}${reminder.body}\n</system-reminder>`;
}

type Moment = { readonly now: number; readonly facts: BranchFacts; readonly state: TodoNgState; readonly key: string };

function momentOf(session: AgentSession): Moment {
	const now = Date.now();
	const facts = branchFacts(session.sessionManager);
	const state = liveState(session);
	return { now, facts, state, key: semanticStateKey(state, now, facts.waits) };
}

function recovery({ now, facts, state, key }: Moment): Reminder {
	const round = roundOf(state);
	switch (round) {
		case "empty":
			return { key, body: `${currentTimeLine(now)}\n${INIT_REMINDER}` };
		case "closed":
			return { key, body: formatFullView(state, now, facts.waits, { preamble: `${FULL_SNAPSHOT_LINE} ${CLOSED_REMINDER}` }) };
		case "open":
			return { key, body: formatFullView(state, now, facts.waits, { preamble: FULL_PREAMBLE }) };
		default: {
			const unreachable: never = round;
			throw new Error(`Unexpected todo round: ${String(unreachable)}`);
		}
	}
}

function listReminder({ now, facts, state, key }: Moment): Reminder | undefined {
	if (state.kind === "empty") {
		return facts.planning.delivered === "empty" ? undefined : { key, body: `${currentTimeLine(now)}\n${INIT_REMINDER}` };
	}
	if (roundOf(state) === "closed") return { key, body: `${currentTimeLine(now)}\n${CLOSED_REMINDER}` };
	const body = formatCompactView(state, now, facts.waits, {
		preamble: COMPACT_PREAMBLE,
		highlightExplanations: changedPendingExplanations(facts.planning.seen?.state, state),
	});
	return { key, body };
}

export function registerPlanning(pi: ExtensionAPI): void {
	let batch: string | undefined;
	const pending = new WeakMap<SessionManager, TodoNgState>();
	const settled = (ctx: ExtensionContext): void => {
		const session = sessionOf(ctx.agent.id);
		if (session !== undefined) pending.delete(session.sessionManager);
	};

	pi.on("before_agent_start", (event, ctx) => {
		if (event.reason === "revive") return;
		try {
			const session = ownSession(ctx);
			const moment = momentOf(session);
			const { planning } = moment.facts;
			const reminder = !planning.recovered ? recovery(moment) : moment.key === planning.delivered ? undefined : listReminder(moment);
			if (reminder === undefined) return;
			return {
				message: {
					customType: PLANNING_SOURCE,
					content: deliver(session, planning.delivered, reminder),
					display: false as const,
					attribution: "agent" as const,
				},
			};
		} catch (error) {
			pi.logger.warn("todo-ng user-message reminder failed", { error: errorText(error) });
		}
	});
	pi.on("tool_call", async (event, ctx) => {
		try {
			switch (event.toolName) {
				case "todo": {
					const session = ownSession(ctx);
					const manager = session.sessionManager;
					const settings = await readSettings(pi, ctx);
					const project = readProjectConfig(pi.logger, ctx.cwd);
					const preview = previewTodo(branchFacts(manager), pending.get(manager) ?? liveState(session), event.input, {
						leafMaxMinutes: settings.leafMaxMinutes,
						project,
						scope: worktreeScope(manager.getCwd(), parentCwdOf(ctx)()),
					});
					if (preview.kind === "state") pending.set(manager, preview.state);
					return undefined;
				}
				case "edit": {
					const project = readProjectConfig(pi.logger, ctx.cwd);
					switch (project.kind) {
						case "invalid":
							return { block: true, reason: `${projectConfigProblem(project)}. Fix the file before retrying edit.` };
						case "ok":
							if (!project.config.effects.editGate) return undefined;
							break;
						default: {
							const unreachable: never = project;
							throw new Error(`Unexpected project config state: ${String(unreachable)}`);
						}
					}
					const session = ownSession(ctx);
					const reason = noOpenItems(pending.get(session.sessionManager) ?? liveState(session));
					return reason === undefined ? undefined : { block: true, reason };
				}
				default:
					return undefined;
			}
		} catch (error) {
			pi.logger.warn("todo-ng planning gate failed", { tool: event.toolName, error: errorText(error) });
			if (event.toolName !== "edit") return undefined;
			return {
				block: true,
				reason: "Cannot read the todo list. Resolve the todo state before retrying edit.",
			} satisfies ToolCallEventResult;
		}
	});
	pi.on("tool_result", (event, ctx) => {
		settled(ctx);
		try {
			const session = ownSession(ctx);
			const moment = momentOf(session);
			const { planning } = moment.facts;
			let reminder: Reminder | undefined;
			if (!planning.recovered) reminder = recovery(moment);
			else if (event.toolName === "todo" && event.isError !== true) batch = moment.key;
			else if (moment.key !== batch && moment.key !== planning.seen?.key) reminder = listReminder(moment);
			if (reminder === undefined) return undefined;
			batch = reminder.key;
			return { additionalContext: deliver(session, planning.delivered, reminder) };
		} catch (error) {
			pi.logger.warn("todo-ng todo snapshot reminder failed", { error: errorText(error) });
		}
	});
	pi.on("turn_start", (_event, ctx) => {
		settled(ctx);
		batch = undefined;
	});
	pi.on("turn_end", (_event, ctx) => settled(ctx));

	registerCompactHandoff(
		pi,
		defineStatefulHarnessHandoff({
			pluginId: "omp-todo-ng",
			captureState(compactCtx) {
				const agentId = compactCtx.extensionCtx?.agent?.id;
				const session = agentId !== undefined ? sessionOf(agentId) : undefined;
				const state = session ? liveState(session) : foldBranch(compactCtx.branchEntries).state;
				if (state.kind === "empty") return null;
				return {
					phases: state.phases.length,
					items: state.phases.reduce((sum, phase) => sum + phase.items.length, 0),
				};
			},
			renderCompactPromptClaim(s) {
				return `\`omp-todo-ng\` (\`source="${PLANNING_SOURCE}"\`) owns the active todo list (${s.phases} phases, ${s.items} items) and automatically restores the full todo snapshot (\`FULL_PREAMBLE\`, including completed, abandoned, in-progress and pending items plus todo rules) on the first turn after compaction — NEVER summarize todo items, time budgets, or todo rules.`;
			},
			renderPostCompactInjection() {
				return { source: PLANNING_SOURCE, delivery: "plugin-managed" };
			},
		}),
	);
}
