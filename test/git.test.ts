import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { ChangeJournal } from "@oh-my-pi/pi-coding-agent/commit/selective/journal";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { readTodoMore } from "../src/branch.ts";
import type { TodoSession } from "../src/commit.ts";
import type { ModelRef } from "../src/models.ts";
import { type CommitRecord, type TodoMoreSnapshot, toSnapshot } from "../src/state.ts";
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

async function git(cwd: string, ...args: string[]): Promise<string> {
	const result = await Bun.$`git -C ${cwd} ${args}`.quiet().nothrow();
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
	return result.stdout.toString().trim();
}

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
	edit: (file: string, content: string) => Promise<void>;
};

type FixtureOptions = { readonly model?: ModelRef; readonly parentCwd?: ParentCwd; readonly journaled?: boolean };

async function sessionManagerFor(cwd: string, journaled: boolean): Promise<SessionManager> {
	if (!journaled) return SessionManager.inMemory(cwd);
	const dir = await mkdtemp(join(tmpdir(), "todo-more-sessions-"));
	created.push(dir);
	return SessionManager.create(cwd, dir);
}

async function fixture(cwd: string, options: FixtureOptions = {}): Promise<Harness> {
	const sessionManager = await sessionManagerFor(cwd, options.journaled ?? true);
	const session: TodoSession = { sessionManager, setTodoPhases: () => {}, model: options.model };
	return {
		cwd,
		session,
		call: (...lines: string[]) => runTodo(session, { input: document(...lines) }, options.parentCwd),
		snapshot: (): TodoMoreSnapshot => toSnapshot(readTodoMore(sessionManager.getBranch())),
		edit: async (file, content) => {
			const path = join(cwd, file);
			const before = (await Bun.file(path).exists()) ? await Bun.file(path).text() : null;
			await Bun.write(path, content);
			const artifacts = sessionManager.getArtifactsDir();
			if (artifacts !== null)
				ChangeJournal.at(artifacts).recordChange({ agent: MAIN_AGENT_ID, tool: "edit", path, before, after: content });
		},
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
		const harness = await fixture(await repository({ "a.txt": "one\n" }));
		expect(harness.session.sessionManager.getCwd()).toBe(harness.cwd);
	});

	test("a message commits this agent's changes and records the commit git accepted", async () => {
		const harness = await fixture(await repository({ "a.txt": "one\n" }));
		await harness.call(init, 'ADD "Implement" "Change the tracked file" 5');
		await harness.edit("a.txt", "two\n");
		await harness.edit("b.txt", "new\n");
		const result = await harness.call('DONE "Implement" "Implement the change"');

		expect(result.isError).not.toBe(true);
		const head = await git(harness.cwd, "rev-parse", "HEAD");
		const commit = commitOf(harness, "Implement");
		expect(commit).toEqual({ sha: head, message: "Implement the change", scope: { kind: "all" } });
		expect(await git(harness.cwd, "log", "-1", "--format=%s")).toBe("Implement the change");
		expect(await git(harness.cwd, "log", "-1", "--format=%an")).toBe("Todo More Tests");
		expect(await git(harness.cwd, "status", "--porcelain")).toBe("");
		expect(itemOf(harness.snapshot(), "Implement").status).toBe("completed");
		expect(textOf(result)).toContain(`Committed ${head.slice(0, 7)} "Implement the change" (this agent's changes)`);
	});

	test("a message leaves another writer's staged and unstaged changes where they are", async () => {
		const harness = await fixture(await repository({ "mine.txt": "one\n", "other.txt": "one\n", "loose.txt": "one\n" }));
		await harness.call(init, 'ADD "Edit mine" "Change mine.txt" 5');
		await harness.edit("mine.txt", "mine\n");
		await Bun.write(join(harness.cwd, "other.txt"), "other\n");
		await git(harness.cwd, "add", "other.txt");
		await Bun.write(join(harness.cwd, "loose.txt"), "loose\n");

		const result = await harness.call('DONE "Edit mine" "Commit mine"');
		expect(result.isError).not.toBe(true);
		expect(await git(harness.cwd, "show", "--name-only", "--format=", "HEAD")).toBe("mine.txt");
		expect((await Bun.$`git -C ${harness.cwd} status --porcelain`.text()).split("\n").filter(Boolean)).toEqual([
			" M loose.txt",
			"M  other.txt",
		]);
	});

	test("only another writer's changes neither refuse a bare DONE nor give a message anything to commit", async () => {
		const harness = await fixture(await repository({ "mine.txt": "one\n", "other.txt": "one\n" }));
		await harness.call(init, 'ADD "Read" "Change nothing" 5', 'ADD "Skim" "Change nothing either" 5');
		const head = await git(harness.cwd, "rev-parse", "HEAD");
		await Bun.write(join(harness.cwd, "other.txt"), "other\n");

		const bare = await harness.call('DONE "Read"');
		expect(bare.isError).not.toBe(true);
		expect(itemOf(harness.snapshot(), "Read").status).toBe("completed");
		const message = await harness.call('DONE "Skim" "Nothing of mine"');
		expect(message.isError).not.toBe(true);
		expect(textOf(message)).toContain("none of the uncommitted changes are this agent's");
		expect(itemOf(harness.snapshot(), "Skim").commit).toBeUndefined();
		expect(await git(harness.cwd, "rev-parse", "HEAD")).toBe(head);
		expect(await git(harness.cwd, "status", "--porcelain")).toBe("M other.txt");
	});

	test("this agent's uncommitted work refuses a completion that carries no clause", async () => {
		const harness = await fixture(await repository({ "a.txt": "one\n" }));
		await harness.call(init, 'ADD "Implement" "Change the tracked file" 5');
		const head = await git(harness.cwd, "rev-parse", "HEAD");
		await harness.edit("a.txt", "two\n");

		const result = await harness.call('DONE "Implement"');
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain(`Task "Implement" would leave this agent's uncommitted work in ${harness.cwd}`);
		expect(textOf(result)).toContain('re-issue DONE "title" "<message>" to commit this agent\'s changes');
		expect(textOf(result)).toContain('DONE "title" "<paths>" "<message>" to commit a scope');
		expect(itemOf(harness.snapshot(), "Implement").status).not.toBe("completed");
		expect(await git(harness.cwd, "rev-parse", "HEAD")).toBe(head);
		expect(await git(harness.cwd, "status", "--porcelain")).toBe("M a.txt");
	});

	test("a scoped clause commits every change in its paths and leaves the rest uncommitted", async () => {
		const harness = await fixture(await repository({ "a.txt": "one\n", "b.txt": "one\n", "c.txt": "one\n" }));
		await harness.call(init, 'ADD "Implement" "Change one tracked file" 5');
		await harness.edit("a.txt", "two\n");
		await harness.edit("b.txt", "two\n");
		await Bun.write(join(harness.cwd, "c.txt"), "other's\n");
		await git(harness.cwd, "add", "c.txt");

		const result = await harness.call('DONE "Implement" "a.txt c.txt" "Change a and c"');
		expect(result.isError).not.toBe(true);
		const committed = await git(harness.cwd, "show", "--name-only", "--format=%s", "HEAD");
		expect(committed).toBe("Change a and c\n\na.txt\nc.txt");
		expect(await git(harness.cwd, "status", "--porcelain")).toBe("M b.txt");
		expect(commitOf(harness, "Implement")).toEqual({
			sha: await git(harness.cwd, "rev-parse", "HEAD"),
			message: "Change a and c",
			scope: { kind: "paths", files: ["a.txt", "c.txt"] },
		});
	});

	test("a scoped clause leaves a staged change outside its paths staged", async () => {
		const harness = await fixture(await repository({ "a.txt": "one\n", "staged.txt": "one\n" }));
		await harness.call(init, 'ADD "Implement" "Change a.txt" 5');
		await harness.edit("a.txt", "two\n");
		await Bun.write(join(harness.cwd, "staged.txt"), "theirs\n");
		await git(harness.cwd, "add", "staged.txt");

		const result = await harness.call('DONE "Implement" "a.txt" "Change only a"');
		expect(result.isError).not.toBe(true);
		expect(await git(harness.cwd, "show", "--name-only", "--format=", "HEAD")).toBe("a.txt");
		expect(await git(harness.cwd, "status", "--porcelain")).toBe("M  staged.txt");
	});

	test("a scoped clause names a directory or a glob as well as files", async () => {
		const harness = await fixture(await repository({ "src/a.txt": "one\n", "docs/b.md": "one\n", "c.txt": "one\n" }));
		await harness.call(init, 'ADD "Implement" "Change three files" 5');
		await harness.edit("src/a.txt", "two\n");
		await harness.edit("docs/b.md", "two\n");
		await harness.edit("c.txt", "two\n");

		const result = await harness.call('DONE "Implement" "src docs/*.md" "Change src and docs"');
		expect(result.isError).not.toBe(true);
		expect(await git(harness.cwd, "show", "--name-only", "--format=", "HEAD")).toBe("docs/b.md\nsrc/a.txt");
		expect(await git(harness.cwd, "status", "--porcelain")).toBe("M c.txt");
	});

	describe("a scoped clause resolves its paths as git pathspecs from the session directory", () => {
		const files = {
			"src/a.ts": "one\n",
			"src/deep/b.ts": "one\n",
			"c.ts": "one\n",
			"docs/d.md": "one\n",
		};

		async function scoped(spec: string, options: { readonly cwd?: string } = {}) {
			const root = await repository(files);
			const harness = await fixture(options.cwd === undefined ? root : join(root, options.cwd));
			await harness.call(init, 'ADD "Implement" "Change files" 5');
			for (const file of Object.keys(files)) await harness.edit(relative(harness.cwd, join(root, file)), "two\n");
			await harness.edit(relative(harness.cwd, join(root, "src/new.ts")), "new\n");
			const result = await harness.call(`DONE "Implement" ${JSON.stringify(spec)} "Commit the scope"`);
			expect(result.isError).not.toBe(true);
			const committed = (await git(root, "show", "--name-only", "--format=", "HEAD")).split("\n").sort();
			const status = await Bun.$`git -C ${root} status --porcelain`.quiet().text();
			const remaining = status.split("\n").filter((line) => line !== "");
			return { root, committed, remaining, harness };
		}

		test("`.` at the repository root commits every change, including untracked files", async () => {
			const { committed, remaining } = await scoped(".");
			expect(committed).toEqual(["c.ts", "docs/d.md", "src/a.ts", "src/deep/b.ts", "src/new.ts"]);
			expect(remaining).toEqual([]);
		});

		test("`./` is the same as `.`", async () => {
			const { committed } = await scoped("./");
			expect(committed).toEqual(["c.ts", "docs/d.md", "src/a.ts", "src/deep/b.ts", "src/new.ts"]);
		});

		test("`.` in a subdirectory commits that directory's changes and leaves the rest", async () => {
			const { committed, remaining } = await scoped(".", { cwd: "src" });
			expect(committed).toEqual(["src/a.ts", "src/deep/b.ts", "src/new.ts"]);
			expect(remaining).toEqual([" M c.ts", " M docs/d.md"]);
		});

		test("a relative path and a `../` path resolve against a subdirectory session", async () => {
			const inside = await scoped("deep", { cwd: "src" });
			expect(inside.committed).toEqual(["src/deep/b.ts"]);
			const outside = await scoped("../docs", { cwd: "src" });
			expect(outside.committed).toEqual(["docs/d.md"]);
		});

		test("an absolute path is the path itself", async () => {
			const root = await repository(files);
			const harness = await fixture(join(root, "src"));
			await harness.call(init, 'ADD "Implement" "Change files" 5');
			await harness.edit("a.ts", "two\n");
			await harness.edit("../c.ts", "two\n");
			const result = await harness.call(`DONE "Implement" ${JSON.stringify(join(await realpath(root), "c.ts"))} "Commit c"`);
			expect(result.isError).not.toBe(true);
			expect(await git(root, "show", "--name-only", "--format=", "HEAD")).toBe("c.ts");
			expect(await git(root, "status", "--porcelain")).toBe("M src/a.ts");
		});

		test("`*.ts` matches across directory levels", async () => {
			const { committed, remaining } = await scoped("*.ts");
			expect(committed).toEqual(["c.ts", "src/a.ts", "src/deep/b.ts", "src/new.ts"]);
			expect(remaining).toEqual([" M docs/d.md"]);
		});

		test("`src/*.ts` matches the files below src at any depth", async () => {
			const { committed, remaining } = await scoped("src/*.ts");
			expect(committed).toEqual(["src/a.ts", "src/deep/b.ts", "src/new.ts"]);
			expect(remaining).toEqual([" M c.ts", " M docs/d.md"]);
		});
	});

	test("a scope that matches nothing is refused and changes nothing", async () => {
		const harness = await fixture(await repository({ "a.txt": "one\n" }));
		await harness.call(init, 'ADD "Implement" "Change the tracked file" 5');
		await harness.edit("a.txt", "two\n");
		const head = await git(harness.cwd, "rev-parse", "HEAD");

		const result = await harness.call('DONE "Implement" "missing.txt" "Change a missing file"');
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain('The scope "missing.txt" matches no changed path');
		expect(itemOf(harness.snapshot(), "Implement").status).not.toBe("completed");
		expect(await git(harness.cwd, "rev-parse", "HEAD")).toBe(head);
		expect(await git(harness.cwd, "status", "--porcelain")).toBe("M a.txt");
	});

	test("a clean checkout and a directory outside git leave the clause inert", async () => {
		const clean = await fixture(await repository({ "a.txt": "one\n" }));
		await clean.call(init, 'ADD "Verify" "Change nothing at all" 5');
		const cleanHead = await git(clean.cwd, "rev-parse", "HEAD");
		const inert = await clean.call('DONE "Verify" "Nothing to commit here"');
		expect(inert.isError).not.toBe(true);
		expect(textOf(inert)).toContain("Nothing to commit: the working tree is clean");
		expect(itemOf(clean.snapshot(), "Verify").commit).toBeUndefined();
		expect(await git(clean.cwd, "rev-parse", "HEAD")).toBe(cleanHead);

		const outside = await mkdtemp(join(tmpdir(), "todo-more-plain-"));
		created.push(outside);
		const plain = await fixture(outside);
		await plain.call(init, 'ADD "Verify" "Change nothing at all" 5');
		const none = await plain.call('DONE "Verify" "No repository to commit in"');
		expect(none.isError).not.toBe(true);
		expect(textOf(none)).toContain("No git repository here");
		expect(itemOf(plain.snapshot(), "Verify").commit).toBeUndefined();
	});

	test("each completion in one batch commits its own work, and the second clause is inert once the tree is clean", async () => {
		const harness = await fixture(await repository({ "a.txt": "one\n" }));
		await harness.call(init, 'ADD "First" "Change a.txt" 5', 'ADD "Second" "Change nothing" 5');
		await harness.edit("a.txt", "two\n");

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
		const harness = await fixture(await repository({ "a.txt": "one\n" }));
		await harness.call(init, 'ADD "Implement" "Change the tracked file" 5');
		await harness.edit("a.txt", "two\n");
		const result = await harness.call('DONE "Implement" "Implement the change"');

		const details = result.details as TodoMoreDetails;
		expect(details.changes).toEqual([
			{ op: "done", task: "Implement", commit: { scope: { kind: "all" }, message: "Implement the change" } },
		]);
		expect(details.more).toEqual(harness.snapshot());
		expect(itemOf(harness.snapshot(), "Implement").commit?.sha).toMatch(/^[0-9a-f]{40}$/);
	});
});

describe("a session without a change record", () => {
	test("a message without paths fails, points at the path form and leaves the checkout alone", async () => {
		const harness = await fixture(await repository({ "a.txt": "one\n" }), { journaled: false });
		await harness.call(init, 'ADD "Implement" "Change the tracked file" 5');
		await harness.edit("a.txt", "two\n");
		await Bun.write(join(harness.cwd, "b.txt"), "new\n");
		await git(harness.cwd, "add", "b.txt");
		const head = await git(harness.cwd, "rev-parse", "HEAD");

		const result = await harness.call('DONE "Implement" "Implement the change"');
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain('DONE "title" "<paths>" "<message>"');
		expect(itemOf(harness.snapshot(), "Implement").status).not.toBe("completed");
		expect(await git(harness.cwd, "rev-parse", "HEAD")).toBe(head);
		expect(await git(harness.cwd, "status", "--porcelain")).toBe("M a.txt\nA  b.txt");
	});

	test("a bare DONE in a dirty checkout is refused with the path form alone", async () => {
		const harness = await fixture(await repository({ "a.txt": "one\n" }), { journaled: false });
		await harness.call(init, 'ADD "Implement" "Change the tracked file" 5');
		await harness.edit("a.txt", "two\n");

		const result = await harness.call('DONE "Implement"');
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain('DONE "title" "<paths>" "<message>"');
		expect(textOf(result)).not.toContain('DONE "title" "<message>"');
		expect(itemOf(harness.snapshot(), "Implement").status).not.toBe("completed");
	});

	test("a bare DONE in a clean checkout completes", async () => {
		const harness = await fixture(await repository({ "a.txt": "one\n" }), { journaled: false });
		await harness.call(init, 'ADD "Read" "Change nothing" 5');
		const result = await harness.call('DONE "Read"');
		expect(result.isError).not.toBe(true);
		expect(itemOf(harness.snapshot(), "Read").status).toBe("completed");
	});

	test("the path form still commits", async () => {
		const harness = await fixture(await repository({ "a.txt": "one\n", "b.txt": "one\n" }), { journaled: false });
		await harness.call(init, 'ADD "Implement" "Change one tracked file" 5');
		await harness.edit("a.txt", "two\n");
		await harness.edit("b.txt", "two\n");

		const result = await harness.call('DONE "Implement" "a.txt" "Change only a"');
		expect(result.isError).not.toBe(true);
		expect(await git(harness.cwd, "show", "--name-only", "--format=", "HEAD")).toBe("a.txt");
		expect(await git(harness.cwd, "status", "--porcelain")).toBe("M b.txt");
	});
});

describe("a HEAD that moves while the commit is built", () => {
	async function moveHeadOnce(cwd: string, file: string): Promise<void> {
		const marker = join(cwd, ".git", "head-moved");
		const hook = [
			"#!/bin/sh",
			`[ -e '${marker}' ] && exit 0`,
			`: > '${marker}'`,
			`env -u GIT_INDEX_FILE -u GIT_DIR -u GIT_WORK_TREE git -C '${cwd}' commit -q --only -m 'other writer' -- '${file}' || exit 1`,
			"",
		].join("\n");
		const path = join(cwd, ".git", "hooks", "pre-commit");
		await Bun.write(path, hook);
		await Bun.$`chmod +x ${path}`.quiet();
	}

	test("a selection that still applies lands on the new HEAD and keeps the other commit", async () => {
		const harness = await fixture(await repository({ "mine.txt": "one\n", "theirs.txt": "one\n" }));
		await harness.call(init, 'ADD "Implement" "Change mine.txt" 5');
		await harness.edit("mine.txt", "mine\n");
		await Bun.write(join(harness.cwd, "theirs.txt"), "theirs\n");
		await moveHeadOnce(harness.cwd, "theirs.txt");

		const result = await harness.call('DONE "Implement" "Change mine"');
		expect(result.isError).not.toBe(true);
		expect(await git(harness.cwd, "log", "--format=%s")).toBe("Change mine\nother writer\ninitial");
		expect(await git(harness.cwd, "show", "--name-only", "--format=", "HEAD")).toBe("mine.txt");
		expect(itemOf(harness.snapshot(), "Implement").status).toBe("completed");
	});

	test("a selection that no longer applies fails naming the move and the paths, and the item stays open", async () => {
		const harness = await fixture(await repository({ "mine.txt": "one\n" }));
		await harness.call(init, 'ADD "Implement" "Change mine.txt" 5');
		await harness.edit("mine.txt", "mine\n");
		await moveHeadOnce(harness.cwd, "mine.txt");

		const result = await harness.call('DONE "Implement" "Change mine"');
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/HEAD moved from [0-9a-f]+ to [0-9a-f]+, which changed mine\.txt/);
		expect(itemOf(harness.snapshot(), "Implement").status).not.toBe("completed");
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
		const harness = await fixture(cwd, { parentCwd: () => join(cwd, "sub") });
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
		const harness = await fixture(await repository({ "a.txt": "one\n" }), { parentCwd: () => undefined });
		await harness.call(init, 'ADD "Implement" "Change the tracked file" 5');
		await harness.edit("a.txt", "two\n");

		const refused = await harness.call('DONE "Implement"');
		expect(refused.isError).toBe(true);
		expect(textOf(refused)).toContain(`Task "Implement" would leave this agent's uncommitted work in ${harness.cwd}`);
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
		const harness = await fixture(isolated, { parentCwd: () => parent });
		await harness.call(init, 'ADD "Implement" "Change the tracked file" 5');
		await harness.edit("a.txt", "two\n");

		const refused = await harness.call('DONE "Implement"');
		expect(refused.isError).toBe(true);
		expect(textOf(refused)).toContain('Task "Implement" would leave this agent\'s uncommitted work');
		const committed = await harness.call('DONE "Implement" "Implement the change"');
		expect(committed.isError).not.toBe(true);
		expect(await git(isolated, "log", "-1", "--format=%s")).toBe("Implement the change");
		expect(await git(parent, "log", "-1", "--format=%s", "main")).toBe("initial");
		expect(await git(parent, "status", "--porcelain")).toBe("?? foreign.txt");
	});
});

describe("the Model trailers of a completion's commit", () => {
	test("name each model of the session since its previous todo commit once, in order of first use", async () => {
		const harness = await fixture(await repository({ "a.txt": "one\n" }), { model: { provider: "anthropic", id: "claude-opus-5-5" } });
		await harness.call(init, 'ADD "First" "Change a.txt" 5', 'ADD "Second" "Change a.txt again" 5');
		reply(harness, "openai-codex", "gpt-6-luna");
		reply(harness, "anthropic", "claude-opus-5-5");
		reply(harness, "openai-codex", "gpt-6-luna");
		reply(harness, "zai", "glm-5.2", "error");
		await harness.edit("a.txt", "two\n");
		await harness.call('DONE "First" "Commit the first item"');

		expect(await git(harness.cwd, "log", "-1", "--format=%B")).toBe(
			"Commit the first item\n\nModel: openai-codex/gpt-6-luna\nModel: anthropic/claude-opus-5-5",
		);
		expect(commitOf(harness, "First").message).toBe("Commit the first item");

		reply(harness, "bansos", "muse-spark-1.3-contributor");
		await harness.edit("a.txt", "three\n");
		await harness.call('DONE "Second" "Commit the second item"');
		expect(await trailers(harness.cwd, "HEAD")).toBe("bansos/muse-spark-1.3-contributor\nanthropic/claude-opus-5-5");
		expect(await git(harness.cwd, "log", "-1", "--format=%s")).toBe("Commit the second item");
	});

	test("a session with no model on record commits the message alone", async () => {
		const harness = await fixture(await repository({ "a.txt": "one\n" }));
		await harness.call(init, 'ADD "Implement" "Change the tracked file" 5');
		await harness.edit("a.txt", "two\n");
		await harness.call('DONE "Implement" "Implement the change"');
		expect(await git(harness.cwd, "log", "-1", "--format=%B")).toBe("Implement the change");
	});
});
