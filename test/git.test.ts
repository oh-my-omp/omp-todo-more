import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { TodoSession } from "../src/commit.ts";
import type { ModelRef } from "../src/models.ts";
import { type CommitRecord, readTodoMore, type TodoMoreSnapshot, toSnapshot } from "../src/state.ts";
import { type ParentCwd, runTodo, type TodoMoreDetails } from "../src/tool.ts";

const goal = {
	objective: "Commit the work each item completes",
	measure: "git holds a commit for the item, and the item records it",
	doneWhen: "The checkout is clean and the item carries the commit git accepted",
};
const init = `INIT ${JSON.stringify(goal.objective)} ${JSON.stringify(goal.measure)} ${JSON.stringify(goal.doneWhen)}`;
const created: string[] = [];

afterAll(async () => {
	for (const dir of created) await rm(dir, { recursive: true, force: true });
});

function document(...lines: string[]): string {
	return ["*** Begin Todo", ...lines, "*** End Todo"].join("\n");
}

/** Real git, so every assertion here reads the repository itself, not a stub. */
async function git(cwd: string, ...args: string[]): Promise<string> {
	const result = await Bun.$`git -C ${cwd} ${args}`.quiet().nothrow();
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
	return result.stdout.toString().trim();
}

/** A real checkout: one commit, signing off, and the session's cwd is its root. */
async function repository(files: Record<string, string>): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "todo-more-git-"));
	created.push(cwd);
	await git(cwd, "init", "-q", "-b", "main");
	await git(cwd, "config", "user.email", "todo-more@example.invalid");
	await git(cwd, "config", "user.name", "Todo More Tests");
	await git(cwd, "config", "commit.gpgsign", "false");
	for (const [name, body] of Object.entries(files)) await Bun.write(join(cwd, name), body);
	await git(cwd, "add", "-A");
	await git(cwd, "commit", "-q", "-m", "initial");
	return cwd;
}

type Harness = {
	cwd: string;
	session: TodoSession;
	call: (...lines: string[]) => Promise<AgentToolResult<TodoMoreDetails>>;
	snapshot: () => TodoMoreSnapshot;
};

function fixture(cwd: string, model?: ModelRef, parentCwd?: ParentCwd): Harness {
	const sessionManager = SessionManager.inMemory(cwd);
	const session: TodoSession = { sessionManager, setTodoPhases: () => {}, model };
	return {
		cwd,
		session,
		call: (...lines: string[]) => runTodo(session, { input: document(...lines) }, parentCwd),
		snapshot: (): TodoMoreSnapshot => toSnapshot(readTodoMore(sessionManager.getBranch())),
	};
}

function itemOf(snapshot: TodoMoreSnapshot, title: string) {
	const item = snapshot.phases.flatMap((phase) => phase.items).find((candidate) => candidate.title === title);
	if (item === undefined) throw new Error(`Expected task ${title}`);
	return item;
}

const textOf = (result: { content: { type: string; text?: string }[] }): string =>
	result.content.flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : [])).join("\n");

function commitOf(harness: Harness, title: string): CommitRecord {
	const commit = itemOf(harness.snapshot(), title).commit;
	if (commit === undefined) throw new Error(`Expected a commit on ${title}`);
	return commit;
}

/** A settled assistant turn on the session's branch, as the host persists it. */
function reply(harness: Harness, provider: string, model: string, stopReason: AssistantMessage["stopReason"] = "stop"): void {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "anthropic-messages",
		provider,
		model,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
	harness.session.sessionManager.appendMessage(message);
}

const trailers = (cwd: string, revision: string): Promise<string> =>
	git(cwd, "log", "-1", "--format=%(trailers:key=Model,valueonly)", revision);

describe("the git association of a completion", () => {
	test("the session's directory is the repository under test", async () => {
		const harness = fixture(await repository({ "a.txt": "one\n" }));
		expect(harness.session.sessionManager.getCwd()).toBe(harness.cwd);
	});

	test("a message commits every change and records the commit git accepted", async () => {
		const harness = fixture(await repository({ "a.txt": "one\n" }));
		await harness.call(init, 'ADD "Implement" "Change the tracked file" 5');
		await Bun.write(join(harness.cwd, "a.txt"), "two\n");
		await Bun.write(join(harness.cwd, "b.txt"), "new\n");
		const result = await harness.call('DONE "Implement" "Implement the change"');

		expect(result.isError).not.toBe(true);
		const head = await git(harness.cwd, "rev-parse", "HEAD");
		const commit = commitOf(harness, "Implement");
		expect(commit).toEqual({ sha: head, message: "Implement the change", scope: { kind: "all" } });
		expect(await git(harness.cwd, "log", "-1", "--format=%s")).toBe("Implement the change");
		expect(await git(harness.cwd, "log", "-1", "--format=%an")).toBe("Todo More Tests");
		expect(await git(harness.cwd, "status", "--porcelain")).toBe("");
		expect(itemOf(harness.snapshot(), "Implement").status).toBe("completed");
		expect(textOf(result)).toContain(`Committed ${head.slice(0, 7)} "Implement the change" (all changes)`);
	});

	test("uncommitted work refuses a completion that carries no clause", async () => {
		const harness = fixture(await repository({ "a.txt": "one\n" }));
		await harness.call(init, 'ADD "Implement" "Change the tracked file" 5');
		const head = await git(harness.cwd, "rev-parse", "HEAD");
		await Bun.write(join(harness.cwd, "a.txt"), "two\n");

		const result = await harness.call('DONE "Implement"');
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain(`Task "Implement" would leave uncommitted work in ${harness.cwd}`);
		expect(textOf(result)).toContain('re-issue DONE "title" "<message>" to commit every change');
		expect(itemOf(harness.snapshot(), "Implement").status).not.toBe("completed");
		expect(await git(harness.cwd, "rev-parse", "HEAD")).toBe(head);
		expect(await git(harness.cwd, "status", "--porcelain")).toBe("M a.txt");
	});

	test("a scoped clause commits its pathspecs and leaves the rest uncommitted", async () => {
		const harness = fixture(await repository({ "a.txt": "one\n", "b.txt": "one\n" }));
		await harness.call(init, 'ADD "Implement" "Change one tracked file" 5');
		await Bun.write(join(harness.cwd, "a.txt"), "two\n");
		await Bun.write(join(harness.cwd, "b.txt"), "two\n");

		const result = await harness.call('DONE "Implement" "a.txt" "Change only a"');
		expect(result.isError).not.toBe(true);
		const committed = await git(harness.cwd, "show", "--stat", "--format=%s", "HEAD");
		expect(committed).toContain("Change only a");
		expect(committed).toContain("a.txt |");
		expect(committed).not.toContain("b.txt");
		expect(await git(harness.cwd, "status", "--porcelain")).toBe("M b.txt");
		expect(commitOf(harness, "Implement")).toEqual({
			sha: await git(harness.cwd, "rev-parse", "HEAD"),
			message: "Change only a",
			scope: { kind: "paths", files: ["a.txt"] },
		});
	});

	test("a scope that stages nothing is refused with git's own answer", async () => {
		const harness = fixture(await repository({ "a.txt": "one\n" }));
		await harness.call(init, 'ADD "Implement" "Change the tracked file" 5');
		await Bun.write(join(harness.cwd, "a.txt"), "two\n");

		const result = await harness.call('DONE "Implement" "missing.txt" "Change a missing file"');
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain('The scope "missing.txt" staged nothing');
		expect(itemOf(harness.snapshot(), "Implement").status).not.toBe("completed");
	});

	test("a clean checkout and a directory outside git leave the clause inert", async () => {
		const clean = fixture(await repository({ "a.txt": "one\n" }));
		await clean.call(init, 'ADD "Verify" "Change nothing at all" 5');
		const cleanHead = await git(clean.cwd, "rev-parse", "HEAD");
		const inert = await clean.call('DONE "Verify" "Nothing to commit here"');
		expect(inert.isError).not.toBe(true);
		expect(textOf(inert)).toContain("Nothing to commit: the working tree is clean");
		expect(itemOf(clean.snapshot(), "Verify").commit).toBeUndefined();
		expect(await git(clean.cwd, "rev-parse", "HEAD")).toBe(cleanHead);

		const outside = await mkdtemp(join(tmpdir(), "todo-more-plain-"));
		created.push(outside);
		const plain = fixture(outside);
		await plain.call(init, 'ADD "Verify" "Change nothing at all" 5');
		const none = await plain.call('DONE "Verify" "No repository to commit in"');
		expect(none.isError).not.toBe(true);
		expect(textOf(none)).toContain("No git repository here");
		expect(itemOf(plain.snapshot(), "Verify").commit).toBeUndefined();
	});

	test("each completion in one batch commits its own work, and the second clause is inert once the tree is clean", async () => {
		const harness = fixture(await repository({ "a.txt": "one\n" }));
		await harness.call(init, 'ADD "First" "Change a.txt" 5', 'ADD "Second" "Change nothing" 5');
		await Bun.write(join(harness.cwd, "a.txt"), "two\n");

		const result = await harness.call('DONE "First" "Commit the first item"', 'DONE "Second" "Commit the second item"');
		expect(result.isError).not.toBe(true);
		expect(commitOf(harness, "First")).toEqual({
			sha: await git(harness.cwd, "rev-parse", "HEAD"),
			message: "Commit the first item",
			scope: { kind: "all" },
		});
		expect(itemOf(harness.snapshot(), "Second").commit).toBeUndefined();
		expect(textOf(result)).toContain("Nothing to commit: the working tree is clean");
		expect(await git(harness.cwd, "log", "--format=%s")).toBe("Commit the first item\ninitial");
	});

	test("a committed completion survives the branch and the host projection", async () => {
		const harness = fixture(await repository({ "a.txt": "one\n" }));
		await harness.call(init, 'ADD "Implement" "Change the tracked file" 5');
		await Bun.write(join(harness.cwd, "a.txt"), "two\n");
		const result = await harness.call('DONE "Implement" "Implement the change"');

		const details = result.details as TodoMoreDetails;
		expect(details.changes).toEqual([
			{ op: "done", task: "Implement", commit: { scope: { kind: "all" }, message: "Implement the change" } },
		]);
		expect(details.more).toEqual(harness.snapshot());
		expect(itemOf(harness.snapshot(), "Implement").commit?.sha).toMatch(/^[0-9a-f]{40}$/);
	});
});

describe("a subagent's completion in its parent's worktree", () => {
	const forms = ['DONE "Investigate"', 'DONE "Investigate" "Record the finding"', 'DONE "Investigate" "a.txt" "Record the finding"'];

	test("every DONE form completes without committing or refusing, leaving others' changes alone", async () => {
		const cwd = await repository({ "a.txt": "one\n" });
		await Bun.write(join(cwd, "sub", "keep.txt"), "x\n");
		await git(cwd, "add", "-A");
		await git(cwd, "commit", "-q", "-m", "sub");
		const head = await git(cwd, "rev-parse", "HEAD");
		await Bun.write(join(cwd, "foreign.txt"), "someone else's\n");
		await Bun.write(join(cwd, "a.txt"), "two\n");
		// The parent sits in a subdirectory of the same working tree: roots, not cwd strings, decide.
		const harness = fixture(cwd, undefined, () => join(cwd, "sub"));
		for (const form of forms) {
			await harness.call(init, 'ADD "Investigate" "Read only" 5');
			const result = await harness.call(form);
			expect(result.isError).not.toBe(true);
			expect(textOf(result)).toContain(`Shared worktree with the parent agent (${cwd})`);
			expect(textOf(result)).toContain("the parent agent integrates and commits these changes");
			expect(itemOf(harness.snapshot(), "Investigate").status).toBe("completed");
			expect(itemOf(harness.snapshot(), "Investigate").commit).toBeUndefined();
		}
		expect(await git(cwd, "rev-parse", "HEAD")).toBe(head);
		expect(await git(cwd, "status", "--porcelain")).toBe("M a.txt\n?? foreign.txt");
	});

	test("an unresolved parent keeps the refusal and the commit", async () => {
		const harness = fixture(await repository({ "a.txt": "one\n" }), undefined, () => undefined);
		await harness.call(init, 'ADD "Implement" "Change the tracked file" 5');
		await Bun.write(join(harness.cwd, "a.txt"), "two\n");

		const refused = await harness.call('DONE "Implement"');
		expect(refused.isError).toBe(true);
		expect(textOf(refused)).toContain(`Task "Implement" would leave uncommitted work in ${harness.cwd}`);
		const committed = await harness.call('DONE "Implement" "Implement the change"');
		expect(committed.isError).not.toBe(true);
		expect(commitOf(harness, "Implement").sha).toBe(await git(harness.cwd, "rev-parse", "HEAD"));
	});

	test("a parent in another linked worktree of the same repository keeps the refusal and the commit", async () => {
		const parent = await repository({ "a.txt": "one\n" });
		const isolated = await mkdtemp(join(tmpdir(), "todo-more-linked-"));
		created.push(isolated);
		await rm(isolated, { recursive: true, force: true });
		await git(parent, "worktree", "add", "-q", "-b", "child", isolated);
		await Bun.write(join(parent, "foreign.txt"), "parent's\n");
		const harness = fixture(isolated, undefined, () => parent);
		await harness.call(init, 'ADD "Implement" "Change the tracked file" 5');
		await Bun.write(join(isolated, "a.txt"), "two\n");

		const refused = await harness.call('DONE "Implement"');
		expect(refused.isError).toBe(true);
		expect(textOf(refused)).toContain('Task "Implement" would leave uncommitted work');
		const committed = await harness.call('DONE "Implement" "Implement the change"');
		expect(committed.isError).not.toBe(true);
		expect(await git(isolated, "log", "-1", "--format=%s")).toBe("Implement the change");
		expect(await git(parent, "log", "-1", "--format=%s", "main")).toBe("initial");
		expect(await git(parent, "status", "--porcelain")).toBe("?? foreign.txt");
	});
});

describe("the Model trailers of a completion's commit", () => {
	test("name each model of the session since its previous todo commit once, in order of first use", async () => {
		const harness = fixture(await repository({ "a.txt": "one\n" }), { provider: "anthropic", id: "claude-opus-5-5" });
		await harness.call(init, 'ADD "First" "Change a.txt" 5', 'ADD "Second" "Change a.txt again" 5');
		reply(harness, "openai-codex", "gpt-6-luna");
		reply(harness, "anthropic", "claude-opus-5-5");
		reply(harness, "openai-codex", "gpt-6-luna");
		reply(harness, "zai", "glm-5.2", "error");
		await Bun.write(join(harness.cwd, "a.txt"), "two\n");
		await harness.call('DONE "First" "Commit the first item"');

		expect(await git(harness.cwd, "log", "-1", "--format=%B")).toBe(
			"Commit the first item\n\nModel: openai-codex/gpt-6-luna\nModel: anthropic/claude-opus-5-5",
		);
		expect(commitOf(harness, "First").message).toBe("Commit the first item");

		reply(harness, "bansos", "muse-spark-1.3-contributor");
		await Bun.write(join(harness.cwd, "a.txt"), "three\n");
		await harness.call('DONE "Second" "Commit the second item"');
		expect(await trailers(harness.cwd, "HEAD")).toBe("bansos/muse-spark-1.3-contributor\nanthropic/claude-opus-5-5");
		expect(await git(harness.cwd, "log", "-1", "--format=%s")).toBe("Commit the second item");
	});

	test("a session with no model on record commits the message alone", async () => {
		const harness = fixture(await repository({ "a.txt": "one\n" }));
		await harness.call(init, 'ADD "Implement" "Change the tracked file" 5');
		await Bun.write(join(harness.cwd, "a.txt"), "two\n");
		await harness.call('DONE "Implement" "Implement the change"');
		expect(await git(harness.cwd, "log", "-1", "--format=%B")).toBe("Implement the change");
	});
});
