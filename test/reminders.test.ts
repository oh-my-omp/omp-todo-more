import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { AgentSession, type ExtensionAPI, type ExtensionContext, type ExtensionEvent, Settings } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { enterCompactionBarrier, releaseCompactionBarrier } from "../omomp-shared/compact-handoff.ts";
import { contextMessages, continuation, registerReminders } from "../src/reminders.ts";
import { runTodo } from "../src/tool.ts";
import { hostSession, runPersisted } from "./host.ts";

const valid = {
	goal: { title: "Ship it", summary: "m", acceptance: "d" },
	add: [{ phase: "P", title: "t", detail: "e", minutes: 5 }],
};

function nudge(): AgentMessage {
	return {
		role: "custom",
		customType: "mid-run-todo-nudge",
		content: "host text",
		display: false,
		attribution: "agent",
		timestamp: Date.now(),
	};
}

function session(manager: SessionManager) {
	const host = hostSession(manager);
	return { host, session: Object.setPrototypeOf({ ...host, getToolByName: () => undefined }, AgentSession.prototype) as AgentSession };
}

describe("host reminders carry the plugin's content", () => {
	test("an unpersisted nudge takes the host list, not a branch that lags the last todo call", async () => {
		const manager = SessionManager.inMemory("/tmp/todo-ng-reminders-tests");
		const { host, session: own } = session(manager);
		await runTodo(host, valid);
		const rewritten = contextMessages([nudge()], own);
		expect(JSON.stringify(rewritten)).toContain("Ship it");
	});
});

describe("the continuation reminder reads the live host list", () => {
	function stopped(manager: SessionManager) {
		const host = hostSession(manager);
		const own = {
			sessionManager: manager,
			getTodoPhases: host.getTodoPhases,
			getPlanModeState: () => undefined,
			getActiveToolNames: () => ["todo"],
			settings: Settings.isolated(),
			wakeSources: undefined,
		};
		return { host, own };
	}

	test("a todo call whose result is not on the branch yet still gets its open items reminded", async () => {
		const manager = SessionManager.inMemory("/tmp/todo-ng-continuation-tests");
		const { host, own } = stopped(manager);
		await runTodo(host, valid);
		const completion = continuation(own);
		expect(completion.kind).toBe("remind");
		const text = completion.kind === "remind" ? completion.text : "";
		expect(text).toContain("t1");
	});

	test("an empty host list stays silent", () => {
		const manager = SessionManager.inMemory("/tmp/todo-ng-continuation-tests-empty");
		const { own } = stopped(manager);
		expect(continuation(own)).toEqual({ kind: "silent" });
	});
});

describe("cut-off reminder", () => {
	const registered: { id: string; ref: ReturnType<AgentRegistry["register"]> }[] = [];

	afterEach(() => {
		setSystemTime();
		for (const { id, ref } of registered.splice(0)) AgentRegistry.global().unregister(id, ref);
	});

	async function cutOff(cwd: string) {
		const now = Date.parse("2026-11-22T01:00:00.000Z");
		setSystemTime(now);
		const manager = SessionManager.inMemory("/tmp/todo-ng-cutoff-barrier");
		const host = hostSession(manager);
		const own = Object.setPrototypeOf(
			{
				...host,
				getPlanModeState: () => undefined,
				getActiveToolNames: () => ["todo"],
				settings: Settings.isolated(),
				wakeSources: undefined,
			},
			AgentSession.prototype,
		) as AgentSession;
		const agentId = `reminders-barrier-${crypto.randomUUID()}`;
		const ref = AgentRegistry.global().register({
			id: agentId,
			displayName: "Reminders barrier",
			kind: "main",
			session: own,
		});
		registered.push({ id: agentId, ref });
		await runPersisted(host, valid);

		const handlers = new Map<string, ((event: ExtensionEvent, ctx: ExtensionContext) => unknown)[]>();
		const sent: unknown[] = [];
		const warnings: string[] = [];
		const timers = new Map<Timer, () => void>();
		let nextTimer = 0;

		const pi = {
			on: (name: string, handler: (event: ExtensionEvent, ctx: ExtensionContext) => unknown) => {
				handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			},
			registerMessageRenderer: () => {},
			registerShortcut: () => {},
			registerCommand: () => {},
			sendMessage: (msg: unknown) => {
				sent.push(msg);
			},
			logger: { warn: (message: string) => warnings.push(message) },
		} as unknown as ExtensionAPI;

		registerReminders(pi);

		const ctx = {
			cwd,
			agent: { id: agentId, kind: "main" },
			sessionManager: manager,
			hasUI: false,
			isIdle: () => true,
			hasPendingMessages: () => false,
			setTimeout: (cb: () => void) => {
				const handle = ++nextTimer as unknown as Timer;
				timers.set(handle, cb);
				return handle;
			},
			clearTimer: (handle: Timer) => {
				timers.delete(handle);
			},
		} as unknown as ExtensionContext;

		for (const handler of handlers.get("agent_end") ?? []) {
			await handler(
				{
					type: "agent_end",
					willContinue: false,
					messages: [{ role: "assistant", stopReason: "error", content: [], timestamp: now }],
				} as unknown as ExtensionEvent,
				ctx,
			);
		}
		return { manager, timers, sent, warnings };
	}

	function projectDir(config: string): string {
		const dir = mkdtempSync(join(tmpdir(), "todo-ng-cutoff-"));
		mkdirSync(join(dir, ".omp"));
		writeFileSync(join(dir, ".omp", "todo-ng.json"), config);
		return dir;
	}

	test("defers cut-off reminder sendMessage while compaction is active and flushes after release", async () => {
		const { manager, timers, sent } = await cutOff("/tmp/todo-ng-cutoff-barrier");
		expect(timers.size).toBe(1);
		const fireTimer = [...timers.values()][0]!;
		timers.clear();

		enterCompactionBarrier(manager);
		fireTimer();
		expect(sent).toHaveLength(0);

		expect(releaseCompactionBarrier(manager)).toBe(1);
		expect(sent).toHaveLength(1);
	});

	test("effects.cutOff false in the project config arms no continuation after a server error", async () => {
		const { timers, sent } = await cutOff(projectDir(JSON.stringify({ effects: { cutOff: false } })));
		expect(timers.size).toBe(0);
		expect(sent).toHaveLength(0);
	});

	test("an invalid project config is logged and arms no continuation", async () => {
		const { timers, warnings } = await cutOff(projectDir(JSON.stringify({ effects: { cutoff: false } })));
		expect(timers.size).toBe(0);
		expect(warnings).toContain("todo-ng project config is invalid");
	});
});
