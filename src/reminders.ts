import { z } from "@oh-my-pi/omptype/zod";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext, MessageRenderer, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { Text } from "@oh-my-pi/pi-coding-agent";
import { EAGER_TODO_PRELUDE_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/todo-tracker";
import { cfgTodoEnabled, cfgTodoReminders, cfgTodoRemindersMax } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { type NativeNode, node, span } from "@oh-my-pi/pi-tui";
import { isSilentAbort, isUserInterruptAbort } from "@oh-my-pi/pi-tui/chat/messages";
import { escapeXmlText } from "@oh-my-pi/pi-utils";
import { deferDuringCompaction, isCompacting } from "../omomp-shared/compact-handoff.ts";
import { tr } from "../omomp-shared/i18n.ts";
import { type BranchFacts, type BranchSource, branchFacts, foldBranch } from "./branch.ts";
import { liveState } from "./commit.ts";
import { errorText } from "./errors.ts";
import { currentTimeLine, itemTimeSummary } from "./format.ts";
import { type CutOffWait, cutOffWait, quotaDeadline, quotaNoticeLine } from "./quota-wait.ts";
import { sessionOf } from "./session.ts";
import {
	type AskWait,
	actionableItems,
	explanationText,
	goalLines,
	REMINDER_TYPE,
	type TodoItem,
	type TodoMoreState,
	unexplainedItems,
} from "./state.ts";

const HOST_MID_RUN_NUDGE_TYPE = "mid-run-todo-nudge";
const GOAL_MODE_CONTEXT_TYPE = "goal-mode-context";
const TODO_TOOL = "todo";
const CUT_OFF_GRACE_MS = 10_000;
const MAX_TIMER_SEGMENT_MS = 60 * 60_000;
const DRAFT_RECHECK_MS = 10_000;
const QUOTA_NOTICE_WIDGET_KEY = "todo-more.quota-reminder";
const CANCEL_SHORTCUT = "ctrl+n";
const CANCEL_SHORTCUT_LABEL = "Ctrl+N";
const CANCEL_COMMAND = "todo-more-cancel";

const HOST_STOP_REMINDER_RE =
	/^<system-reminder>\nYou stopped with \d+ incomplete todo item\(s\):\n[\s\S]*\n\nPlease continue working on these tasks or mark them complete if finished\.\n\(Reminder (\d+)\/(\d+)\)\n<\/system-reminder>$/;
const HOST_GOAL_TODO_CONTEXT = "\n<todo_context>\nPersisted todos:";
const HOST_FORCED_EAGER_MARKER = "You MUST call";

type ListState = Extract<TodoMoreState, { kind: "list" }>;
type OpenItem = { readonly phase: string; readonly item: TodoItem };

const reminderDetailsSchema = z.object({
	items: z.array(z.object({ phase: z.string(), title: z.string() })),
	attempt: z.number(),
	max: z.number(),
});
type ReminderDetails = z.infer<typeof reminderDetailsSchema>;

type Completion = { readonly kind: "silent" } | { readonly kind: "remind"; readonly text: string; readonly details: ReminderDetails };

const SILENT: Completion = { kind: "silent" };

type CutOffLatch = { readonly kind: "open" } | { readonly kind: "nudged"; readonly text: string } | { readonly kind: "cancelled" };

const LATCH_OPEN: CutOffLatch = { kind: "open" };
const LATCH_CANCELLED: CutOffLatch = { kind: "cancelled" };

type CutOffPlan = {
	readonly ctx: ExtensionContext;
	readonly session: AgentSession;
	readonly wait: CutOffWait;
};
type PendingCutOff = CutOffPlan & { readonly timer: Timer };

type CutOffStep =
	| { readonly kind: "wait"; readonly ms: number }
	| { readonly kind: "drop" }
	| { readonly kind: "remind"; readonly completion: Extract<Completion, { kind: "remind" }> };

const DROP: CutOffStep = { kind: "drop" };

const ownSession = (ctx: ExtensionContext): AgentSession | undefined => sessionOf(ctx.agent.id);

function todoToolRef(session: AgentSession): string {
	const tool = session.getToolByName(TODO_TOOL);
	return typeof tool?.customWireName === "string" ? tool.customWireName : TODO_TOOL;
}

function goalBlock(state: ListState): string[] {
	switch (state.goal.kind) {
		case "set":
			return ["Goal:", ...goalLines(state.goal.goal).map((line) => `  ${line}`)];
		case "missing":
			return ["Goal: none yet — pass goal ({ title, summary, acceptance }) on the next todo call."];
		default: {
			const unreachable: never = state.goal;
			throw new Error(`Unexpected goal state: ${String(unreachable)}`);
		}
	}
}

function unexplainedLines(state: ListState): string[] {
	const unexplained = unexplainedItems(state);
	if (unexplained.length === 0) return [];
	return [
		`Items without an explanation (${unexplained.length}); pass explain: ${unexplained.map((item) => JSON.stringify(item.id)).join(", ")}`,
	];
}

function byPhase(open: readonly OpenItem[]): { readonly name: string; readonly items: TodoItem[] }[] {
	const groups: { name: string; items: TodoItem[] }[] = [];
	for (const { phase, item } of open) {
		const last = groups.at(-1);
		if (last !== undefined && last.name === phase) last.items.push(item);
		else groups.push({ name: phase, items: [item] });
	}
	return groups;
}

function reminderText(
	state: ListState,
	open: readonly OpenItem[],
	attempt: number,
	max: number,
	now: number,
	waits: readonly AskWait[],
): string {
	const todoList = byPhase(open)
		.map(
			(phase) =>
				`- ${phase.name}\n${phase.items
					.map((item) => {
						const time = itemTimeSummary(item, now, waits, "inline");
						return `  - [${item.id}] ${item.title}\n    ${explanationText(item).replaceAll("\n", "\n    ")}${time === undefined ? "" : `\n    ${time}`}`;
					})
					.join("\n")}`,
		)
		.join("\n");
	return (
		`<system-reminder>\n` +
		`${currentTimeLine(now)}\n` +
		`You stopped with ${open.length} incomplete todo item(s):\n${todoList}\n\n` +
		`${[...goalBlock(state), ...unexplainedLines(state)].join("\n")}\n\n` +
		`Please continue working on these tasks or mark them complete if finished.\n` +
		`(Reminder ${attempt}/${max})\n` +
		`</system-reminder>`
	);
}

function reminderDetails(open: readonly OpenItem[], attempt: number, max: number): ReminderDetails {
	return { items: open.map(({ phase, item }) => ({ phase, title: item.title })), attempt, max };
}

function eagerTodoText(todo: string, forced: boolean, now: number): string {
	const body = forced
		? `Before substantive work, create a phased todo.

You MUST call \`${todo}\` first in this turn.
You MUST initialize the entire todo list in one call with \`goal\` ({ title, summary, acceptance }) and \`add\` ([{ phase, title, detail, minutes }]).
You MUST cover the entire request from investigation through implementation and verification — not just the immediate next step.
Each title MUST be a concise, specific 5-10 word label; each detail says what the item covers and what shows it is finished. Estimate every item yourself in positive integer minutes (<= leafMaxMinutes, default 60).

After \`${todo}\` succeeds, continue the request in the same turn.
NEVER call \`${todo}\` again unless task state has materially changed.`
		: `If this request is work (it changes files, config, git or external state), call \`${todo}\` first with \`goal\` ({ title, summary, acceptance }) and \`add\` ([{ phase, title, detail, minutes }]); discussion, investigation, explanation and questions need no todo. Cover the whole request — investigation through implementation and verification — not just the next step.
Use specific titles, complete details, and your own positive integer minute estimates (<= leafMaxMinutes, default 60).
If you create the list, continue the request in the same turn and avoid re-calling \`${todo}\` unless task state materially changes.`;
	return `<system-reminder>\n${currentTimeLine(now)}\n${body}\n</system-reminder>\n`;
}

function midRunNudgeText(todo: string, incompleteCount: number, state: ListState, now: number, waits: readonly AskWait[]): string {
	const goal =
		state.goal.kind === "set"
			? `Goal objective: ${state.goal.goal.objective}`
			: `The list has no goal yet: pass \`goal\` on the next \`${todo}\` call.`;
	const active = state.phases.flatMap((phase) => phase.items).find((item) => item.progress.status === "in_progress");
	const activeTime = active === undefined ? undefined : itemTimeSummary(active, now, waits, "inline");
	const activeLine =
		active === undefined
			? ""
			: `\nActive item: [${active.id}] ${JSON.stringify(active.title)}${activeTime === undefined ? "" : ` (${activeTime})`}`;
	return `<system-reminder>
${currentTimeLine(now)}
${incompleteCount} todo item${incompleteCount !== 1 ? "s" : ""} still open. If you finished a task since last \`${todo}\` update, mark it done with \`done_id\` now so progress stays visible; otherwise keep working.
${goal}${activeLine}
</system-reminder>
`;
}

function sanitizeGoalTodoText(text: string): string {
	return (
		escapeXmlText(text)
			.replace(/\r\n/g, "\\n")
			.replace(/\r/g, "\\r")
			.replace(/\n/g, "\\n")
			.replace(/\t/g, "\\t")
			// biome-ignore lint/suspicious/noControlCharactersInRegex: upstream flattens control characters.
			.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
	);
}

function goalTodoContext(session: AgentSession, state: TodoMoreState, now: number, waits: readonly AskWait[]): string | undefined {
	const canCallTodoTool = session.getActiveToolNames().includes(TODO_TOOL);
	if (!canCallTodoTool) return undefined;
	if (state.kind === "empty") return undefined;
	const phases = state.phases.filter((phase) => phase.items.length > 0);
	if (phases.length === 0) return undefined;

	let total = 0;
	let closed = 0;
	let open = 0;
	const phaseLines = phases.flatMap((phase) => [
		`- ${sanitizeGoalTodoText(phase.name)}`,
		...phase.items.map((item) => {
			total++;
			if (item.progress.status === "completed" || item.progress.status === "abandoned") {
				closed++;
			} else {
				open++;
			}
			const time = itemTimeSummary(item, now, waits, "inline");
			const timeSuffix = time === undefined ? "" : `; ${sanitizeGoalTodoText(time)}`;
			return `  - [${item.progress.status}] [${sanitizeGoalTodoText(item.id)}] ${sanitizeGoalTodoText(item.title)}: ${sanitizeGoalTodoText(explanationText(item))}${timeSuffix}`;
		}),
	]);
	const goal =
		state.goal.kind === "set"
			? goalLines(state.goal.goal).map((line) => sanitizeGoalTodoText(line))
			: [`Goal: none yet — pass \`goal\` on the next \`${todoToolRef(session)}\` call.`];

	return `<todo_context>
${currentTimeLine(now)}
Persisted todos: live progress state for current goal, not old transcript decoration; goal continuations lack visible user nudge → treat as live state.
Before substantial work: compare next action with todos. If item stale, already finished, or no longer active pointer, call \`${todoToolRef(session)}\` first: pass \`done_id\`, \`start_id\`, or \`add\`. Do not leave stale in_progress while working on later phases.

Todo list goal:
${goal.join("\n")}

Overall: ${closed}/${total} done, ${open} open.
${phaseLines.join("\n")}
</todo_context>
`;
}

type HostReminder =
	| { readonly kind: "stop"; readonly attempt: number; readonly max: number }
	| { readonly kind: "nudge" }
	| { readonly kind: "eager"; readonly forced: boolean }
	| { readonly kind: "goal" };

function textOf(content: string | readonly { readonly type: string; readonly text?: string }[]): string {
	if (typeof content === "string") return content;
	return content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

function hostReminderOf(message: AgentMessage): HostReminder | undefined {
	if (message.role === "developer") {
		const match = HOST_STOP_REMINDER_RE.exec(textOf(message.content));
		return match === null ? undefined : { kind: "stop", attempt: Number(match[1]), max: Number(match[2]) };
	}
	if (message.role !== "custom") return undefined;
	switch (message.customType) {
		case HOST_MID_RUN_NUDGE_TYPE:
			return { kind: "nudge" };
		case EAGER_TODO_PRELUDE_MESSAGE_TYPE:
			return { kind: "eager", forced: textOf(message.content).includes(HOST_FORCED_EAGER_MARKER) };
		case GOAL_MODE_CONTEXT_TYPE:
			return textOf(message.content).includes(HOST_GOAL_TODO_CONTEXT) ? { kind: "goal" } : undefined;
		default:
			return undefined;
	}
}

function entryIndexOf(entries: readonly SessionEntry[], message: AgentMessage): number {
	if (message.role === "developer") {
		return entries.findIndex(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "developer" &&
				entry.message.timestamp === message.timestamp &&
				Bun.deepEquals(entry.message.content, message.content),
		);
	}
	if (message.role !== "custom") return -1;
	return entries.findIndex(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === message.customType &&
			Date.parse(entry.timestamp) >= message.timestamp &&
			Bun.deepEquals(entry.content, message.content),
	);
}

const factsAtEntries = new WeakMap<BranchSource, Map<string, Pick<BranchFacts, "state" | "waits">>>();

function factsAtEntry(manager: BranchSource, entries: readonly SessionEntry[], index: number): Pick<BranchFacts, "state" | "waits"> {
	const entry = entries[index];
	if (entry === undefined) throw new Error(`No branch entry at ${index}`);
	let byId = factsAtEntries.get(manager);
	if (byId === undefined) {
		byId = new Map();
		factsAtEntries.set(manager, byId);
	}
	let entryFacts = byId.get(entry.id);
	if (entryFacts === undefined) {
		const folded = foldBranch(entries.slice(0, index + 1));
		entryFacts = { state: folded.state, waits: folded.waits };
		byId.set(entry.id, entryFacts);
	}
	return entryFacts;
}

function pluginContent(
	reminder: HostReminder,
	message: AgentMessage,
	session: AgentSession,
	state: TodoMoreState,
	waits: readonly AskWait[],
	now: number,
): string | undefined {
	switch (reminder.kind) {
		case "eager":
			return eagerTodoText(todoToolRef(session), reminder.forced, now);
		case "stop": {
			if (state.kind === "empty") return undefined;
			const open = actionableItems(state);
			return open.length === 0 ? undefined : reminderText(state, open, reminder.attempt, reminder.max, now, waits);
		}
		case "nudge": {
			if (state.kind === "empty") return undefined;
			const open = actionableItems(state);
			return open.length === 0 ? undefined : midRunNudgeText(todoToolRef(session), open.length, state, now, waits);
		}
		case "goal": {
			if (message.role !== "custom") return undefined;
			const text = textOf(message.content);
			const index = text.indexOf(HOST_GOAL_TODO_CONTEXT, Math.max(0, text.lastIndexOf("</goal_context>")));
			const block = goalTodoContext(session, state, now, waits);
			return index < 0 || block === undefined ? undefined : `${text.slice(0, index)}\n${block}`;
		}
		default: {
			const unreachable: never = reminder;
			throw new Error(`Unexpected host reminder: ${String(unreachable)}`);
		}
	}
}

function withContent(message: AgentMessage, text: string): AgentMessage {
	if (message.role === "developer") return { ...message, content: [{ type: "text", text }] };
	if (message.role === "custom") return { ...message, content: text };
	return message;
}

export function contextMessages(messages: AgentMessage[], session: AgentSession | undefined): AgentMessage[] | undefined {
	if (session === undefined) return undefined;
	const manager = session.sessionManager;
	let entries: readonly SessionEntry[] | undefined;
	let current: TodoMoreState | undefined;
	let currentWaits: readonly AskWait[] | undefined;
	let rewritten: AgentMessage[] | undefined;
	for (const [index, message] of messages.entries()) {
		const reminder = hostReminderOf(message);
		if (reminder === undefined) continue;
		entries ??= manager.getBranchView();
		const at = entryIndexOf(entries, message);
		let state: TodoMoreState;
		let waits: readonly AskWait[];
		if (at < 0) {
			current ??= liveState(session);
			currentWaits ??= branchFacts(manager).waits;
			state = current;
			waits = currentWaits;
		} else {
			const entryFacts = factsAtEntry(manager, entries, at);
			state = entryFacts.state;
			waits = entryFacts.waits;
		}
		const now = "timestamp" in message && typeof message.timestamp === "number" && message.timestamp > 0 ? message.timestamp : Date.now();
		const text = pluginContent(reminder, message, session, state, waits, now);
		if (text === undefined) continue;
		rewritten ??= [...messages];
		rewritten[index] = withContent(message, text);
	}
	return rewritten;
}

class NativeReminderText extends Text {
	constructor(
		text: string,
		private readonly header: string,
	) {
		super(text, 0, 0);
	}

	override describe(): NativeNode {
		return node("card", { role: "todo-more.reminder", tone: "warning", head: [span(this.header, "strong")] });
	}
}

function reminderHeader({ items, attempt, max }: ReminderDetails): string {
	const count = items.length;
	return tr(
		`${count} incomplete ${count === 1 ? "todo" : "todos"} - reminder ${attempt}/${max}`,
		`${count} 个待办未完成 - 提醒 ${attempt}/${max}`,
	);
}

export const renderReminder: MessageRenderer = (message, _options, theme) => {
	const parsed = reminderDetailsSchema.safeParse(message.details);
	if (!parsed.success) return undefined;
	const header = reminderHeader(parsed.data);
	return new NativeReminderText(theme.fg("warning", `${theme.icon.warning} ${header}`), header);
};

function cutOffAnswer(message: AgentMessage | undefined): AssistantMessage | undefined {
	if (message?.role !== "assistant") return undefined;
	switch (message.stopReason) {
		case "aborted":
			return isUserInterruptAbort(message) || isSilentAbort(message) ? undefined : message;
		case "error":
		case "toolUse":
			return message;
		default:
			return undefined;
	}
}

export function continuation(
	session: Pick<AgentSession, "getPlanModeState" | "settings" | "getActiveToolNames" | "wakeSources" | "sessionManager" | "getTodoPhases">,
): Completion {
	if (session.getPlanModeState()?.enabled === true) return SILENT;
	if (!cfgTodoEnabled.get(session.settings) || !cfgTodoReminders.get(session.settings)) return SILENT;
	if (!session.getActiveToolNames().includes(TODO_TOOL)) return SILENT;
	const branch = branchFacts(session.sessionManager);
	const max = cfgTodoRemindersMax.get(session.settings);
	if (branch.remindersSinceUserMessage >= max) return SILENT;
	const state = liveState(session);
	if (state.kind === "empty") return SILENT;
	const open = actionableItems(state);
	if (open.length === 0) return SILENT;
	if (session.wakeSources !== undefined) return SILENT;
	const attempt = branch.remindersSinceUserMessage + 1;
	return {
		kind: "remind",
		text: reminderText(state, open, attempt, max, Date.now(), branch.waits),
		details: reminderDetails(open, attempt, max),
	};
}

export function registerReminders(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(REMINDER_TYPE, renderReminder);

	let cutOff: PendingCutOff | undefined;
	let latch: CutOffLatch = LATCH_OPEN;
	const clearCutOff = (): void => {
		if (cutOff === undefined) return;
		const { ctx, timer, wait } = cutOff;
		cutOff = undefined;
		ctx.clearTimer(timer);
		if (wait.kind === "quota" && ctx.hasUI) ctx.ui.setWidget(QUOTA_NOTICE_WIDGET_KEY, undefined);
	};
	const nextStep = ({ ctx, session, wait }: CutOffPlan): CutOffStep => {
		if (ownSession(ctx) !== session) return DROP;
		if (wait.kind === "quota") {
			const left = quotaDeadline(wait) - Date.now();
			if (left > 0) return { kind: "wait", ms: Math.min(left, MAX_TIMER_SEGMENT_MS) };
		}
		if (latch.kind !== "open") return DROP;
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return DROP;
		if (ctx.hasUI && ctx.ui.getEditorText().trim() !== "") return wait.kind === "quota" ? { kind: "wait", ms: DRAFT_RECHECK_MS } : DROP;
		const completion = continuation(session);
		return completion.kind === "remind" ? { kind: "remind", completion } : DROP;
	};
	const schedule = (plan: CutOffPlan, ms: number): void => {
		const pending: PendingCutOff = { ...plan, timer: plan.ctx.setTimeout(() => fire(pending), ms) };
		cutOff = pending;
	};
	const fire = (pending: PendingCutOff): void => {
		if (cutOff !== pending) return;
		if (isCompacting(pending.session.sessionManager)) {
			deferDuringCompaction(pending.session.sessionManager, "omp-todo-more:cut-off-reminder", () => {
				if (cutOff === pending) fire(pending);
			});
			return;
		}
		let waiting = false;
		try {
			const step = nextStep(pending);
			switch (step.kind) {
				case "wait":
					schedule(pending, step.ms);
					waiting = true;
					return;
				case "drop":
					return;
				case "remind": {
					clearCutOff();
					const { completion } = step;
					latch = { kind: "nudged", text: completion.text };
					pi.sendMessage<ReminderDetails>(
						{ customType: REMINDER_TYPE, content: completion.text, display: true, details: completion.details, attribution: "agent" },
						{ deliverAs: "nextTurn", triggerTurn: true },
					);
					return;
				}
				default: {
					const unreachable: never = step;
					throw new Error(`Unexpected cut-off step: ${String(unreachable)}`);
				}
			}
		} catch (error) {
			pi.logger.warn("todo-more cut-off reminder failed", { error: errorText(error) });
		} finally {
			if (!waiting && cutOff === pending) clearCutOff();
		}
	};
	const armCutOff = (ctx: ExtensionContext, session: AgentSession, message: AssistantMessage): void => {
		clearCutOff();
		const wait = cutOffWait(message, Date.now());
		const plan: CutOffPlan = { ctx, session, wait };
		switch (wait.kind) {
			case "grace":
				schedule(plan, CUT_OFF_GRACE_MS);
				return;
			case "quota":
				if (ctx.hasUI) {
					ctx.ui.setWidget(QUOTA_NOTICE_WIDGET_KEY, [quotaNoticeLine(wait, CANCEL_SHORTCUT_LABEL, CANCEL_COMMAND)], {
						placement: "aboveEditor",
					});
				}
				schedule(plan, Math.min(quotaDeadline(wait) - Date.now(), MAX_TIMER_SEGMENT_MS));
				return;
			default: {
				const unreachable: never = wait;
				throw new Error(`Unexpected cut-off wait: ${String(unreachable)}`);
			}
		}
	};
	const cancelByHuman = (): boolean => {
		if (cutOff === undefined) return false;
		clearCutOff();
		latch = LATCH_CANCELLED;
		return true;
	};
	const resetCutOffChain = (): void => {
		clearCutOff();
		latch = LATCH_OPEN;
	};
	pi.on("agent_start", () => clearCutOff());
	pi.on("session_shutdown", () => clearCutOff());
	pi.on("session_switch", () => resetCutOffChain());
	pi.on("session_branch", () => resetCutOffChain());
	pi.on("session_tree", () => resetCutOffChain());
	pi.registerShortcut(CANCEL_SHORTCUT, {
		description: tr("Cancel the pending Todo More reminder", "取消待发的 Todo More 提醒"),
		handler: () => {
			cancelByHuman();
		},
	});
	pi.registerCommand(CANCEL_COMMAND, {
		description: tr("Cancel the pending Todo More reminder", "取消待发的 Todo More 提醒"),
		handler: async (_args: string, ctx: ExtensionContext) => {
			const cancelled = cancelByHuman();
			if (ctx.hasUI)
				ctx.ui.notify(
					cancelled ? tr("Todo reminder cancelled", "待办提醒已取消") : tr("No pending Todo reminder", "没有待发的待办提醒"),
					"info",
				);
		},
	});

	pi.on("agent_end", (event, ctx) => {
		try {
			if (event.willContinue === true || ctx.agent.kind !== "main") return;
			const session = ownSession(ctx);
			if (session === undefined) return;
			const message = cutOffAnswer(event.messages.at(-1));
			if (message === undefined || latch.kind !== "open") return;
			if (continuation(session).kind === "remind") armCutOff(ctx, session, message);
		} catch (error) {
			pi.logger.warn("todo-more cut-off check failed", { error: errorText(error) });
		}
	});

	pi.on("before_agent_start", (event) => {
		if (latch.kind !== "nudged" || event.prompt !== latch.text) latch = LATCH_OPEN;
	});

	pi.on("message_end", (event) => {
		const message = event.message;
		if (message.role === "toolResult" && !message.isError) latch = LATCH_OPEN;
	});

	pi.on("context", (event, ctx) => {
		try {
			const messages = contextMessages(event.messages, ownSession(ctx));
			return messages === undefined ? undefined : { messages };
		} catch (error) {
			pi.logger.warn("todo-more context failed", { error: errorText(error) });
			return undefined;
		}
	});
}
