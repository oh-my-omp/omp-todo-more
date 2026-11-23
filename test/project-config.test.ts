import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { foldBranch } from "../src/branch.ts";
import { DEFAULT_PROJECT_CONFIG, type ProjectConfigState, readProjectConfig } from "../src/project-config.ts";
import { TODO_NG_NOTES_TYPE } from "../src/state.ts";
import { runTodo, type TodoNgDetails } from "../src/tool.ts";
import { hostSession } from "./host.ts";

const created: string[] = [];
afterAll(async () => {
	for (const dir of created) await rm(dir, { recursive: true, force: true });
});

const warnings: string[] = [];
const logger = { warn: (message: string) => warnings.push(message) };

async function scratch(prefix: string): Promise<string> {
	const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
	created.push(dir);
	return dir;
}

async function writeConfig(root: string, body: unknown): Promise<string> {
	const file = join(root, ".omp", "todo-ng.json");
	await Bun.write(file, typeof body === "string" ? body : JSON.stringify(body));
	return file;
}

function invalidOf(state: ProjectConfigState): { path: string; reason: string } {
	if (state.kind !== "invalid") throw new Error(`expected an invalid config, got ${JSON.stringify(state)}`);
	return state;
}

const tail = { id: "tests", title: "All tests pass", detail: "bun test exits 0" };

describe("project config location", () => {
	test("a git subdirectory reads the repository root's file", async () => {
		const root = await scratch("todo-ng-config-repo-");
		await Bun.$`git -C ${root} init -q`.quiet();
		await mkdir(join(root, "pkg", "deep"), { recursive: true });
		await writeConfig(root, { effects: { commit: false } });
		const state = await readProjectConfig(logger, join(root, "pkg", "deep"));
		expect(state).toEqual({
			kind: "ok",
			config: { ...DEFAULT_PROJECT_CONFIG, effects: { ...DEFAULT_PROJECT_CONFIG.effects, commit: false } },
		});
	});

	test("outside git the session directory is the root and a parent's file is not read", async () => {
		const parent = await scratch("todo-ng-config-plain-");
		await writeConfig(parent, "{ broken");
		const child = join(parent, "child");
		await mkdir(child);
		expect(await readProjectConfig(logger, child)).toEqual({ kind: "ok", config: DEFAULT_PROJECT_CONFIG });
		expect(invalidOf(await readProjectConfig(logger, parent)).path).toBe(join(parent, ".omp", "todo-ng.json"));
	});
});

describe("project config values", () => {
	test("omitted fields take their defaults", async () => {
		const root = await scratch("todo-ng-config-defaults-");
		await writeConfig(root, {
			tailItems: [
				{ ...tail, check: { kind: "shell", command: "bun test" } },
				{ id: "review", title: "Review the diff", detail: "no debug code", minutes: 1440, check: { kind: "judge", prompt: "p" } },
			],
		});
		expect(await readProjectConfig(logger, root)).toEqual({
			kind: "ok",
			config: {
				effects: { editGate: true, commit: true, overtime: true, cutOff: true },
				tailItems: [
					{
						...tail,
						phase: "Verification",
						minutes: null,
						scope: "main",
						protected: true,
						check: { kind: "shell", command: "bun test", timeoutMs: 120_000 },
					},
					{
						id: "review",
						phase: "Verification",
						title: "Review the diff",
						detail: "no debug code",
						minutes: 1440,
						scope: "main",
						protected: true,
						check: { kind: "judge", prompt: "p", timeoutMs: 30_000 },
					},
				],
			},
		});
	});

	test("an edited file is read on the next call", async () => {
		const root = await scratch("todo-ng-config-reread-");
		await writeConfig(root, { effects: { overtime: false } });
		expect((await readProjectConfig(logger, root)).kind).toBe("ok");
		await writeConfig(root, { effects: { overtime: "no" } });
		expect(invalidOf(await readProjectConfig(logger, root)).reason).toContain("effects.overtime");
	});

	const rejected: [string, unknown, string][] = [
		["malformed JSON", "{ invalid json", "is not valid JSON"],
		["top-level array", [], "must be an object (was an array)"],
		["effects array", { effects: [] }, "effects: must be an object (was an array)"],
		["unknown top-level key", { effect: {} }, "effect"],
		["unknown effects key", { effects: { editgate: false } }, "effects.editgate"],
		["unknown tail item key", { tailItems: [{ ...tail, scopes: "all" }] }, "tailItems.0.scopes"],
		["zero minutes", { tailItems: [{ ...tail, minutes: 0 }] }, "tailItems.0.minutes"],
		["minutes over 1440", { tailItems: [{ ...tail, minutes: 1441 }] }, "tailItems.0.minutes"],
		["fractional minutes", { tailItems: [{ ...tail, minutes: 1.5 }] }, "tailItems.0.minutes"],
		["blank title", { tailItems: [{ ...tail, title: "  " }] }, "tailItems.0.title"],
		["unknown scope", { tailItems: [{ ...tail, scope: "sub" }] }, "tailItems.0.scope"],
		["unknown check kind", { tailItems: [{ ...tail, check: { kind: "llm", prompt: "p" } }] }, "tailItems.0.check"],
		["empty shell command", { tailItems: [{ ...tail, check: { kind: "shell", command: "" } }] }, "tailItems.0.check"],
		[
			"shell timeout over 600000",
			{ tailItems: [{ ...tail, check: { kind: "shell", command: "x", timeoutMs: 600_001 } }] },
			"tailItems.0.check.timeoutMs",
		],
		[
			"judge timeout over 300000",
			{ tailItems: [{ ...tail, check: { kind: "judge", prompt: "p", timeoutMs: 300_001 } }] },
			"tailItems.0.check.timeoutMs",
		],
		["repeated id", { tailItems: [tail, { ...tail, title: "Other" }] }, 'tailItems.1.id: "tests" repeats tailItems.0.id'],
		["repeated title", { tailItems: [tail, { ...tail, id: "other" }] }, 'tailItems.1.title: "All tests pass" repeats tailItems.0.title'],
	];
	for (const [name, body, reason] of rejected) {
		test(`rejects ${name}`, async () => {
			const root = await scratch("todo-ng-config-bad-");
			const file = await writeConfig(root, body);
			warnings.length = 0;
			const state = invalidOf(await readProjectConfig(logger, root));
			expect(state.path).toBe(file);
			expect(state.reason).toContain(reason);
			expect(warnings).toEqual(["todo-ng project config is invalid"]);
		});
	}

	test.skipIf(process.getuid?.() === 0)("rejects an unreadable file", async () => {
		const root = await scratch("todo-ng-config-unreadable-");
		const file = await writeConfig(root, {});
		await chmod(file, 0o000);
		expect(invalidOf(await readProjectConfig(logger, root)).reason).toContain("cannot be read");
	});
});

describe("todo with an invalid project config", () => {
	const textOf = (result: AgentToolResult<TodoNgDetails>) => result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
	const goal = { title: "Ship", summary: "Measured", acceptance: "Done" };

	test("refuses every change and leaves the list and notes alone, while views still answer", async () => {
		const root = await scratch("todo-ng-config-tool-");
		const manager = SessionManager.inMemory(root);
		const session = hostSession(manager);
		const ok = await runTodo(session, { goal, add: [{ phase: "Work", title: "Build", detail: "d", minutes: 5 }] });
		expect(ok.isError).toBeUndefined();
		const file = await writeConfig(root, "{ invalid json");
		const project = await readProjectConfig(logger, root);
		const notesBefore = manager
			.getBranchView()
			.filter((entry) => entry.type === "custom" && entry.customType === TODO_NG_NOTES_TYPE).length;
		const phasesBefore = session.getTodoPhases();

		for (const raw of [{ done_id: "t1" }, { add: [{ title: "More", detail: "d", minutes: 5 }] }, { drop_ids: ["t1"] }, { goal }]) {
			const refused = await runTodo(session, raw, undefined, undefined, undefined, project);
			expect(refused.isError).toBe(true);
			expect(textOf(refused)).toContain(`Project config ${file} is invalid: is not valid JSON`);
		}
		expect(session.getTodoPhases()).toEqual(phasesBefore);
		expect(manager.getBranchView().filter((entry) => entry.type === "custom" && entry.customType === TODO_NG_NOTES_TYPE)).toHaveLength(
			notesBefore,
		);
		expect(foldBranch(manager.getBranchView()).notes.items.map((item) => item.title)).toEqual(["Build"]);

		for (const raw of [{}, { view: "current" }, { view: "Work" }]) {
			const view = await runTodo(session, raw, undefined, undefined, undefined, project);
			expect(view.isError).toBeUndefined();
			expect(textOf(view)).toContain('"Build"');
			expect(textOf(view)).toContain(`Project config ${file} is invalid`);
		}
	});
});
