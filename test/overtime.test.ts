import { describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, type ExtensionAPI, type ExtensionContext, type ExtensionEvent, type SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { TodoPhase as HostTodoPhase } from "@oh-my-pi/pi-coding-agent/tools/details/todo";
import { enterCompactionBarrier, releaseCompactionBarrier } from "../omomp-shared/compact-handoff.ts";
import { foldBranch } from "../src/branch.ts";
import { commitTodoState } from "../src/commit.ts";
import { registerOvertime } from "../src/overtime.ts";
import {
	elapsedOf,
	OVERTIME_TYPE,
	overtimeDetailsSchema,
	type Progress,
	stateOf,
	type TodoItem,
	type TodoNgState,
	type TodoStatus,
	transition,
} from "../src/state.ts";
import { appendStateResult } from "./host.ts";

const epoch = Date.parse("2026-10-15T12:00:00.000Z");
const title = "Deliver the full task";
type Warning = Extract<SessionEntry, { type: "custom_message" }>;
type Handler = (event: ExtensionEvent, ctx: ExtensionContext) => unknown;

const stateOfManager = (manager: SessionManager): TodoNgState => foldBranch(manager.getBranch()).state;

function projectDir(config: string): string {
	const dir = mkdtempSync(join(tmpdir(), "todo-ng-overtime-"));
	mkdirSync(join(dir, ".omp"));
	writeFileSync(join(dir, ".omp", "todo-ng.json"), config);
	return dir;
}

function estimatedState(minutes = 1, budgetId = "original-budget", runningSince = epoch, elapsedMs = 0): TodoNgState {
	return stateOf({ kind: "set", goal: { objective: "Deliver the task", measure: "Observable behavior", doneWhen: "All criteria hold" } }, [
		{
			name: "Delivery",
			items: [
				{
					id: "t1",
					title,
					explanation: { kind: "explained", text: "Implement without reducing scope" },
					estimate: { kind: "estimated", budgetId, minutes },
					progress: { status: "in_progress", startedAt: epoch, elapsedMs, runningSince },
					commit: null,
					tailRule: null,
				},
			],
		},
	]);
}

function itemOf(manager: SessionManager): TodoItem {
	const state = stateOfManager(manager);
	if (state.kind !== "list") throw new Error("Expected a task in the authority branch");
	const item = state.phases.flatMap((phase) => phase.items).find((candidate) => candidate.title === title);
	if (item === undefined) throw new Error("Expected the original task");
	return item;
}

function progressOf(manager: SessionManager): Progress {
	return itemOf(manager).progress;
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

async function withScheduler(run: (fixture: SchedulerFixture) => Promise<void>, cwd = "/tmp/overtime-regression"): Promise<void> {
	const fixture = new SchedulerFixture(cwd);
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
	readonly deliveries: unknown[] = [];
	readonly handlers = new Map<string, Handler[]>();
	idle = true;
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
		sendMessage: ((message, options) => {
			if (typeof message === "string") throw new Error("Expected a structured overtime warning");
			this.deliveries.push(options);
			this.manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details, message.attribution);
		}) satisfies ExtensionAPI["sendMessage"],
		logger: { warn: (message: string) => this.errors.push(message) },
	} as unknown as ExtensionAPI;

	constructor(readonly cwd: string) {
		registerOvertime(this.api);
	}

	async emit(event: ExtensionEvent): Promise<void> {
		const ctx = {
			cwd: this.cwd,
			agent: { id: this.agentId },
			sessionManager: this.manager,
			isIdle: () => this.idle,
			setTimeout: this.clock.setTimeout,
			clearTimer: this.clock.clearTimer,
		} as unknown as ExtensionContext;
		for (const handler of this.handlers.get(event.type) ?? []) await handler(event, ctx);
		await Promise.resolve();
	}

	async append(state: TodoNgState): Promise<void> {
		commitTodoState(this.session, state);
		appendStateResult(this.manager, state, this.clock.now);
		await this.toolEnd("todo");
	}

	async moveTo(status: TodoStatus): Promise<void> {
		const state = stateOfManager(this.manager);
		if (state.kind !== "list") throw new Error("Expected a list to move");
		const now = this.clock.now;
		const waits = foldBranch(this.manager.getBranch()).waits;
		await this.append(
			stateOf(
				state.goal,
				state.phases.map((phase) => ({
					...phase,
					items: phase.items.map((item) => ({ ...item, progress: transition(item.progress, status, now, waits) })),
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
			expect(warningDetails(fixture.manager)).toMatchObject({
				budgetId: "original-budget",
				title,
				estimatedMinutes: 1,
				elapsedMs: 60_000,
			});
			originalCallback();
			await fixture.append(stateOfManager(fixture.manager));
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
			expect(elapsedOf(progressOf(fixture.manager), fixture.clock.now, foldBranch(fixture.manager.getBranch()).waits)).toBe(20_000);
			expect(fixture.clock.deadlines).toEqual([epoch + 240_000]);
			await fixture.clock.advanceTo(epoch + 239_999);
			expect(warnings(fixture.manager)).toEqual([]);
			await fixture.clock.advanceTo(epoch + 240_000);
			expect(warningDetails(fixture.manager)).toMatchObject({ budgetId: "original-budget", elapsedMs: 60_000 });
		});
	});

	test("a status change pauses and resumes the remaining budget, then completion leaves no timer", async () => {
		await withScheduler(async (fixture) => {
			await fixture.append(estimatedState());
			await fixture.clock.advanceTo(epoch + 20_000);
			const beforePause = fixture.clock.captureNext();
			await fixture.moveTo("pending");
			expect(progressOf(fixture.manager)).toMatchObject({ elapsedMs: 20_000, pausedAt: epoch + 20_000 });
			expect(fixture.clock.deadlines).toEqual([]);
			await fixture.clock.advanceTo(epoch + 100_000);
			beforePause();
			expect(warnings(fixture.manager)).toEqual([]);
			await fixture.moveTo("in_progress");
			expect(progressOf(fixture.manager)).toMatchObject({ elapsedMs: 20_000, runningSince: epoch + 100_000 });
			expect(fixture.clock.deadlines).toEqual([epoch + 140_000]);
			await fixture.clock.advanceTo(epoch + 139_999);
			expect(warnings(fixture.manager)).toEqual([]);
			const beforeCompletion = fixture.clock.captureNext();
			await fixture.moveTo("completed");
			expect(elapsedOf(progressOf(fixture.manager), fixture.clock.now)).toBe(59_999);
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
			const previous = itemOf(fixture.manager).progress;
			if (previous.status !== "in_progress") throw new Error("Expected the original item to be running");
			await fixture.append(estimatedState(1, "revised-budget", previous.runningSince ?? epoch, previous.elapsedMs));
			expect(elapsedOf(progressOf(fixture.manager), fixture.clock.now)).toBe(30_000);
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
			await fixture.clock.advanceTo(epoch + 120_000);
			staleCallback();
			expect(warnings(fixture.manager)).toEqual([]);
			expect(fixture.clock.deadlines).toEqual([]);
		});
	});

	test("defers overtime sendMessage while compaction barrier is active and flushes on release", async () => {
		await withScheduler(async (fixture) => {
			await fixture.append(estimatedState());
			expect(fixture.clock.deadlines).toEqual([epoch + 60_000]);

			enterCompactionBarrier(fixture.manager);

			await fixture.clock.advanceTo(epoch + 60_000);
			expect(warnings(fixture.manager)).toEqual([]);

			releaseCompactionBarrier(fixture.manager);
			await Promise.resolve();

			expect(warningDetails(fixture.manager)).toMatchObject({
				budgetId: "original-budget",
				elapsedMs: 60_000,
			});
		});
	});

	test("effects.overtime false in the project config schedules no deadline and sends no warning", async () => {
		await withScheduler(
			async (fixture) => {
				await fixture.append(estimatedState());
				expect(fixture.clock.deadlines).toEqual([]);
				await fixture.clock.advanceTo(epoch + 180_000);
				expect(warnings(fixture.manager)).toEqual([]);
			},
			projectDir(JSON.stringify({ effects: { overtime: false } })),
		);
	});

	test("an invalid project config is logged and sends no overtime warning", async () => {
		await withScheduler(async (fixture) => {
			await fixture.append(estimatedState());
			await fixture.clock.advanceTo(epoch + 180_000);
			expect(warnings(fixture.manager)).toEqual([]);
			expect(fixture.clock.deadlines).toEqual([]);
			expect(fixture.errors).toContain("todo-ng project config is invalid");
			fixture.errors.length = 0;
		}, projectDir("{ not json"));
	});

	test("delivers idle overtime warnings with nextTurn silent append and running warnings as aside", async () => {
		await withScheduler(async (fixture) => {
			fixture.idle = true;
			await fixture.append(estimatedState(1, "idle-budget"));
			await fixture.clock.advanceTo(epoch + 60_000);
			expect(fixture.deliveries).toEqual([{ deliverAs: "nextTurn", triggerTurn: false }]);

			fixture.idle = false;
			await fixture.append(estimatedState(1, "busy-budget", fixture.clock.now));
			await fixture.clock.advanceTo(epoch + 120_000);
			expect(fixture.deliveries).toEqual([{ deliverAs: "nextTurn", triggerTurn: false }, { deliverAs: "aside" }]);
		});
	});
});
