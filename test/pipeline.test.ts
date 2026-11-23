import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { ChangeJournal } from "@oh-my-pi/pi-coding-agent/commit/selective/journal";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { foldBranch } from "../src/branch.ts";
import { liveState, type TodoSession } from "../src/commit.ts";
import { saveTodoEdit } from "../src/edit.ts";
import type { TransitionGuard } from "../src/guard.ts";
import type { ProjectConfigState, ProjectEffects, TailItemRule } from "../src/project-config.ts";
import { OVERTIME_TYPE, TODO_NG_NOTES_TYPE, type TodoItem, type TodoNgState } from "../src/state.ts";
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
	const cwd = await scratch("todo-ng-pipeline-repo-");
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
const ALL_ON: ProjectEffects = { editGate: true, commit: true, overtime: true, cutOff: true };

function rule(id: string, title: string, overrides: Partial<TailItemRule> = {}): TailItemRule {
	return {
		id,
		phase: "Verification",
		title,
		detail: `Check ${title}`,
		minutes: null,
		scope: "main",
		protected: true,
		check: null,
		...overrides,
	};
}

function projectOf(tailItems: readonly TailItemRule[], effects: Partial<ProjectEffects> = {}): ProjectConfigState {
	return { kind: "ok", config: { effects: { ...ALL_ON, ...effects }, tailItems } };
}

const textOf = (result: AgentToolResult<TodoNgDetails>) => result.content.map((part) => (part.type === "text" ? part.text : "")).join("");

function itemsOf(state: TodoNgState): { phase: string; item: TodoItem }[] {
	return state.kind === "empty" ? [] : state.phases.flatMap((phase) => phase.items.map((item) => ({ phase: phase.name, item })));
}

type Harness = {
	readonly cwd: string;
	readonly manager: SessionManager;
	readonly session: TodoSession;
	readonly call: (raw: unknown, env?: Partial<TodoEnv>) => Promise<AgentToolResult<TodoNgDetails>>;
	readonly items: () => { phase: string; item: TodoItem }[];
	readonly notes: () => number;
	readonly edit: (file: string, content: string) => Promise<void>;
};

async function harness(cwd: string, base: Partial<TodoEnv> = {}): Promise<Harness> {
	const manager = SessionManager.create(cwd, await scratch("todo-ng-pipeline-sessions-"));
	const session = hostSession(manager);
	return {
		cwd,
		manager,
		session,
		call: async (raw, env = {}) => {
			const result = await runTodo(session, raw, { ...base, ...env });
			manager.appendMessage(todoResultMessage(result.details, Date.now(), result.isError === true));
			return result;
		},
		items: () => itemsOf(liveState(session)),
		notes: () => manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === TODO_NG_NOTES_TYPE).length,
		edit: async (file, content) => {
			const path = join(cwd, file);
			const before = (await Bun.file(path).exists()) ? await Bun.file(path).text() : null;
			await Bun.write(path, content);
			const artifacts = manager.getArtifactsDir();
			if (artifacts === null) throw new Error("the session keeps no artifacts directory");
			ChangeJournal.at(artifacts).recordChange({ agent: MAIN_AGENT_ID, tool: "edit", path, before, after: content });
		},
	};
}

const work = (...titles: string[]) => ({
	goal,
	add: titles.map((title) => ({ phase: "Work", title, detail: `Do ${title}`, minutes: 10 })),
});

describe("tail item transform", () => {
	const rules = [
		rule("main-only", "Main check"),
		rule("isolated", "Isolated check", { scope: "isolated" }),
		rule("all", "All check", { scope: "all" }),
	];

	test("each worktree scope receives the rules that reach it, in declaration order, after the added work", async () => {
		const repo = await repository();
		const project = projectOf(rules);
		const expected: [string, (() => string | undefined) | undefined, string[]][] = [
			["main session", undefined, ["Main check", "Isolated check", "All check"]],
			["subagent in its own worktree", () => "/elsewhere", ["Isolated check", "All check"]],
			["subagent sharing the parent's worktree", () => repo, ["All check"]],
		];
		for (const [, parentCwd, tails] of expected) {
			const h = await harness(repo, { project, parentCwd });
			expect((await h.call(work("Build"))).isError).toBeUndefined();
			expect(h.items().map(({ phase, item }) => [phase, item.title, item.tailRule?.ruleId ?? null])).toEqual([
				["Work", "Build", null],
				...tails.map((title) => ["Verification", title, rules.find((candidate) => candidate.title === title)?.id ?? null]),
			]);
		}
	});

	test("an unset estimate takes the smaller of 15 minutes and leafMaxMinutes, an explicit one is kept above leafMaxMinutes", async () => {
		const repo = await repository();
		const project = projectOf([rule("quick", "Quick check"), rule("long", "Long check", { minutes: 120 })]);
		for (const [leafMaxMinutes, quick] of [
			[60, 15],
			[10, 10],
		] as const) {
			const h = await harness(repo, { project, leafMaxMinutes });
			expect((await h.call(work("Build"))).isError).toBeUndefined();
			const minutes = Object.fromEntries(
				h.items().map(({ item }) => [item.title, item.estimate.kind === "estimated" ? item.estimate.minutes : null]),
			);
			expect(minutes).toEqual({ Build: 10, "Quick check": quick, "Long check": 120 });
		}
	});

	test("an add that repeats a tail title is refused whole and names the rule", async () => {
		const h = await harness(await repository(), { project: projectOf([rule("tests", "All tests pass")]) });
		const refused = await h.call(work("Build", "All tests pass"));
		expect(refused.isError).toBe(true);
		expect(textOf(refused)).toContain('Task "All tests pass" is appended automatically by project tail rule "tests"');
		expect(h.items()).toEqual([]);
		expect(h.notes()).toBe(0);
	});

	test("only a call that starts a list or a new round appends tail items", async () => {
		const h = await harness(await repository(), { project: projectOf([rule("tests", "All tests pass", { protected: false })]) });
		await h.call(work("Build"));
		await h.call({ add: [{ phase: "Work", title: "More", detail: "d", minutes: 5 }] });
		expect(h.items().map(({ item }) => item.title)).toEqual(["Build", "More", "All tests pass"]);
		await h.call({ drop_ids: ["t1", "t2", "t3"] });
		await h.call(work("Next"));
		expect(h.items().map(({ item }) => item.title)).toEqual(["Next", "All tests pass"]);
	});
});

describe("tail rule persistence", () => {
	test("tailRule survives notes, a reopened session file and /todo-ng edits; lists without tail items keep notes free of it", async () => {
		const repo = await repository();
		const h = await harness(repo, { project: projectOf([rule("tests", "All tests pass", { protected: false })]) });
		await h.call(work("Build"));
		const notes = foldBranch(h.manager.getBranch()).notes.items;
		expect(notes.map((note) => [note.title, note.tailRule])).toEqual([
			["Build", undefined],
			["All tests pass", { ruleId: "tests", protected: false }],
		]);
		expect(saveTodoEdit(h.session, { kind: "explain", id: "t2", explanation: "Run the whole suite" }).kind).toBe("saved");
		expect(saveTodoEdit(h.session, { kind: "set_goal", goal: { objective: "Ship it", measure: "Measured", doneWhen: "Done" } }).kind).toBe(
			"saved",
		);
		h.manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "Updated the list" }],
			api: "anthropic-messages",
			provider: "test",
			model: "model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await h.manager.flush();
		const file = h.manager.getSessionFile();
		if (file === undefined) throw new Error("the session keeps no file");
		const reopened = await SessionManager.open(file);
		const tail = itemsOf(foldBranch(reopened.getBranch()).state).find(({ item }) => item.id === "t2")?.item;
		expect(tail?.tailRule).toEqual({ ruleId: "tests", protected: false });
		expect(tail?.explanation).toEqual({ kind: "explained", text: "Run the whole suite" });

		const plain = await harness(repo);
		await plain.call(work("Build"));
		const entry = plain.manager.getBranch().find((candidate) => candidate.type === "custom" && candidate.customType === TODO_NG_NOTES_TYPE);
		expect(JSON.stringify(entry?.type === "custom" ? entry.data : null)).not.toContain("tailRule");
	});
});

describe("tail lifecycle guard", () => {
	const checked = rule("tests", "All tests pass", { check: { kind: "shell", command: "true", timeoutMs: 1000 } });

	test("a protected tail item cannot be dropped, an unprotected one can", async () => {
		const h = await harness(await repository(), { project: projectOf([checked, rule("notes", "Release notes", { protected: false })]) });
		await h.call(work("Build"));
		const notesBefore = h.notes();
		const refused = await h.call({ drop_ids: ["t2"] });
		expect(refused.isError).toBe(true);
		expect(textOf(refused)).toContain(
			'Task "All tests pass" (t2) is a protected tail item from project rule "tests": it cannot be dropped',
		);
		expect(h.notes()).toBe(notesBefore);
		expect((await h.call({ drop_ids: ["t3"] })).isError).toBeUndefined();
	});

	test("a tail item with a check waits until no other work is open, counting the same call", async () => {
		const h = await harness(await repository(), { project: projectOf([checked]) });
		await h.call(work("Build", "Ship"));
		const early = await h.call({ done_id: "t3" });
		expect(early.isError).toBe(true);
		expect(textOf(early)).toContain('complete or drop t1 "Build", t2 "Ship" first');
		expect((await h.call({ done_id: "t3", drop_ids: ["t1"] })).isError).toBe(true);
		expect((await h.call({ done_id: "t1" })).isError).toBeUndefined();
		expect((await h.call({ done_id: "t3", drop_ids: ["t2"] })).isError).toBeUndefined();
		expect(h.items().map(({ item }) => item.progress.status)).toEqual(["completed", "abandoned", "completed"]);
	});

	test("once its rule leaves the project config, or the file is gone, the tail item completes with a note", async () => {
		for (const project of [projectOf([]), undefined]) {
			const h = await harness(await repository(), { project: projectOf([checked]) });
			await h.call(work("Build"));
			const done = await h.call({ done_id: "t2" }, { project });
			expect(done.isError).toBeUndefined();
			expect(textOf(done)).toContain('Project rule "tests" behind task "All tests pass" (t2) is no longer in the project config');
			expect(h.items().map(({ item }) => item.progress.status)).toEqual(["in_progress", "completed"]);
		}
	});
});

describe("project effects in the pipeline", () => {
	test("with effects.commit off, own uncommitted work does not block done_id and a commit clause is ignored", async () => {
		const repo = await repository();
		const h = await harness(repo, { project: projectOf([], { commit: false }) });
		await h.call(work("Build", "Ship"));
		await h.edit("a.txt", "a1\n");
		const commits = await git(repo, "rev-list", "--count", "HEAD");
		expect((await h.call({ done_id: "t1" })).isError).toBeUndefined();
		const clause = await h.call({ done_id: "t2", commit: { message: "ship" } });
		expect(clause.isError).toBeUndefined();
		expect(textOf(clause)).toContain("The project config turns completion commits off (effects.commit is false)");
		expect(await git(repo, "rev-list", "--count", "HEAD")).toBe(commits);
		expect(await git(repo, "status", "--porcelain")).toBe("M a.txt");
		expect(h.items().map(({ item }) => item.commit)).toEqual([null, null]);
	});

	test("with effects.overtime off, an estimate that received an overtime warning can still change", async () => {
		for (const [overtime, isError] of [
			[true, true],
			[false, undefined],
		] as const) {
			const h = await harness(await repository(), { project: projectOf([], { overtime }) });
			await h.call(work("Build"));
			const budget = h.items()[0]?.item.estimate;
			if (budget?.kind !== "estimated") throw new Error("expected an estimate");
			h.manager.appendCustomMessageEntry(OVERTIME_TYPE, "overtime", true, {
				budgetId: budget.budgetId,
				title: "Build",
				estimatedMinutes: 10,
				elapsedMs: 600_000,
			});
			expect((await h.call({ estimate: [{ id: "t1", minutes: 30 }] })).isError).toBe(isError);
		}
	});
});

describe("transition guard order", () => {
	test("acceptance guards run before the commit guard and receive the call's signal and extension context", async () => {
		const repo = await repository();
		const signal = new AbortController().signal;
		const host = { cwd: repo } as unknown as TodoEnv["host"];
		const seen: unknown[] = [];
		const refusing: TransitionGuard = {
			name: "acceptance",
			run: (transition) => {
				seen.push(transition.signal, transition.host);
				return { kind: "reject", message: "acceptance refused" };
			},
		};
		const crashing: TransitionGuard = {
			name: "crashing",
			run: () => {
				throw new Error("boom");
			},
		};
		const h = await harness(repo, { signal, host });
		await h.call(work("Build"));
		await h.edit("a.txt", "a1\n");
		const commits = await git(repo, "rev-list", "--count", "HEAD");
		const notes = h.notes();
		for (const [acceptance, message] of [
			[[refusing], "acceptance refused"],
			[[crashing, refusing], 'Guard "crashing" failed: boom'],
		] as const) {
			const refused = await h.call({ done_id: "t1", commit: { message: "build" } }, { acceptance });
			expect(refused.isError).toBe(true);
			expect(textOf(refused)).toContain(message);
			expect(await git(repo, "rev-list", "--count", "HEAD")).toBe(commits);
			expect(h.notes()).toBe(notes);
			expect(h.items()[0]?.item.progress.status).toBe("in_progress");
		}
		expect(seen).toEqual([signal, host]);
		expect((await h.call({ done_id: "t1", commit: { message: "build" } })).isError).toBeUndefined();
		expect(await git(repo, "rev-list", "--count", "HEAD")).toBe(String(Number(commits) + 1));
	});
});
