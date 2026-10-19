import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { TodoSession } from "../src/commit.ts";
import { registerCtxTasklog } from "../src/ctx/tasklog.ts";
import { runTodo } from "../src/tool.ts";

const created: string[] = [];

afterAll(async () => {
	for (const dir of created) await rm(dir, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
	const result = await Bun.$`git -C ${cwd} ${args}`.quiet().nothrow();
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
	return result.stdout.toString().trim();
}

type ToolResultEvent = { toolName: string; isError: boolean; input: unknown; details: unknown };
type ToolResultHandler = (event: ToolResultEvent, ctx: ExtensionContext) => Promise<void> | void;

/** The host boundary is the only stub: the log file it writes is read back for real. */
function handler(cwd: string, artifactsDir: string): { run: ToolResultHandler; ctx: ExtensionContext } {
	const handlers = new Map<string, ToolResultHandler>();
	const pi = {
		on: (name: string, value: ToolResultHandler) => handlers.set(name, value),
		logger: { warn: () => {} },
	} as unknown as ExtensionAPI;
	registerCtxTasklog(pi);
	const run = handlers.get("tool_result");
	if (run === undefined) throw new Error("Expected a tool_result handler");
	const sessionManager = SessionManager.inMemory(cwd);
	const ctx = {
		sessionManager,
		localProtocolOptions: { getArtifactsDir: () => artifactsDir, getSessionId: () => "tasklog-test" },
	} as unknown as ExtensionContext;
	return { run, ctx };
}

function document(...lines: string[]): string {
	return ["*** Begin Todo", ...lines, "*** End Todo"].join("\n");
}

describe("the ctx task log", () => {
	test("records the commit a completion made, with the done line and the set line", async () => {
		const repo = await mkdtemp(join(tmpdir(), "todo-more-tasklog-"));
		const artifactsDir = await mkdtemp(join(tmpdir(), "todo-more-artifacts-"));
		created.push(repo, artifactsDir);
		await git(repo, "init", "-q", "-b", "main");
		await git(repo, "config", "user.email", "todo-more@example.invalid");
		await git(repo, "config", "user.name", "Todo More Tests");
		await git(repo, "config", "commit.gpgsign", "false");
		await Bun.write(join(repo, "a.txt"), "one\n");
		await git(repo, "add", "-A");
		await git(repo, "commit", "-q", "-m", "initial");

		const session: TodoSession = { sessionManager: SessionManager.inMemory(repo), setTodoPhases: () => {}, model: undefined };
		const initialized = await runTodo(session, {
			input: document('INIT "Commit the work" "git holds the commit" "The log names it"', 'ADD "Implement" "Change the tracked file" 5'),
		});
		await Bun.write(join(repo, "a.txt"), "two\n");
		const result = await runTodo(session, { input: document('DONE "Implement" "Implement the change"') });
		expect(result.isError).not.toBe(true);

		const { run, ctx } = handler(repo, artifactsDir);
		for (const details of [initialized.details, result.details]) {
			await run({ toolName: "todo", isError: false, input: {}, details }, ctx);
		}

		const logDir = join(artifactsDir, "local", "task-log");
		const files = await readdir(logDir);
		expect(files).toHaveLength(1);
		const log = await readFile(join(logDir, files[0]!), "utf8");
		const sha = (await git(repo, "rev-parse", "HEAD")).slice(0, 7);
		expect(log).toContain(`todo done: "Implement" (commit ${sha} "Implement the change")`);
		expect(log).toContain("todo init: 1 phases / 1 tasks");
		expect(log).toContain("todo-more set:");
	});
});
