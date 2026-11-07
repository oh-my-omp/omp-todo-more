/**
 * Memory-audit bench for `src/reminders.ts` (oh-my-omp/omp-todo-more#31).
 *
 * Drives the real extension entry points — the `context` handler captured from
 * `registerReminders(pi)` and the `agent_end` handler — over stubbed host
 * surfaces, with a real `SessionManager` (in-memory) answering branch reads.
 * Every scenario asserts behavior and, where the acceptance table asks for it,
 * counts allocations/branch reads. `--scenario scaling` measures the no-notice
 * path on the same load for the current implementation and the pre-change
 * implementation embedded verbatim below (`baseline*`), so one HEAD run yields
 * the same-load before/after pair §2 requires.
 *
 * Usage: bun test/bench/reminders.ts --scenario <name>
 * Scenarios: no-notice | strip-notice | goal-mode | reminder-details | scaling | all
 * Exit code is non-zero when any assertion fails (ghc ev run records it).
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { CustomMessage } from "@oh-my-pi/pi-agent-core/compaction/messages";
import type { AssistantMessage, UserMessage } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext, MessageRenderer, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { Component } from "@oh-my-pi/pi-tui";
import type { Theme } from "@oh-my-pi/pi-tui/theme/theme";
import { escapeXmlText } from "@oh-my-pi/pi-utils";
import { contextMessages, registerReminders, renderReminder } from "../../src/reminders.ts";
import {
	explanationText,
	goalLines,
	readTodoMore,
	TODO_MORE_ENTRY_TYPE,
	type TodoMoreSnapshot,
	type TodoMoreState,
	timeEstimateText,
} from "../../src/state.ts";

const REMINDER_TYPE = `${TODO_MORE_ENTRY_TYPE}.reminder`;
const REMINDER_NOTICE_TYPE = `${TODO_MORE_ENTRY_TYPE}.reminder-notice`;
const GOAL_MODE_CONTEXT_TYPE = "goal-mode-context";

// ---------------------------------------------------------------------------
// Embedded pre-change implementation (verbatim from the anchor commit
// 4520843c5c1599801d37cba099c3d53dbdd87239, src/reminders.ts:630-718), so the
// scaling and equality scenarios compare current vs baseline on the same load
// inside one checkout. Private helpers are re-prefixed `baseline*`.
// ---------------------------------------------------------------------------

// @baseline verbatim src/reminders.ts#sanitizeGoalTodoText
function baselineSanitizeGoalTodoText(text: string): string {
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

// @baseline verbatim src/reminders.ts#todoToolRef
function baselineTodoToolRef(session: AgentSession): string {
	const tool = session.getToolByName("todo");
	return typeof tool?.customWireName === "string" ? tool.customWireName : "todo";
}

// @baseline verbatim src/reminders.ts#goalTodoContext
function baselineGoalTodoContext(session: AgentSession, state: TodoMoreState): string | undefined {
	const canCallTodoTool = session.getActiveToolNames().includes("todo");
	if (!canCallTodoTool) return undefined;
	if (state.kind === "empty") return undefined;
	const phases = state.phases.filter((phase) => phase.items.length > 0);
	if (phases.length === 0) return undefined;

	let total = 0;
	let closed = 0;
	let open = 0;
	const phaseLines = phases.flatMap((phase) => [
		`- ${baselineSanitizeGoalTodoText(phase.name)}`,
		...phase.items.map((item) => {
			total++;
			if (item.status === "completed" || item.status === "abandoned") {
				closed++;
			} else {
				open++;
			}
			return `  - [${item.status}] ${baselineSanitizeGoalTodoText(item.title)}: ${baselineSanitizeGoalTodoText(explanationText(item))}; ${baselineSanitizeGoalTodoText(timeEstimateText(item.time))}`;
		}),
	]);
	const goal =
		state.goal.kind === "set"
			? goalLines(state.goal.goal).map((line) => baselineSanitizeGoalTodoText(line))
			: [`Goal: none yet — put GOAL first in the next \`${baselineTodoToolRef(session)}\` document.`];

	return `<todo_context>
Persisted todos: live progress state for current goal, not old transcript decoration; goal continuations lack visible user nudge → treat as live state.
Before substantial work: compare next action with todos. If item stale, already finished, or no longer active pointer, call \`${baselineTodoToolRef(session)}\` first: mark done or rewrite list. Do not leave stale in_progress while working on later phases.

Todo list goal:
${goal.join("\n")}

Overall: ${closed}/${total} done, ${open} open.
${phaseLines.join("\n")}
</todo_context>
`;
}

// @baseline verbatim src/reminders.ts#withAppendedText
function baselineWithAppendedText(message: AgentMessage, text: string): AgentMessage {
	if (message.role !== "custom") return message;
	const content =
		typeof message.content === "string" ? `${message.content}\n${text}` : [...message.content, { type: "text" as const, text }];
	return { ...message, content };
}

// @baseline verbatim src/reminders.ts#contextMessages (its `branch()` was wired to
// `ctx.sessionManager.getBranch()` before this fix)
function baselineContextMessages(
	messages: AgentMessage[],
	session: AgentSession | undefined,
	branch: () => readonly SessionEntry[],
): AgentMessage[] | undefined {
	const kept = messages.filter((message) => !(message.role === "custom" && message.customType === REMINDER_NOTICE_TYPE));
	let changed = kept.length !== messages.length;
	if (session?.getGoalModeState()?.enabled === true) {
		const goalIndex = kept.findLastIndex((message) => message.role === "custom" && message.customType === GOAL_MODE_CONTEXT_TYPE);
		const goalMessage = kept[goalIndex];
		if (goalMessage !== undefined) {
			const todoContext = baselineGoalTodoContext(session, readTodoMore(branch()));
			if (todoContext !== undefined) {
				kept[goalIndex] = baselineWithAppendedText(goalMessage, todoContext);
				changed = true;
			}
		}
	}
	return changed ? kept : undefined;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

type Handler = (event: never, ctx: ExtensionContext) => unknown;

const GOAL = { objective: "Ship the memory fix", measure: "PR green", doneWhen: "Merged" };

function todoSnapshot(items?: Partial<TodoMoreSnapshot["phases"][number]["items"][number]>): TodoMoreSnapshot {
	return {
		goal: GOAL,
		phases: [
			{
				name: "Delivery",
				items: [
					{
						title: "Ship it",
						explanation: "Done",
						status: "pending",
						time: { kind: "missing" },
						...items,
					},
				],
			},
		],
	};
}

function isCustomMessage(message: AgentMessage, customType: string): message is CustomMessage {
	return message.role === "custom" && message.customType === customType;
}

function hasMessages(result: unknown): result is { messages?: AgentMessage[] } {
	return typeof result === "object" && result !== null;
}

class Fixture {
	readonly handlers = new Map<string, Handler[]>();
	readonly errors: string[] = [];
	readonly sent: { message: unknown; options: unknown }[] = [];
	readonly agentId = `reminders-bench-${crypto.randomUUID()}`;
	readonly manager = SessionManager.inMemory("/tmp/reminders-bench");
	branchCalls = { getBranch: 0, getBranchView: 0 };

	constructor(
		readonly session: AgentSession | undefined,
		private readonly agentKind: "main" | "sub" = "main",
	) {
		const api = {
			on: (event: string, handler: Handler) => {
				const list = this.handlers.get(event) ?? [];
				list.push(handler);
				this.handlers.set(event, list);
			},
			registerMessageRenderer: (_customType: string, _renderer: MessageRenderer) => {},
			sendMessage: (message: unknown, options: unknown) => {
				this.sent.push({ message, options });
			},
			registerShortcut: () => {},
			registerCommand: () => {},
			logger: { warn: (message: string) => this.errors.push(message) },
		} as unknown as ExtensionAPI;
		registerReminders(api);
		if (session !== undefined) {
			AgentRegistry.global().register({
				id: this.agentId,
				displayName: "Reminders bench",
				kind: this.agentKind,
				session: session as never,
			});
		}
		this.ctx = this.buildCtx();
	}

	unregister(): void {
		AgentRegistry.global().unregister(this.agentId);
	}

	readonly ctx: ExtensionContext;

	private buildCtx(): ExtensionContext {
		const counts = this.branchCalls;
		const manager = this.manager;
		const sessionManager = new Proxy(manager, {
			get(target, prop, receiver) {
				if (prop === "getBranch") {
					return () => {
						counts.getBranch++;
						return target.getBranch();
					};
				}
				if (prop === "getBranchView") {
					return () => {
						counts.getBranchView++;
						return target.getBranchView();
					};
				}
				return Reflect.get(target, prop, receiver);
			},
		});
		return {
			agent: { id: this.agentId, kind: this.agentKind, name: "bench", depth: 0 },
			sessionManager,
			hasUI: false,
			isIdle: () => true,
			hasPendingMessages: () => false,
			setTimeout: () => 0,
			clearTimer: () => {},
		} as unknown as ExtensionContext;
	}

	emit(type: string, event: Record<string, unknown>): unknown {
		let result: unknown;
		for (const handler of this.handlers.get(type) ?? []) {
			const returned = handler(event as never, this.ctx);
			if (returned !== undefined) result = returned;
		}
		return result;
	}

	context(messages: AgentMessage[]): AgentMessage[] | undefined {
		const result = this.emit("context", { type: "context", messages });
		return hasMessages(result) ? result.messages : undefined;
	}

	/** The pre-change `pi.on("context")` handler, verbatim plumbing: same ownSession lookup, same getBranch thunk. */
	baselineContext(messages: AgentMessage[]): AgentMessage[] | undefined {
		const own = (AgentRegistry.global().get(this.agentId)?.session ?? undefined) as AgentSession | undefined;
		const result = baselineContextMessages(messages, own, () => this.ctx.sessionManager.getBranch());
		return result === undefined ? undefined : result;
	}

	appendSnapshot(snapshot: TodoMoreSnapshot): void {
		this.manager.appendCustomEntry(TODO_MORE_ENTRY_TYPE, snapshot);
	}
}

/** Session stub: only the surfaces reminders.ts reads. */
function stubSession(over: { goalMode?: boolean; toolNames?: string[] }): AgentSession {
	return {
		settings: Settings.isolated(),
		getPlanModeState: () => undefined,
		getGoalModeState: () => (over.goalMode === true ? { enabled: true, mode: "active", goal: {} } : undefined),
		getActiveToolNames: () => over.toolNames ?? [],
		getToolByName: () => undefined,
		hasPendingAsyncWork: () => false,
	} as unknown as AgentSession;
}

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "bench",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	} as unknown as AssistantMessage;
}

function userMessage(text: string): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function customMessage(customType: string, content = "note", details?: unknown): CustomMessage {
	return { role: "custom", customType, content, display: true, details, timestamp: 1 };
}

/** Counts `event.messages` copies made through Array.prototype.filter/slice. */
function countCopies(array: readonly AgentMessage[], run: () => void): number {
	type FilterSignature = (predicate: (value: unknown, index: number, values: unknown[]) => unknown, thisArg?: unknown) => unknown[];
	const originalFilter = Array.prototype.filter as FilterSignature;
	const originalSlice = Array.prototype.slice as (this: unknown[], start?: number, end?: number) => unknown[];
	let count = 0;
	Array.prototype.filter = function (this: unknown[], predicate: Parameters<FilterSignature>[0], thisArg?: unknown) {
		if (this === array) count++;
		return originalFilter.call(this, predicate, thisArg);
	} as typeof Array.prototype.filter;
	Array.prototype.slice = function (this: unknown[], start?: number, end?: number) {
		if (this === array) count++;
		return originalSlice.call(this, start, end);
	} as typeof Array.prototype.slice;
	try {
		run();
	} finally {
		Array.prototype.filter = originalFilter;
		Array.prototype.slice = originalSlice;
	}
	return count;
}

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
	if (condition) {
		console.log(`PASS ${name}`);
	} else {
		failures++;
		console.log(`FAIL ${name}${detail === "" ? "" : ` — ${detail}`}`);
	}
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

function scenarioNoNotice(): void {
	const fixture = new Fixture(stubSession({}));
	try {
		const messages = Array.from({ length: 10_000 }, (_, index) => (index % 3 === 0 ? assistant(`a${index}`) : userMessage(`u${index}`)));
		let result: AgentMessage[] | undefined;
		const copies = countCopies(messages, () => {
			result = fixture.context(messages);
		});
		check("no-notice returns undefined", result === undefined);
		check("no-notice copies messages 0 times", copies === 0, `copies=${copies}`);
		check("no-notice never reads the branch", fixture.branchCalls.getBranch === 0 && fixture.branchCalls.getBranchView === 0);
		check("no handler errors", fixture.errors.length === 0, fixture.errors.join(";"));
	} finally {
		fixture.unregister();
	}
}

function scenarioStripNotice(): void {
	const session = stubSession({});
	const fixture = new Fixture(session);
	try {
		const notice = customMessage(REMINDER_NOTICE_TYPE, "Todo reminder 1/5: 1 incomplete todo", {
			items: [{ phase: "Delivery", title: "Ship it" }],
			attempt: 1,
			max: 5,
		});
		const messages: AgentMessage[] = [userMessage("u1"), notice, assistant("a1"), notice, userMessage("u2")];
		let result: AgentMessage[] | undefined;
		countCopies(messages, () => {
			result = fixture.context(messages);
		});
		const baseline = baselineContextMessages(messages, session, () => fixture.manager.getBranch());
		check("strip-notice drops both notices", result !== undefined && result.length === 3);
		check("strip-notice output matches baseline item-for-item", Bun.deepEquals(result, baseline));
		check("no handler errors", fixture.errors.length === 0, fixture.errors.join(";"));
	} finally {
		fixture.unregister();
	}
}

function scenarioGoalMode(): void {
	const withTodoSession = stubSession({ goalMode: true, toolNames: ["todo", "read"] });
	const noTodoSession = stubSession({ goalMode: true, toolNames: ["read"] });
	const withTodo = new Fixture(withTodoSession);
	const noTodo = new Fixture(noTodoSession);
	const noGoalMessage = new Fixture(stubSession({ goalMode: true, toolNames: ["todo"] }));
	try {
		withTodo.appendSnapshot(todoSnapshot());
		noTodo.appendSnapshot(todoSnapshot());

		// Goal message present, todo context generated: splice, one branch read via getBranchView.
		const goalMessage = customMessage(GOAL_MODE_CONTEXT_TYPE, "goal ctx");
		const messages: AgentMessage[] = [userMessage("u1"), goalMessage, assistant("a1")];
		const result = withTodo.context(messages);
		const baseline = baselineContextMessages(messages, withTodoSession, () => withTodo.manager.getBranch());
		check("goal-mode splices todo context", result !== undefined && result !== messages);
		const replaced = result?.find((m) => isCustomMessage(m, GOAL_MODE_CONTEXT_TYPE));
		check(
			"goal-mode appended text carries the snapshot",
			replaced !== undefined &&
				(Array.isArray(replaced.content)
					? replaced.content.some((c) => c.type === "text" && c.text.includes("<todo_context>"))
					: replaced.content.includes("<todo_context>")),
		);
		check("goal-mode output matches baseline", Bun.deepEquals(result, baseline));
		check(
			"goal-mode reads branch once via getBranchView",
			withTodo.branchCalls.getBranchView === 1 && withTodo.branchCalls.getBranch === 0,
			JSON.stringify(withTodo.branchCalls),
		);

		// Goal message present but goalTodoContext undefined (todo tool absent): no copy, undefined.
		const messages2: AgentMessage[] = [userMessage("u1"), customMessage(GOAL_MODE_CONTEXT_TYPE, "goal ctx")];
		let result2: AgentMessage[] | undefined;
		const copies = countCopies(messages2, () => {
			result2 = noTodo.context(messages2);
		});
		check("goal-mode undefined context returns undefined", result2 === undefined);
		check("goal-mode undefined context copies 0 times", copies === 0, `copies=${copies}`);
		check(
			"goal-mode branch read still bounded",
			noTodo.branchCalls.getBranchView <= 1 && noTodo.branchCalls.getBranch === 0,
			JSON.stringify(noTodo.branchCalls),
		);

		// Goal enabled but no goal message: no branch read at all.
		const result3 = noGoalMessage.context([userMessage("u1"), assistant("a1")]);
		check("goal-mode no goal message returns undefined", result3 === undefined);
		check(
			"goal-mode no goal message skips branch",
			noGoalMessage.branchCalls.getBranch === 0 && noGoalMessage.branchCalls.getBranchView === 0,
		);

		check("no handler errors", withTodo.errors.length === 0 && noTodo.errors.length === 0 && noGoalMessage.errors.length === 0);
	} finally {
		withTodo.unregister();
		noTodo.unregister();
		noGoalMessage.unregister();
	}
}

function describeText(component: Component | undefined): string {
	return component instanceof Object && "getText" in component && typeof component.getText === "function"
		? (component.getText() as string)
		: "";
}

function scenarioReminderDetails(): void {
	const fixture = new Fixture(stubSession({}), "sub");
	try {
		fixture.appendSnapshot(todoSnapshot());
		fixture.manager.appendMessage(userMessage("start"));
		fixture.emit("agent_end", { type: "agent_end", messages: [assistant("All done.")] });
		check("agent_end sent one reminder", fixture.sent.length === 1, `sent=${fixture.sent.length}`);
		const sent = fixture.sent[0]?.message;
		check("reminder customType", typeof sent === "object" && sent !== null && "customType" in sent && sent.customType === REMINDER_TYPE);
		const details =
			typeof sent === "object" && sent !== null && "details" in sent && typeof sent.details === "object" && sent.details !== null
				? (sent.details as Record<string, unknown>)
				: {};
		check("reminder details has no more key", !("more" in details), JSON.stringify(Object.keys(details)));
		check(
			"reminder details keeps render fields",
			Array.isArray(details.items) && typeof details.attempt === "number" && typeof details.max === "number",
		);

		// Rendering must be identical for a details object with and without the
		// legacy `more` snapshot (persisted reminders written before this fix).
		const theme = { fg: (_c: string, t: string) => `W(${t})`, icon: { warning: "!" } } as unknown as Theme;
		const base = { items: [{ phase: "Delivery", title: "Ship it" }], attempt: 1, max: 5 };
		const message = customMessage(REMINDER_TYPE, "text", base);
		const legacy = customMessage(REMINDER_TYPE, "text", { ...base, more: todoSnapshot() });
		const renderedNew = renderReminder(message, {} as never, theme);
		const renderedLegacy = renderReminder(legacy, {} as never, theme);
		check(
			"renderer output unchanged for legacy details",
			renderedNew !== undefined && renderedLegacy !== undefined && describeText(renderedLegacy) === describeText(renderedNew),
		);
		check("no handler errors", fixture.errors.length === 0, fixture.errors.join(";"));
	} finally {
		fixture.unregister();
	}
}

function scenarioScaling(): void {
	const N = 10_000;
	const messages: AgentMessage[] = Array.from({ length: N }, (_, index) =>
		index % 5 === 0 ? assistant(`a${index}`) : userMessage(`u${index}`),
	);
	const fixture = new Fixture(stubSession({}));
	const ROUNDS = 30;
	const CALLS = 200;
	try {
		// Median per-call time. Allocation is judged by the copy count below: heapUsed
		// excludes young-generation garbage, so it reads ≈0 for both implementations.
		const measure = (run: () => void): number => {
			const times: number[] = [];
			for (let i = 0; i < 5; i++) run();
			for (let round = 0; round < ROUNDS; round++) {
				const t0 = Bun.nanoseconds();
				for (let i = 0; i < CALLS; i++) run();
				times.push((Bun.nanoseconds() - t0) / CALLS);
			}
			times.sort((a, b) => a - b);
			return times[Math.floor(times.length / 2)]!;
		};

		const branch = () => fixture.ctx.sessionManager.getBranch();
		const currentNs = measure(() => contextMessages(messages, undefined, branch));
		const baselineNs = measure(() => baselineContextMessages(messages, undefined, branch));
		const currentCopies = countCopies(messages, () => contextMessages(messages, undefined, branch));
		const baselineCopies = countCopies(messages, () => baselineContextMessages(messages, undefined, branch));
		const timeRatio = baselineNs / currentNs;
		console.log(
			`scaling N=${N} calls=${CALLS} rounds=${ROUNDS}: current ${currentNs.toFixed(0)}ns ${currentCopies}copies/call; baseline ${baselineNs.toFixed(0)}ns ${baselineCopies}copies/call; time x${timeRatio.toFixed(2)}`,
		);
		check(
			"scaling eliminates messages copies",
			baselineCopies === 1 && currentCopies === 0,
			`baseline=${baselineCopies} current=${currentCopies}`,
		);
		check("scaling no slower than baseline", timeRatio >= 1, `x${timeRatio.toFixed(2)}`);
		check("no handler errors", fixture.errors.length === 0, fixture.errors.join(";"));
	} finally {
		fixture.unregister();
	}
}

const scenarios: Record<string, () => void> = {
	"no-notice": scenarioNoNotice,
	"strip-notice": scenarioStripNotice,
	"goal-mode": scenarioGoalMode,
	"reminder-details": scenarioReminderDetails,
	scaling: scenarioScaling,
};

const arg = process.argv.find((value) => value.startsWith("--scenario=")) ?? process.argv[process.argv.indexOf("--scenario") + 1];
const name = arg?.replace("--scenario=", "") ?? "all";
if (name === "all") {
	for (const run of Object.values(scenarios)) run();
} else {
	const run = scenarios[name];
	if (run === undefined) {
		console.error(`Unknown scenario ${name}; expected one of ${Object.keys(scenarios).join(", ")}`);
		process.exit(2);
	}
	run();
}
process.exit(failures === 0 ? 0 : 1);
