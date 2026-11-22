import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, SessionEntry, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { type BranchSource, branchFacts, contextBranch, foldBranch } from "./branch.ts";
import { liveState } from "./commit.ts";
import { errorText } from "./errors.ts";
import { currentTimeLine, formatCompactView, formatFullView } from "./format.ts";
import { sessionOf } from "./session.ts";
import { readSettings } from "./settings.ts";
import { type AskWait, dueAtTime, EMPTY, snapshotToState, type TodoMoreState, todoMoreSnapshotSchema } from "./state.ts";
import { previewTodo } from "./tool.ts";

export const PLANNING_SOURCE = "omp-todo-more/planning";

const OPEN_TAG = `<system-reminder source="${PLANNING_SOURCE}">\n`;
const CLOSE_TAG = "\n</system-reminder>";
const SUPERSEDE_LINE = `This reminder supersedes every earlier reminder from ${PLANNING_SOURCE}; only this one applies.`;

const INIT_REMINDER =
	"Todo is empty. Work phase (this request changes files, config, git or external state): before the first change, call todo with goal ({ title, summary, acceptance }) and add ([{ phase, title, detail, minutes }]) for every step. Estimate each item in positive integer minutes (<= leafMaxMinutes, default 60). edit is blocked until todo succeeds and the list has items. Non-work phase (discussion, investigation, explanation, answering questions): no todo.";

const COMPACT_PREAMBLE =
	"Discussion, investigation, explanation and questions add no items. Check that this todo matches your current plan and latest user instructions. Batch updates (goal, add, explain, estimate, start_id, done_ids, drop_ids) in one todo call wherever they disagree; do not omit or narrow work. Budgets are forecasts, not permission to reduce scope or quality.";

const FULL_PREAMBLE =
	"Full todo snapshot restored after context compaction or branch transition (includes all completed and abandoned items). Discussion, investigation, explanation and questions add no items. Check that this todo matches your current plan and latest user instructions. Batch updates (goal, add, explain, estimate, start_id, done_ids, drop_ids) in one todo call wherever they disagree; do not omit or narrow work. Budgets are forecasts, not permission to reduce scope or quality.";

type CarrierContent = Extract<AgentMessage, { role: "custom" | "developer" }>["content"];

function extractPlanningInner(text: string): string | undefined {
	const start = text.lastIndexOf(OPEN_TAG);
	if (start < 0) return undefined;
	const end = text.indexOf(CLOSE_TAG, start + OPEN_TAG.length);
	if (end < 0) return undefined;
	return text.slice(start + OPEN_TAG.length, end);
}

function planningInnerFromContent(content: CarrierContent): string | undefined {
	if (typeof content === "string") return extractPlanningInner(content);
	const openSansNewline = OPEN_TAG.slice(0, -1);
	const texts: string[] = [];
	for (const block of content) {
		if (block.type === "text") texts.push(block.text);
	}
	for (const [index, text] of texts.entries()) {
		if (text.includes(OPEN_TAG) || (index < texts.length - 1 && text.endsWith(openSansNewline))) {
			return extractPlanningInner(texts.join("\n"));
		}
	}
	return undefined;
}

function messagePlanningInner(message: AgentMessage): string | undefined {
	if (message.role === "custom") {
		return message.customType === PLANNING_SOURCE ? planningInnerFromContent(message.content) : undefined;
	}
	if (message.role === "developer") {
		return message.attribution === "agent" ? planningInnerFromContent(message.content) : undefined;
	}
	return undefined;
}

function entryHasPlanning(entry: SessionEntry): boolean {
	if (entry.type === "custom_message") {
		return entry.customType === PLANNING_SOURCE && planningInnerFromContent(entry.content) !== undefined;
	}
	if (entry.type === "message") {
		return messagePlanningInner(entry.message) !== undefined;
	}
	return false;
}

function isEmptyReminderInner(inner: string): boolean {
	return inner.includes(INIT_REMINDER);
}

function renderReminder(body: string, supersede: boolean): string {
	const inner = supersede ? `${SUPERSEDE_LINE}\n\n${body}` : body;
	return `${OPEN_TAG}${inner}${CLOSE_TAG}`;
}

function emptyBody(now: number): string {
	return `${currentTimeLine(now)}\n${INIT_REMINDER}`;
}

function branchPath(entries: readonly SessionEntry[], leafId: string | null): SessionEntry[] {
	if (leafId === null || entries.length === 0) return [];
	const byId = new Map<string, SessionEntry>();
	for (const entry of entries) byId.set(entry.id, entry);
	const path: SessionEntry[] = [];
	const seen = new Set<string>();
	let current = byId.get(leafId);
	while (current !== undefined && !seen.has(current.id)) {
		seen.add(current.id);
		path.push(current);
		current = current.parentId === null ? undefined : byId.get(current.parentId);
	}
	path.reverse();
	return path;
}

function minuteBucket(ms: number | undefined): number | null {
	return ms === undefined ? null : Math.floor(ms / 60_000);
}

/**
 * Semantic identity of a todo state for delivery deduplication.
 * Ignores wall-clock `Current time:` ticks, internal `budgetId` UUIDs and raw `elapsedMs` jitter;
 * changes on goal/phase/title/status/explanation/estimate/due-minute/transition-minute/commit edits.
 */
export function semanticStateKey(state: TodoMoreState, now: number, waits: readonly AskWait[]): string {
	if (state.kind === "empty") return "empty";
	return JSON.stringify({
		goal: state.goal.kind === "set" ? state.goal.goal : null,
		phases: state.phases.map((phase) => ({
			name: phase.name,
			items: phase.items.map((item) => ({
				title: item.title,
				status: item.status,
				explanation: item.explanation.kind === "explained" ? item.explanation.text : null,
				timeMissing: item.time.kind === "missing",
				minutes: item.time.kind === "estimated" ? item.time.minutes : null,
				dueMinute: item.status === "in_progress" && item.time.kind === "estimated" ? minuteBucket(dueAtTime(item.time, now, waits)) : null,
				pausedAtMinute:
					item.status === "pending" &&
					(item.timestamps?.pausedAt !== undefined || (item.time.kind === "estimated" && item.time.elapsedMs > 0))
						? minuteBucket(item.timestamps?.pausedAt)
						: null,
				completedAtMinute: item.status === "completed" ? minuteBucket(item.timestamps?.completedAt) : null,
				abandonedAtMinute: item.status === "abandoned" ? minuteBucket(item.timestamps?.abandonedAt) : null,
				commitSha: item.commit?.sha ?? null,
			})),
		})),
	});
}

function changedPendingExplanations(previous: TodoMoreState | undefined, current: TodoMoreState): Set<string> {
	const changed = new Set<string>();
	if (previous === undefined || previous.kind === "empty" || current.kind === "empty") return changed;
	const prevExplanations = new Map<string, string | null>();
	for (const phase of previous.phases) {
		for (const item of phase.items) {
			prevExplanations.set(item.title, item.explanation.kind === "explained" ? item.explanation.text : null);
		}
	}
	for (const phase of current.phases) {
		for (const item of phase.items) {
			if (item.status !== "pending") continue;
			const prev = prevExplanations.get(item.title);
			const next = item.explanation.kind === "explained" ? item.explanation.text : null;
			if (prev !== undefined && next !== null && prev !== next) changed.add(item.title);
		}
	}
	return changed;
}

function todoResultState(message: AgentMessage): TodoMoreState | undefined {
	if (message.role !== "toolResult" || message.toolName !== "todo" || message.isError === true) return undefined;
	const details = message.details;
	if (typeof details !== "object" || details === null || !("more" in details)) return undefined;
	const parsed = todoMoreSnapshotSchema.safeParse((details as { more: unknown }).more);
	return parsed.success ? snapshotToState(parsed.data) : undefined;
}

type ContextSnapshot = {
	readonly hasPriorPlanning: boolean;
	readonly needsCompactionRecovery: boolean;
	readonly lastPlanningKind: "absent" | "empty" | "list";
	readonly lastPlanningState: TodoMoreState | undefined;
	readonly lastPlanningWaits: readonly AskWait[];
	readonly lastVisibleState: TodoMoreState | undefined;
	readonly lastVisibleWaits: readonly AskWait[];
};

function findBoundaryEntryIndex(path: readonly SessionEntry[], boundary: AgentMessage): number {
	const expectedType = boundary.role === "compactionSummary" ? "compaction" : "branch_summary";
	for (let i = path.length - 1; i >= 0; i--) {
		const entry = path[i]!;
		if (entry.type !== expectedType) continue;
		if (Date.parse(entry.timestamp) === boundary.timestamp) return i;
	}
	for (let i = path.length - 1; i >= 0; i--) {
		if (path[i]!.type === expectedType) return i;
	}
	return -1;
}

function inspectContext(ctx: ExtensionContext): ContextSnapshot {
	const sessions = ctx.sessionManager;
	const entries = sessions.getEntries();
	const leafId = sessions.getLeafId();
	const { messages } = buildSessionContext(entries, leafId, undefined, { model: ctx.model });
	const path = branchPath(entries, leafId);

	let latestBoundary: AgentMessage | undefined;
	let lastPlanningInner: string | undefined;
	let lastPlanningMessageIndex = -1;
	let lastTodoMessageIndex = -1;
	let lastTodoState: TodoMoreState | undefined;

	for (const [index, message] of messages.entries()) {
		if (message.role === "compactionSummary" || message.role === "branchSummary") {
			latestBoundary = message;
		}
		const inner = messagePlanningInner(message);
		if (inner !== undefined) {
			lastPlanningInner = inner;
			lastPlanningMessageIndex = index;
		}
		const todoState = todoResultState(message);
		if (todoState !== undefined) {
			lastTodoMessageIndex = index;
			lastTodoState = todoState;
		}
	}

	let needsCompactionRecovery = false;
	if (latestBoundary !== undefined) {
		const boundaryIdx = findBoundaryEntryIndex(path, latestBoundary);
		if (boundaryIdx >= 0) {
			const hasPostBoundaryPlanning = path.slice(boundaryIdx + 1).some(entryHasPlanning);
			needsCompactionRecovery = !hasPostBoundaryPlanning;
		} else {
			needsCompactionRecovery = lastPlanningInner === undefined;
		}
	}

	let lastPlanningState: TodoMoreState | undefined;
	let lastPlanningWaits: readonly AskWait[] = [];
	if (lastPlanningInner !== undefined) {
		if (isEmptyReminderInner(lastPlanningInner)) {
			lastPlanningState = EMPTY;
		} else {
			let lastPlanningEntryIdx = -1;
			for (let i = path.length - 1; i >= 0; i--) {
				if (entryHasPlanning(path[i]!)) {
					lastPlanningEntryIdx = i;
					break;
				}
			}
			if (lastPlanningEntryIdx >= 0) {
				const folded = foldBranch(path.slice(0, lastPlanningEntryIdx + 1));
				lastPlanningState = folded.state;
				lastPlanningWaits = folded.waits;
			}
		}
	}

	const lastPlanningKind: ContextSnapshot["lastPlanningKind"] =
		lastPlanningInner === undefined ? "absent" : isEmptyReminderInner(lastPlanningInner) ? "empty" : "list";

	let lastVisibleState: TodoMoreState | undefined;
	let lastVisibleWaits: readonly AskWait[] = [];
	if (lastTodoMessageIndex > lastPlanningMessageIndex && lastTodoState !== undefined) {
		lastVisibleState = lastTodoState;
		let lastTodoEntryIdx = -1;
		for (let i = path.length - 1; i >= 0; i--) {
			const entry = path[i]!;
			if (entry.type === "message" && todoResultState(entry.message) !== undefined) {
				lastTodoEntryIdx = i;
				break;
			}
		}
		lastVisibleWaits = lastTodoEntryIdx >= 0 ? foldBranch(path.slice(0, lastTodoEntryIdx + 1)).waits : [];
	} else if (lastPlanningState !== undefined) {
		lastVisibleState = lastPlanningState;
		lastVisibleWaits = lastPlanningWaits;
	}

	return {
		hasPriorPlanning: lastPlanningInner !== undefined,
		needsCompactionRecovery,
		lastPlanningKind,
		lastPlanningState,
		lastPlanningWaits,
		lastVisibleState,
		lastVisibleWaits,
	};
}

/**
 * The list as the host holds it right now. A `todo` result reaches the branch after the call returns, so the branch
 * lags the list at every point between a `todo` call's end and its persistence (`tool_result` of that call, the
 * `tool_call` of any later call); the host list does not.
 */
function currentList(ctx: ExtensionContext): TodoMoreState {
	const session = sessionOf(ctx.agent.id);
	if (session === undefined) throw new Error(`No session is registered for agent ${ctx.agent.id}`);
	return liveState(session);
}

type BatchDelivery = {
	readonly stateKey: string;
	readonly includesFullRecovery: boolean;
};

export function registerPlanning(pi: ExtensionAPI): void {
	let batch: BatchDelivery | undefined;
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
		const preview = previewTodo(facts, pending.get(branch) ?? currentList(ctx), input, settings.leafMaxMinutes);
		if (preview.kind === "state") pending.set(branch, preview.state);
	};
	const guardEdit = (ctx: ExtensionContext): ToolCallEventResult | undefined => {
		const branch = contextBranch(ctx);
		return (pending.get(branch) ?? currentList(ctx)).kind === "empty" ? { block: true, reason: INIT_REMINDER } : undefined;
	};

	const deliverAtPrompt = (ctx: ExtensionContext) => {
		const now = Date.now();
		const state = currentList(ctx);
		const waits = branchFacts(contextBranch(ctx)).waits;
		const snapshot = inspectContext(ctx);
		const stateKey = semanticStateKey(state, now, waits);

		if (snapshot.needsCompactionRecovery) {
			const body = state.kind === "empty" ? emptyBody(now) : formatFullView(state, now, waits, { preamble: FULL_PREAMBLE });
			return {
				message: {
					customType: PLANNING_SOURCE,
					content: renderReminder(body, snapshot.hasPriorPlanning),
					display: false as const,
					attribution: "agent" as const,
				},
			};
		}

		if (state.kind === "empty") {
			if (snapshot.lastPlanningKind === "empty") return undefined;
			return {
				message: {
					customType: PLANNING_SOURCE,
					content: renderReminder(emptyBody(now), snapshot.hasPriorPlanning),
					display: false as const,
					attribution: "agent" as const,
				},
			};
		}

		const lastPlanningKey =
			snapshot.lastPlanningState === undefined ? undefined : semanticStateKey(snapshot.lastPlanningState, now, snapshot.lastPlanningWaits);
		if (lastPlanningKey === stateKey) return undefined;

		const highlightExplanations = changedPendingExplanations(snapshot.lastVisibleState, state);
		const body = formatCompactView(state, now, waits, {
			preamble: COMPACT_PREAMBLE,
			...(highlightExplanations.size > 0 ? { highlightExplanations } : {}),
		});
		return {
			message: {
				customType: PLANNING_SOURCE,
				content: renderReminder(body, snapshot.hasPriorPlanning),
				display: false as const,
				attribution: "agent" as const,
			},
		};
	};

	const deliverAfterTools = (event: { toolName?: string; isError?: boolean }, ctx: ExtensionContext) => {
		const now = Date.now();
		const state = currentList(ctx);
		const waits = branchFacts(contextBranch(ctx)).waits;
		const snapshot = inspectContext(ctx);
		const stateKey = semanticStateKey(state, now, waits);

		if (snapshot.needsCompactionRecovery && !batch?.includesFullRecovery) {
			const body = state.kind === "empty" ? emptyBody(now) : formatFullView(state, now, waits, { preamble: FULL_PREAMBLE });
			batch = { stateKey, includesFullRecovery: true };
			return { additionalContext: renderReminder(body, snapshot.hasPriorPlanning) };
		}

		if (event.toolName === "todo" && event.isError !== true) {
			batch = { stateKey, includesFullRecovery: batch?.includesFullRecovery ?? false };
			return undefined;
		}

		if (batch?.stateKey === stateKey) return undefined;

		const lastVisibleKey =
			snapshot.lastVisibleState === undefined ? undefined : semanticStateKey(snapshot.lastVisibleState, now, snapshot.lastVisibleWaits);
		if (lastVisibleKey === stateKey) return undefined;

		if (state.kind === "empty") {
			if (snapshot.lastPlanningKind === "empty") return undefined;
			batch = { stateKey, includesFullRecovery: batch?.includesFullRecovery ?? false };
			return { additionalContext: renderReminder(emptyBody(now), snapshot.hasPriorPlanning) };
		}

		const highlightExplanations = changedPendingExplanations(snapshot.lastVisibleState, state);
		const body = formatCompactView(state, now, waits, {
			preamble: COMPACT_PREAMBLE,
			...(highlightExplanations.size > 0 ? { highlightExplanations } : {}),
		});
		batch = { stateKey, includesFullRecovery: batch?.includesFullRecovery ?? false };
		return { additionalContext: renderReminder(body, snapshot.hasPriorPlanning) };
	};

	pi.on("before_agent_start", (event, ctx) => {
		if (event.reason === "revive") return;
		try {
			return deliverAtPrompt(ctx);
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
	pi.on("tool_result", (event, ctx) => {
		settled(ctx);
		try {
			return deliverAfterTools(event, ctx);
		} catch (error) {
			pi.logger.warn("todo-more todo snapshot reminder failed", { error: errorText(error) });
		}
	});
	pi.on("turn_start", (_event, ctx) => {
		settled(ctx);
		batch = undefined;
	});
	pi.on("turn_end", (_event, ctx) => settled(ctx));
}
