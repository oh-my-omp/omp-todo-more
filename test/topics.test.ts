import { describe, expect, test } from "bun:test";
import type { InternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TODO_TOOL_DEFINITION } from "../index.ts";
import { todoScheme } from "../src/todo-scheme.ts";
import { hostSession, runPersisted } from "./host.ts";

function internalUrl(href: string): InternalUrl {
	const parsed = new URL(href);
	return Object.assign(parsed, {
		rawHost: parsed.hostname,
		rawPathname: parsed.pathname,
		rawHref: href,
	}) as InternalUrl;
}

describe("todo tool metadata & todo:// scheme", () => {
	test("tool is essential, read-approved, <=200 char description, and has no docTopics or customFormat", () => {
		expect(TODO_TOOL_DEFINITION.loadMode).toBe("essential");
		expect(TODO_TOOL_DEFINITION.approval).toBe("read");
		expect(TODO_TOOL_DEFINITION.description.length).toBeLessThanOrEqual(200);
		expect(TODO_TOOL_DEFINITION.description).toContain("todo://");
		expect(TODO_TOOL_DEFINITION.description).not.toContain("xd://");
		expect(TODO_TOOL_DEFINITION.description).not.toContain("help://");
		expect("docTopics" in TODO_TOOL_DEFINITION).toBe(false);
		expect("customFormat" in TODO_TOOL_DEFINITION).toBe(false);
	});

	test("todo:// scheme spec and promptDoc match contract", () => {
		expect(todoScheme.scheme).toBe("todo");
		expect(todoScheme.spec).toEqual({ backing: "virtual", selectors: "lines", immutable: true });
		expect(todoScheme.promptDoc?.({} as never)).toBe(
			"`todo://` / `todo://phase/<slug>` — Read current todo tree, phases, and task status.",
		);
	});

	test("read todo:// and todo://phase/<slug> resolve live todo tree and phase views", async () => {
		const manager = SessionManager.inMemory("/tmp/todo-more-scheme-tests");
		const session = hostSession(manager);
		await runPersisted(session, {
			goal: { title: "Ship URLs", summary: "Tests pass", acceptance: "Both routes work" },
			add: [
				{ phase: "Setup Files", title: "Prepare state", detail: "Seed items", minutes: 10 },
				{ phase: "Verify Suite", title: "Run checks", detail: "Verify green", minutes: 15 },
			],
			done_ids: [],
		}).catch(() => {});
		await runPersisted(session, {
			goal: { title: "Ship URLs", summary: "Tests pass", acceptance: "Both routes work" },
			add: [
				{ phase: "Setup Files", title: "Prepare state", detail: "Seed items", minutes: 10 },
				{ phase: "Verify Suite", title: "Run checks", detail: "Verify green", minutes: 15 },
			],
		});
		await runPersisted(session, { done_ids: ["t1"] });

		const ctx = {
			session: {
				...session,
				cwd: "/tmp/todo-more-scheme-tests",
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => null,
			},
		} as never;

		const full = await todoScheme.resolve(internalUrl("todo://"), ctx);
		expect(full.url).toBe("todo://");
		expect(full.content).toContain("Objective: Ship URLs");
		expect(full.content).toContain("[t1] [completed]");
		expect(full.content).toContain("[t2] [in_progress]");
		expect(full.content).toContain("todo://phase/setup-files");
		expect(full.content).toContain("todo://phase/verify-suite");

		const phase = await todoScheme.resolve(internalUrl("todo://phase/verify-suite"), ctx);
		expect(phase.url).toBe("todo://phase/verify-suite");
		expect(phase.content).toContain('Phase "Verify Suite"');
		expect(phase.content).toContain("[t2] [in_progress]");
		expect(phase.content).not.toContain("Prepare state");

		await expect(todoScheme.resolve(internalUrl("todo://phase/missing"), ctx)).rejects.toThrow(/Phase "missing" not found/);
		await expect(todoScheme.resolve(internalUrl("todo://unknown/path"), ctx)).rejects.toThrow(/Invalid todo:\/\/ URL/);
	});
});
