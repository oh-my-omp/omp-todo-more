import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { contextMessages } from "../src/reminders.ts";
import { runTodo } from "../src/tool.ts";
import { hostSession, runPersisted } from "./host.ts";

const valid = '*** Begin Todo\nINIT "Ship it" "m" "d"\nPHASE "P"\nADD "t" "e" 5\n*** End Todo';

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
		await runTodo(host, { input: valid });
		const rewritten = contextMessages([nudge()], own, manager);
		expect(JSON.stringify(rewritten)).toContain("1 todo item still open");
		expect(JSON.stringify(rewritten)).toContain("Goal objective: Ship it");
	});

	test("a persisted list gives the same content", async () => {
		const manager = SessionManager.inMemory("/tmp/todo-more-reminders-tests");
		const { host, session: own } = session(manager);
		await runPersisted(host, { input: valid });
		expect(JSON.stringify(contextMessages([nudge()], own, manager))).toContain("1 todo item still open");
	});
});
