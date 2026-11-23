import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { ChangeJournal } from "@oh-my-pi/pi-coding-agent/commit/selective/journal";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { acceptanceGuard, type CheckTarget, type JudgeReply, judgeVerdict, parseJudgeAnswer } from "../src/acceptance.ts";
import { liveState } from "../src/commit.ts";
import type { ProjectConfigState, TailCheck, TailItemRule } from "../src/project-config.ts";
import { TODO_NG_NOTES_TYPE } from "../src/state.ts";
import { runTodo, type TodoEnv, type TodoNgDetails } from "../src/tool.ts";
import { hostSession, todoResultMessage } from "./host.ts";

const created: string[] = [];
afterAll(async () => {
	for (const dir of created) await rm(dir, { recursive: true, force: true });
});

async function scratch(prefix: string): Promise<string> {
	const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
	created.push(dir);
	return dir;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	return (await Bun.$`git -C ${cwd} ${args}`.quiet()).stdout.toString().trim();
}

async function repository(): Promise<string> {
	const cwd = await scratch("todo-ng-acceptance-repo-");
	await git(cwd, "init", "-q", "-b", "main");
	await git(cwd, "config", "user.email", "todo-ng@example.invalid");
	await git(cwd, "config", "user.name", "Todo NG Tests");
	await git(cwd, "config", "commit.gpgsign", "false");
	await Bun.write(join(cwd, "a.txt"), "a0\n");
	await git(cwd, "add", "-A");
	await git(cwd, "commit", "-q", "-m", "initial");
	return cwd;
}

const goal = { title: "Ship", summary: "Measured", acceptance: "Done" };

function checkedRule(check: TailCheck | null): TailItemRule {
	return {
		id: "verify",
		phase: "Verification",
		title: "Verify",
		detail: "Run the check",
		minutes: null,
		scope: "main",
		protected: true,
		check,
	};
}

function projectOf(check: TailCheck | null): ProjectConfigState {
	return {
		kind: "ok",
		config: { effects: { editGate: true, commit: true, overtime: true, cutOff: true }, tailItems: [checkedRule(check)] },
	};
}

const shell = (command: string, timeoutMs = 10_000): TailCheck => ({ kind: "shell", command, timeoutMs });

const textOf = (result: AgentToolResult<TodoNgDetails>) => result.content.map((part) => (part.type === "text" ? part.text : "")).join("");

async function harness(check: TailCheck | null) {
	const cwd = await repository();
	const manager = SessionManager.create(cwd, await scratch("todo-ng-acceptance-sessions-"));
	const session = hostSession(manager);
	const env: Partial<TodoEnv> = { project: projectOf(check), acceptance: [acceptanceGuard(Settings.isolated())] };
	const call = async (raw: unknown, overrides: Partial<TodoEnv> = {}) => {
		const result = await runTodo(session, raw, { ...env, ...overrides });
		manager.appendMessage(todoResultMessage(result.details, Date.now(), result.isError === true));
		return result;
	};
	const edit = async (file: string, content: string) => {
		const path = join(cwd, file);
		const before = (await Bun.file(path).exists()) ? await Bun.file(path).text() : null;
		await Bun.write(path, content);
		const artifacts = manager.getArtifactsDir();
		if (artifacts === null) throw new Error("the session keeps no artifacts directory");
		ChangeJournal.at(artifacts).recordChange({ agent: MAIN_AGENT_ID, tool: "edit", path, before, after: content });
	};
	const statuses = () => {
		const state = liveState(session);
		return state.kind === "empty" ? [] : state.phases.flatMap((phase) => phase.items.map((item) => item.progress.status));
	};
	const notes = () => manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === TODO_NG_NOTES_TYPE).length;
	const commits = () => git(cwd, "rev-list", "--count", "HEAD");
	await call({ goal, add: [{ phase: "Work", title: "Build", detail: "Do Build", minutes: 10 }] });
	return { cwd, call, edit, statuses, notes, commits };
}

describe("shell check", () => {
	test("exit 0 completes the tail item and its commit clause lands", async () => {
		const h = await harness(shell("test -f a.txt && echo checked"));
		expect((await h.call({ done_id: "t1" })).isError).toBeUndefined();
		await h.edit("a.txt", "a1\n");
		const before = Number(await h.commits());
		const done = await h.call({ done_id: "t2", commit: { message: "verified" } });
		expect(done.isError).toBeUndefined();
		expect(h.statuses()).toEqual(["completed", "completed"]);
		expect(Number(await h.commits())).toBe(before + 1);
		expect(await git(h.cwd, "log", "-1", "--format=%s")).toBe("verified");
	});

	test("a non-zero exit keeps the item open with the exit code and output tail, without commit or notes", async () => {
		const h = await harness(shell("echo first-line; echo boom-out >&2; exit 3"));
		await h.call({ done_id: "t1" });
		await h.edit("a.txt", "a1\n");
		const commits = await h.commits();
		const notes = h.notes();
		const refused = await h.call({ done_id: "t2", commit: { message: "verified" } });
		expect(refused.isError).toBe(true);
		const text = textOf(refused);
		expect(text).toContain('Task "Verify" (t2) stays open: the check of project rule "verify" did not pass:');
		expect(text).toContain(`exited with 3 in ${h.cwd}`);
		expect(text).toContain("first-line");
		expect(text).toContain("boom-out");
		expect(await h.commits()).toBe(commits);
		expect(h.notes()).toBe(notes);
		expect(h.statuses()).toEqual(["completed", "in_progress"]);
		expect(await git(h.cwd, "status", "--short")).toBe("M a.txt");
	});

	test("a command over its timeout is refused with the threshold", async () => {
		const h = await harness(shell("echo started; sleep 5", 300));
		await h.call({ done_id: "t1" });
		const started = Date.now();
		const refused = await h.call({ done_id: "t2" });
		expect(Date.now() - started).toBeLessThan(4000);
		expect(refused.isError).toBe(true);
		expect(textOf(refused)).toContain("timed out after 300 ms");
		expect(h.statuses()).toEqual(["completed", "in_progress"]);
	});

	test("aborting the call cancels the command and keeps the item open", async () => {
		const h = await harness(shell("sleep 5"));
		await h.call({ done_id: "t1" });
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 200);
		const started = Date.now();
		const refused = await h.call({ done_id: "t2" }, { signal: controller.signal });
		expect(Date.now() - started).toBeLessThan(4000);
		expect(refused.isError).toBe(true);
		expect(textOf(refused)).toContain("was cancelled before it finished");
		expect(h.statuses()).toEqual(["completed", "in_progress"]);
	});

	test("items without a check never run the command", async () => {
		const marker = "check-ran";
		const h = await harness(shell(`touch ${marker}`));
		expect((await h.call({ done_id: "t1" })).isError).toBeUndefined();
		expect(await Bun.file(join(h.cwd, marker)).exists()).toBe(false);
		const unchecked = await harness(null);
		expect((await unchecked.call({ done_id: "t1" })).isError).toBeUndefined();
		expect((await unchecked.call({ done_id: "t2" })).isError).toBeUndefined();
		expect(unchecked.statuses()).toEqual(["completed", "completed"]);
	});
});

describe("judge check", () => {
	const check = { kind: "judge", prompt: "The build is green", timeoutMs: 5000 } as const;
	const target: CheckTarget = { completion: { id: "t2", title: "Verify" }, rule: checkedRule(check), check } as CheckTarget;
	const kindOf = (reply: JudgeReply) => judgeVerdict(target, check, reply);

	test("only a parsed pass verdict completes the item", () => {
		expect(kindOf({ kind: "text", text: '{"verdict":"pass","reason":"tests are green"}', model: "p/m", failures: [] })).toEqual({
			kind: "allow",
			note: 'Check of project rule "verify" passed: the judge p/m found the condition met: tests are green',
			patch: null,
		});
		const refusals: [JudgeReply, string][] = [
			[
				{ kind: "text", text: '{"verdict":"fail","reason":"tests are red"}', model: "p/m", failures: [] },
				"found the condition not met: tests are red",
			],
			[{ kind: "text", text: "looks fine to me", model: "p/m", failures: [] }, 'could not be parsed: "looks fine to me"'],
			[{ kind: "text", text: '{"verdict":"maybe","reason":"unsure"}', model: "p/m", failures: [] }, "could not be parsed"],
			[{ kind: "no-model" }, "no online model is bound to the model role @omp-todo-ng or default"],
			[{ kind: "deadline" }, "did not answer within 5000 ms"],
			[{ kind: "cancelled" }, "cancelled before it answered"],
			[{ kind: "all-failed", failures: ["p/a: 400", "p/b: 429"] }, "every judge model failed: p/a: 400; p/b: 429"],
			[{ kind: "error", error: "registry missing" }, "the judge could not run: registry missing"],
		];
		for (const [reply, message] of refusals) {
			const verdict = kindOf(reply);
			expect(verdict.kind).toBe("reject");
			expect(verdict.kind === "reject" ? verdict.message : "").toContain(message);
		}
	});

	test("the answer parser takes one JSON object, even wrapped in prose or a fence", () => {
		expect(parseJudgeAnswer('```json\n{"verdict":"fail","reason":"no test run"}\n```')).toEqual({ verdict: "fail", reason: "no test run" });
		expect(parseJudgeAnswer('{"verdict":"pass","reason":"  "}')).toBeNull();
		expect(parseJudgeAnswer('{"verdict":"pass"')).toBeNull();
	});

	test("without an extension context the judge refuses the completion", async () => {
		const h = await harness(check);
		await h.call({ done_id: "t1" });
		const refused = await h.call({ done_id: "t2" });
		expect(refused.isError).toBe(true);
		expect(textOf(refused)).toContain("the judge could not run: this todo call carries no extension context");
		expect(h.statuses()).toEqual(["completed", "in_progress"]);
	});
});
