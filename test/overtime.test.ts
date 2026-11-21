import { describe, expect, setSystemTime, test } from "bun:test";
import { AgentSession, type ExtensionAPI, type ExtensionContext, type ExtensionEvent, type SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { TodoPhase as HostTodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { askWaits, readTodoMore } from "../src/branch.ts";
import { commitTodoState } from "../src/commit.ts";
import { registerOvertime } from "../src/overtime.ts";
import {
	elapsedTime,
	type ItemTime,
	OVERTIME_TYPE,
	overtimeDetailsSchema,
	stateOf,
	type TodoItem,
	type TodoMoreState,
	type TodoStatus,
	transitionTime,
} from "../src/state.ts";
import { appendStateResult } from "./host.ts";

const epoch = Date.parse("2026-10-15T12:00:00.000Z");
const title = "Deliver the full task";
type Estimate = Extract<ItemTime, { kind: "estimated" }>;
type Warning = Extract<SessionEntry, { type: "custom_message" }>;
type Handler = (event: ExtensionEvent, ctx: ExtensionContext) => unknown;

function estimatedState(minutes = 1, budgetId = "original-budget", runningSince = epoch, elapsedMs = 0): TodoMoreState {
	return stateOf({ kind: "set", goal: { objective: "Deliver the task", measure: "Observable behavior", doneWhen: "All criteria hold" } }, [
		{
			name: "Delivery",
			items: [
				{
					title,
					explanation: { kind: "explained", text: "Implement without reducing scope" },
					status: "in_progress",
					time: { kind: "estimated", budgetId, minutes, elapsedMs, runningSince },
				},
			],
		},
	]);
}

function itemOf(manager: SessionManager): TodoItem {
	const state = readTodoMore(manager.getBranch());
	if (state.kind !== "list") throw new Error("Expected a task in the authority branch");
	const item = state.phases.flatMap((phase) => phase.items).find((candidate) => candidate.title === title);
	if (item === undefined) throw new Error("Expected the original task");
	return item;
}

function estimateOf(manager: SessionManager): Estimate {
	const time = itemOf(manager).time;
	if (time.kind !== "estimated") throw new Error("Expected the original estimate to survive replay");
	return time;
}

function warnings(manager: SessionManager): Warning[] {
	return manager.getBranch().filter((entry): entry is Warning => entry.type === "custom_message" && entry.customType === OVERTIME_TYPE);
}

function warningDetails(manager: SessionManager) {
	expect(warnings(manager)).toHaveLength(1);
	return overtimeDetailsSchema.parse(warnings(manager)[0]?.details);
}

class DeadlineClock {
	now = epoch;
	#nextHandle = 0;
	#scheduled = new Map<Timer, { at: number; run: () => void }>();

	constructor() {
		setSystemTime(this.now);
	}

	setTimeout: ExtensionContext["setTimeout"] = (callback, ms = 0, ...args) => {
		const handle = ++this.#nextHandle as unknown as Timer;
		this.#scheduled.set(handle, { at: this.now + ms, run: () => callback(...args) });
		return handle;
	};

	clearTimer: ExtensionContext["clearTimer"] = (handle) => {
		this.#scheduled.delete(handle);
	};

	get deadlines(): number[] {
		return [...this.#scheduled.values()].map((timer) => timer.at).sort((left, right) => left - right);
	}

	captureNext(): () => void {
		const next = [...this.#scheduled.values()].sort((left, right) => left.at - right.at)[0];
		if (next === undefined) throw new Error("Expected a future deadline");
		return next.run;
	}

	async advanceTo(target: number): Promise<void> {
		if (target < this.now) throw new Error("The test clock must not run backwards");
		for (;;) {
			const next = [...this.#scheduled.entries()]
				.filter(([, timer]) => timer.at <= target)
				.sort(([, left], [, right]) => left.at - right.at)[0];
			if (next === undefined) break;
			const [handle, timer] = next;
			this.now = timer.at;
			setSystemTime(this.now);
			this.#scheduled.delete(handle);
			timer.run();
			await Promise.resolve();
		}
		this.now = target;
		setSystemTime(this.now);
		await Promise.resolve();
	}
}

async function withScheduler(run: (fixture: SchedulerFixture) => Promise<void>): Promise<void> {
	const fixture = new SchedulerFixture();
	try {
		await fixture.emit({ type: "session_start" });
		await run(fixture);
		expect(fixture.errors).toEqual([]);
	} finally {
		try {
			await fixture.emit({ type: "session_shutdown" });
		} finally {
			AgentRegistry.global().unregister(fixture.agentId, fixture.ref);
			setSystemTime();
		}
	}
}

class SchedulerFixture {
	readonly clock = new DeadlineClock();
	readonly agentId = `overtime-regression-${crypto.randomUUID()}`;
	readonly errors: string[] = [];
	readonly handlers = new Map<string, Handler[]>();
	manager = SessionManager.inMemory("/tmp/overtime-regression");
	phases: HostTodoPhase[] = [];

	get session(): AgentSession {
		const manager = this.manager;
		const session = {
			sessionManager: manager,
			getTodoPhases: () => structuredClone(this.phases),
			setTodoPhases: (phases: HostTodoPhase[]) => {
				this.phases = structuredClone(phases);
			},
		};
		return Object.setPrototypeOf(session, AgentSession.prototype) as AgentSession;
	}

	bound = this.session;

	readonly ref = AgentRegistry.global().register({
		id: this.agentId,
		displayName: "Overtime regression",
		kind: "sub",
		session: this.bound,
	});

	readonly api = {
		on: (event: string, handler: Handler) => {
			const handlers = this.handlers.get(event) ?? [];
			handlers.push(handler);
			this.handlers.set(event, handlers);
		},
		sendMessage: ((message) => {
			if (typeof message === "string") throw new Error("Expected a structured overtime warning");
			this.manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details, message.attribution);
		}) satisfies ExtensionAPI["sendMessage"],
		logger: { warn: (message: string) => this.errors.push(message) },
	} as unknown as ExtensionAPI;

	constructor() {
		registerOvertime(this.api);
	}

	async emit(event: ExtensionEvent): Promise<void> {
		const ctx = {
			agent: { id: this.agentId },
			sessionManager: this.manager,
			isIdle: () => true,
			setTimeout: this.clock.setTimeout,
			clearTimer: this.clock.clearTimer,
		} as unknown as ExtensionContext;
		for (const handler of this.handlers.get(event.type) ?? []) await handler(event, ctx);
		await Promise.resolve();
	}

	/** A `todo` call that left `state`: the writes the tool makes, then the result the host persists. */
	async append(state: TodoMoreState): Promise<void> {
		commitTodoState(this.session, state);
		appendStateResult(this.manager, state, this.clock.now);
		await this.toolEnd("todo");
	}

	/** A `todo` call that moved the item to `status` at the current time. */
	async moveTo(status: TodoStatus): Promise<void> {
		const state = readTodoMore(this.manager.getBranch());
		if (state.kind !== "list") throw new Error("Expected a list to move");
		const now = this.clock.now;
		await this.append(
			stateOf(
				state.goal,
				state.phases.map((phase) => ({
					...phase,
					items: phase.items.map((item) => ({ ...item, status, time: transitionTime(item.time, status, now) })),
				})),
			),
		);
	}

	async toolEnd(toolName: string): Promise<void> {
		await this.emit({
			type: "tool_result",
			toolCallId: crypto.randomUUID(),
			toolName,
			input: {},
			content: [],
			details: undefined,
			isError: false,
		});
	}

	async askStart(toolCallId: string): Promise<void> {
		this.manager.appendCustomEntry("tool_execution_start", {
			toolCallId,
			toolName: "ask",
			startedAt: new Date(this.clock.now).toISOString(),
		});
		await this.emit({ type: "tool_execution_start", toolCallId, toolName: "ask", args: {} });
	}

	async askAnswered(toolCallId: string): Promise<void> {
		const message = {
			role: "toolResult" as const,
			toolName: "ask",
			toolCallId,
			content: [{ type: "text" as const, text: "User answers:\nq: A" }],
			details: { results: [] },
			isError: false,
			timestamp: this.clock.now,
		};
		this.manager.appendMessage(message);
		await this.emit({ type: "message_end", message });
	}
}

describe("overtime deadline scheduling", () => {
	test("stays quiet until the deadline and journals exactly one warning", async () => {
		await withScheduler(async (fixture) => {
			await fixture.append(estimatedState());
			expect(fixture.clock.deadlines).toEqual([epoch + 60_000]);
			const originalCallback = fixture.clock.captureNext();
			await fixture.clock.advanceTo(epoch + 59_999);
			expect(warnings(fixture.manager)).toEqual([]);
			await fixture.clock.advanceTo(epoch + 60_000);
			expect(warningDetails(fixture.manager)).toEqual({
				budgetId: "original-budget",
				title,
				estimatedMinutes: 1,
				elapsedMs: 60_000,
			});
			originalCallback();
			await fixture.append(readTodoMore(fixture.manager.getBranch()));
			await fixture.emit({ type: "session_switch", reason: "resume", previousSessionFile: undefined });
			await fixture.clock.advanceTo(epoch + 180_000);
			expect(warnings(fixture.manager)).toHaveLength(1);
			expect(fixture.clock.deadlines).toEqual([]);
		});
	});

	test("time spent waiting on the user in ask is not work time", async () => {
		await withScheduler(async (fixture) => {
			await fixture.append(estimatedState());
			await fixture.clock.advanceTo(epoch + 20_000);
			await fixture.askStart("ask-1");
			await fixture.clock.advanceTo(epoch + 200_000);
			expect(warnings(fixture.manager)).toEqual([]);
			expect(fixture.clock.deadlines).toEqual([]);
			await fixture.askAnswered("ask-1");
			expect(elapsedTime(estimateOf(fixture.manager), fixture.clock.now, askWaits(fixture.manager.getBranch()))).toBe(20_000);
			expect(fixture.clock.deadlines).toEqual([epoch + 240_000]);
			await fixture.clock.advanceTo(epoch + 239_999);
			expect(warnings(fixture.manager)).toEqual([]);
			await fixture.clock.advanceTo(epoch + 240_000);
			expect(warningDetails(fixture.manager)).toEqual({ budgetId: "original-budget", title, estimatedMinutes: 1, elapsedMs: 60_000 });
		});
	});

	test("a status change pauses and resumes the remaining budget, then completion leaves no timer", async () => {
		await withScheduler(async (fixture) => {
			await fixture.append(estimatedState());
			await fixture.clock.advanceTo(epoch + 20_000);
			const beforePause = fixture.clock.captureNext();
			await fixture.moveTo("pending");
			expect(itemOf(fixture.manager).status).toBe("pending");
			expect(estimateOf(fixture.manager)).toMatchObject({ elapsedMs: 20_000, runningSince: null });
			expect(fixture.clock.deadlines).toEqual([]);
			await fixture.clock.advanceTo(epoch + 100_000);
			beforePause();
			expect(warnings(fixture.manager)).toEqual([]);
			await fixture.moveTo("in_progress");
			expect(estimateOf(fixture.manager)).toMatchObject({ elapsedMs: 20_000, runningSince: epoch + 100_000 });
			expect(fixture.clock.deadlines).toEqual([epoch + 140_000]);
			await fixture.clock.advanceTo(epoch + 139_999);
			expect(warnings(fixture.manager)).toEqual([]);
			const beforeCompletion = fixture.clock.captureNext();
			await fixture.moveTo("completed");
			expect(itemOf(fixture.manager).status).toBe("completed");
			expect(elapsedTime(estimateOf(fixture.manager), fixture.clock.now)).toBe(59_999);
			expect(fixture.clock.deadlines).toEqual([]);
			await fixture.clock.advanceTo(epoch + 200_000);
			beforeCompletion();
			expect(warnings(fixture.manager)).toEqual([]);
			expect(fixture.clock.deadlines).toEqual([]);
		});
	});

	test("the deadline follows the host list before the todo result reaches the branch", async () => {
		await withScheduler(async (fixture) => {
			commitTodoState(fixture.session, estimatedState());
			await fixture.toolEnd("todo");
			expect(fixture.manager.getBranch().some((entry) => entry.type === "message")).toBe(false);
			expect(fixture.clock.deadlines).toEqual([epoch + 60_000]);
			await fixture.clock.advanceTo(epoch + 60_000);
			expect(warningDetails(fixture.manager)).toMatchObject({ budgetId: "original-budget", elapsedMs: 60_000 });
		});
	});

	test("an earlier revised budget retains elapsed work and warns at its revised deadline", async () => {
		await withScheduler(async (fixture) => {
			await fixture.append(estimatedState(3));
			const obsoleteCallback = fixture.clock.captureNext();
			await fixture.clock.advanceTo(epoch + 30_000);
			const previous = estimateOf(fixture.manager);
			await fixture.append(estimatedState(1, "revised-budget", previous.runningSince ?? epoch, previous.elapsedMs));
			expect(elapsedTime(estimateOf(fixture.manager), fixture.clock.now)).toBe(30_000);
			expect(fixture.clock.deadlines).toEqual([epoch + 60_000]);
			obsoleteCallback();
			await fixture.clock.advanceTo(epoch + 59_999);
			expect(warnings(fixture.manager)).toEqual([]);
			await fixture.clock.advanceTo(epoch + 60_000);
			expect(warningDetails(fixture.manager)).toMatchObject({ budgetId: "revised-budget", estimatedMinutes: 1, elapsedMs: 60_000 });
			await fixture.clock.advanceTo(epoch + 180_000);
			obsoleteCallback();
			expect(warnings(fixture.manager)).toHaveLength(1);
		});
	});

	test("replacing a budget with the same deadline never warns for the obsolete budget", async () => {
		await withScheduler(async (fixture) => {
			await fixture.append(estimatedState());
			await fixture.clock.advanceTo(epoch + 20_000);
			await fixture.append(estimatedState(1, "replacement-budget"));
			expect(fixture.clock.deadlines).toEqual([epoch + 60_000]);
			await fixture.clock.advanceTo(epoch + 59_999);
			expect(warnings(fixture.manager)).toEqual([]);
			await fixture.clock.advanceTo(epoch + 60_000);
			expect(warningDetails(fixture.manager)).toMatchObject({ budgetId: "replacement-budget", elapsedMs: 60_000 });
		});
	});

	test("an accepted commit schedules the warning", async () => {
		await withScheduler(async (fixture) => {
			await fixture.append(estimatedState());
			expect(itemOf(fixture.manager).status).toBe("in_progress");
			expect(fixture.clock.deadlines).toEqual([epoch + 60_000]);
			await fixture.clock.advanceTo(epoch + 60_000);
			expect(warningDetails(fixture.manager)).toMatchObject({ budgetId: "original-budget", elapsedMs: 60_000 });
		});
	});

	test("the overtime timer leaves the session's host write path untouched", async () => {
		await withScheduler(async (fixture) => {
			await fixture.append(estimatedState());
			expect(Object.hasOwn(fixture.bound, "commitTodoPhases")).toBe(false);
			expect(fixture.bound.commitTodoPhases).toBe(AgentSession.prototype.commitTodoPhases);
		});
	});

	test("an old callback cannot dispatch into a newly bound session", async () => {
		await withScheduler(async (fixture) => {
			await fixture.append(estimatedState());
			const oldManager = fixture.manager;
			const oldCallback = fixture.clock.captureNext();
			await fixture.clock.advanceTo(epoch + 20_000);
			fixture.manager = SessionManager.inMemory("/tmp/overtime-regression-rebound");
			await fixture.append(estimatedState(1, "new-session-budget", fixture.clock.now));
			fixture.bound = fixture.session;
			AgentRegistry.global().attachSession(fixture.agentId, fixture.bound, null, fixture.ref);
			await fixture.emit({ type: "session_switch", reason: "new", previousSessionFile: undefined });
			expect(fixture.clock.deadlines).toEqual([epoch + 80_000]);
			await fixture.clock.advanceTo(epoch + 60_000);
			oldCallback();
			expect(warnings(oldManager)).toEqual([]);
			expect(warnings(fixture.manager)).toEqual([]);
			await fixture.clock.advanceTo(epoch + 80_000);
			expect(warningDetails(fixture.manager)).toMatchObject({ budgetId: "new-session-budget", elapsedMs: 60_000 });
			expect(warnings(oldManager)).toEqual([]);
		});
	});

	test("shutdown cancels deadlines and leaves stale callbacks inert", async () => {
		await withScheduler(async (fixture) => {
			await fixture.append(estimatedState());
			const staleCallback = fixture.clock.captureNext();
			await fixture.emit({ type: "session_shutdown" });
			expect(fixture.clock.deadlines).toEqual([]);
			await fixture.append(estimatedState(1, "after-shutdown-budget"));
			expect(estimateOf(fixture.manager).budgetId).toBe("after-shutdown-budget");
			await fixture.clock.advanceTo(epoch + 120_000);
			staleCallback();
			expect(warnings(fixture.manager)).toEqual([]);
			expect(fixture.clock.deadlines).toEqual([]);
		});
	});
});
