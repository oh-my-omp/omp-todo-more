import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TODO_TOOL_DEFINITION } from "../index.ts";
import { omompTool } from "../omomp-shared/tool-entry.ts";
import { registerPlanning } from "../src/planning.ts";
import type { TodoNgDetails } from "../src/tool.ts";
import { hostSession, todoResultMessage } from "./host.ts";

const registered: { id: string; ref: ReturnType<AgentRegistry["register"]> }[] = [];

afterEach(() => {
	for (const { id, ref } of registered.splice(0)) AgentRegistry.global().unregister(id, ref);
});

function createRegisteredHarness(cwd = "/tmp/todo-ng-entry-tests") {
	const manager = SessionManager.inMemory(cwd);
	const base = hostSession(manager);
	const session = Object.setPrototypeOf(base, AgentSession.prototype) as AgentSession;
	const agentId = `entry-${crypto.randomUUID()}`;
	const ref = AgentRegistry.global().register({ id: agentId, displayName: "Entry test", kind: "main", session });
	registered.push({ id: agentId, ref });
	const ctx = { cwd, sessionManager: manager, agent: { id: agentId, kind: "main" } } as unknown as ExtensionContext;
	const tool = omompTool(TODO_TOOL_DEFINITION);
	const call = async (params: unknown): Promise<AgentToolResult<TodoNgDetails>> => {
		const result = await tool.execute("call-1", params as never, undefined, undefined, ctx);
		manager.appendMessage(todoResultMessage(result.details, Date.now(), result.isError === true));
		return result;
	};
	return { tool, call, session, manager, ctx };
}

function textOf(result: AgentToolResult<TodoNgDetails>): string {
	return (result.content[0] as { text: string }).text;
}

describe("omompTool registration and empty-argument normalization", () => {
	test("registers the main tool definition with lenientArgValidation enabled", () => {
		const tool = omompTool(TODO_TOOL_DEFINITION);
		expect((tool as ToolDefinition & { lenientArgValidation?: boolean }).lenientArgValidation).toBe(true);
	});

	test("treats empty optional fields and all-empty calls as omitted", async () => {
		const { call, session } = createRegisteredHarness();
		const init = await call({
			goal: { title: "Normalize args", summary: "Empty fields omitted", acceptance: "All calls succeed" },
			add: [
				{ phase: "   ", title: "Task one", detail: "First item", minutes: 10 },
				{ phase: "Build", title: "Task two", detail: "Second item", minutes: 15 },
			],
			start_id: "",
			explain: [],
			estimate: [],
			done_id: "   ",
			commit: {},
			drop_ids: [],
			view: null,
		});
		expect(init.isError).not.toBe(true);
		expect(session.getTodoPhases().map((phase) => phase.name)).toEqual(["Tasks", "Build"]);

		const allEmptyView = await call({
			goal: { title: " ", summary: "", acceptance: "  " },
			add: [],
			start_id: "",
			explain: [],
			estimate: [],
			done_id: "",
			commit: { message: " ", paths: [] },
			drop_ids: [],
			view: "",
		});
		expect(allEmptyView.isError).not.toBe(true);
		expect(allEmptyView.details?.op).toBe("view");
		expect(textOf(allEmptyView)).toContain("Task one");
		expect(textOf(allEmptyView)).toContain("Task two");

		const currentView = await call({ view: "current", add: [] });
		expect(currentView.isError).not.toBe(true);
		expect(currentView.details?.op).toBe("view");
		expect(textOf(currentView)).toContain("[t1] [in_progress]");

		const startSecond = await call({ start_id: "t2", drop_ids: [], view: "   " });
		expect(startSecond.isError).not.toBe(true);
		expect(session.getTodoPhases()[1]?.tasks[0]?.status).toBe("in_progress");
	});

	test("refuses empty array elements with index while leaving todo state and git intact", async () => {
		const dir = mkdtempSync(join(tmpdir(), "todo-ng-entry-git-"));
		Bun.spawnSync(["git", "-C", dir, "init"], { stdout: "ignore", stderr: "ignore" });
		Bun.spawnSync(["git", "-C", dir, "config", "user.email", "test@example.com"], { stdout: "ignore", stderr: "ignore" });
		Bun.spawnSync(["git", "-C", dir, "config", "user.name", "Test"], { stdout: "ignore", stderr: "ignore" });
		writeFileSync(join(dir, "tracked.txt"), "v1\n");
		Bun.spawnSync(["git", "-C", dir, "add", "tracked.txt"], { stdout: "ignore", stderr: "ignore" });
		Bun.spawnSync(["git", "-C", dir, "commit", "-m", "init"], { stdout: "ignore", stderr: "ignore" });
		writeFileSync(join(dir, "tracked.txt"), "v2\n");

		const { call, session } = createRegisteredHarness(dir);
		await call({
			goal: { title: "Git check", summary: "Keep clean", acceptance: "No commit on error" },
			add: [{ title: "Finish work", detail: "Do it", minutes: 10 }],
		});

		await expect(call({ drop_ids: ["t1", "   "] })).rejects.toThrow("drop_ids[1]: array element must not be empty");
		expect(session.getTodoPhases()[0]?.tasks[0]?.status).toBe("in_progress");

		await expect(
			call({
				done_id: "t1",
				commit: { message: "feat: finish", paths: ["tracked.txt", ""] },
			}),
		).rejects.toThrow("commit.paths[1]: array element must not be empty");
		expect(session.getTodoPhases()[0]?.tasks[0]?.status).toBe("in_progress");
		const logCount = Bun.spawnSync(["git", "-C", dir, "rev-list", "--count", "HEAD"], { stdout: "pipe" }).stdout.toString().trim();
		expect(logCount).toBe("1");

		await expect(call({ add: [{ phase: "  " }] })).rejects.toThrow("add[0]: array element must not be empty");
	});

	test("still rejects blank required fields, view with mutation, and commit without done_id", async () => {
		const { call } = createRegisteredHarness();
		await expect(
			call({
				goal: { title: "   ", summary: "m", acceptance: "d" },
				add: [{ title: "Item", detail: "d", minutes: 5 }],
			}),
		).rejects.toThrow("Validation failed");
		await expect(
			call({
				goal: { title: "g", summary: "m", acceptance: "d" },
				add: [{ title: "", detail: "d", minutes: 5 }],
			}),
		).rejects.toThrow("Validation failed");
		await expect(
			call({
				done_id: "t1",
				commit: { message: "   ", paths: ["a.txt"] },
			}),
		).rejects.toThrow("Validation failed");

		const viewPlusMutation = await call({ view: "all", start_id: "t1" });
		expect(viewPlusMutation.isError).toBe(true);
		expect(textOf(viewPlusMutation)).toContain("Cannot combine view with todo updates");

		const commitWithoutDone = await call({ commit: { message: "orphan" } });
		expect(commitWithoutDone.isError).toBe(true);
		expect(textOf(commitWithoutDone)).toContain("commit is only valid with done_id");
	});

	test("planning edit-gate preview accepts empty optional fields and rejects empty array elements", async () => {
		const handlers = new Map<string, ((event: Record<string, unknown>, ctx: ExtensionContext) => unknown)[]>();
		const pi = {
			on: (name: string, handler: (event: Record<string, unknown>, ctx: ExtensionContext) => unknown) =>
				handlers.set(name, [...(handlers.get(name) ?? []), handler]),
			logger: { warn: () => {} },
		} as unknown as ExtensionAPI;
		registerPlanning(pi);
		const { session, ctx } = createRegisteredHarness();
		const emitToolCall = async (toolName: string, input: Record<string, unknown>) => {
			let last: unknown;
			for (const handler of handlers.get("tool_call") ?? []) {
				last = (await handler({ type: "tool_call", toolName, toolCallId: crypto.randomUUID(), input }, ctx)) ?? last;
			}
			return last as { block?: boolean } | undefined;
		};

		await emitToolCall("todo", {
			goal: { title: "g", summary: "m", acceptance: "d" },
			add: [{ phase: "   ", title: "Step", detail: "Do step", minutes: 5 }],
			start_id: "",
			drop_ids: [],
		});
		expect(await emitToolCall("edit", { path: "a.ts" })).toBeUndefined();

		const manager = session.sessionManager;
		expect(manager).toBeDefined();
		for (const handler of handlers.get("turn_end") ?? []) await handler({ type: "turn_end" }, ctx);

		await emitToolCall("todo", {
			goal: { title: "g", summary: "m", acceptance: "d" },
			add: [{ phase: "P", title: "Step", detail: "Do step", minutes: 5 }],
			drop_ids: [""],
		});
		expect((await emitToolCall("edit", { path: "a.ts" }))?.block).toBe(true);
	});

	test("subagent restoreTodo wraps RPC host tools with omompTool", async () => {
		const { default: todoNg } = await import("../index.ts");
		const handlers = new Map<string, ((event: Record<string, unknown>, ctx: ExtensionContext) => unknown)[]>();
		let registeredTool: ToolDefinition | undefined;
		const pi = {
			on: (name: string, handler: (event: Record<string, unknown>, ctx: ExtensionContext) => unknown) =>
				handlers.set(name, [...(handlers.get(name) ?? []), handler]),
			registerTool: (def: ToolDefinition) => {
				registeredTool = def;
			},
			registerCommand: () => {},
			registerShortcut: () => {},
			registerMessageRenderer: () => {},
			events: { on: () => () => {} },
			logger: { warn: () => {} },
		} as unknown as ExtensionAPI;
		await todoNg(pi);
		expect((registeredTool as (ToolDefinition & { lenientArgValidation?: boolean }) | undefined)?.lenientArgValidation).toBe(true);

		const manager = SessionManager.inMemory("/tmp/todo-ng-subagent-restore");
		const base = hostSession(manager);
		let rpcTools: AgentTool[] = [];
		let hook: (() => Promise<void>) | undefined;
		const session = Object.assign(Object.setPrototypeOf(base, AgentSession.prototype) as AgentSession, {
			getEnabledToolNames: () => ["edit"],
			getAllToolNames: () => ["edit"],
			getAllToolInfos: () => [],
			setActiveToolsByName: async () => {},
			refreshRpcHostTools: async (tools: AgentTool[]) => {
				rpcTools = tools;
			},
			agent: {
				addBeforeModelCallHook: (fn: () => Promise<void>) => {
					hook = fn;
				},
			},
		});
		const agentId = `sub-${crypto.randomUUID()}`;
		const ref = AgentRegistry.global().register({ id: agentId, displayName: "Sub", kind: "sub", session });
		registered.push({ id: agentId, ref });
		const ctx = {
			cwd: "/tmp/todo-ng-subagent-restore",
			sessionManager: manager,
			agent: { id: agentId, kind: "sub" },
		} as unknown as ExtensionContext;

		for (const handler of handlers.get("before_agent_start") ?? []) await handler({ type: "before_agent_start" }, ctx);
		expect(hook).toBeDefined();
		await hook?.();
		expect(rpcTools).toHaveLength(1);
		expect(rpcTools[0]?.lenientArgValidation).toBe(true);
		const viewResult = await rpcTools[0]?.execute("sub-1", { view: "", drop_ids: [] });
		expect(viewResult?.isError).not.toBe(true);
	});
});
