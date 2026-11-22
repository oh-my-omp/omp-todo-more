import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { AgentSession, Settings } from "@oh-my-pi/pi-coding-agent";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { contextMessages, continuation } from "../src/reminders.ts";
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
	// A reminder the host has just queued is not on the branch yet, and the `todo` result before it may not be either.
	test("an unpersisted nudge takes the host list, not a branch that lags the last todo call", async () => {
		const manager = SessionManager.inMemory("/tmp/todo-more-reminders-tests");
		const { host, session: own } = session(manager);
		await runTodo(host, valid);
		const rewritten = contextMessages([nudge()], own, manager);
		const text = JSON.stringify(rewritten);
		expect(text).toContain("1 todo item still open");
		expect(text).toContain("Goal objective: Ship it");
		expect(text).toContain("Current time:");
		expect(text).toContain("due by ");
		expect(text).not.toContain("Estimate:");
	});

	test("a persisted list gives the same content", async () => {
		const manager = SessionManager.inMemory("/tmp/todo-more-reminders-tests");
		const { host, session: own } = session(manager);
		await runPersisted(host, valid);
		expect(JSON.stringify(contextMessages([nudge()], own, manager))).toContain("1 todo item still open");
	});
});

describe("the continuation reminder reads the live host list", () => {
	// `continuation` runs at `agent_end`, before the last `todo` result has reached the branch.
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
		return { host, own, ctx: { sessionManager: manager } };
	}

	test("a todo call whose result is not on the branch yet still gets its open items reminded", async () => {
		const manager = SessionManager.inMemory("/tmp/todo-more-continuation-tests");
		const { host, own, ctx } = stopped(manager);
		await runTodo(host, valid);
		const completion = continuation(own, ctx);
		expect(completion.kind).toBe("remind");
		const text = completion.kind === "remind" ? completion.text : "";
		expect(text).toContain("Current time:");
		expect(text).toContain("You stopped with 1 incomplete todo item(s):\n- P\n  - [t1] t");
		expect(text).toContain("due by ");
		expect(text).not.toContain("Estimate:");
	});

	test("an empty host list stays silent", () => {
		const manager = SessionManager.inMemory("/tmp/todo-more-continuation-tests-empty");
		const { own, ctx } = stopped(manager);
		expect(continuation(own, ctx)).toEqual({ kind: "silent" });
	});
});
