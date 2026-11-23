import { describe, expect, test } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TODO_TOOL_DEFINITION } from "../index.ts";
import { runTodo } from "../src/tool.ts";
import { hostSession, runPersisted } from "./host.ts";

describe("todo tool metadata & native view inspection", () => {
	test("tool is essential, read-approved, <=200 char description, and has no todo://, tool://, xd://, docTopics, or customFormat", () => {
		expect(TODO_TOOL_DEFINITION.loadMode).toBe("essential");
		expect(TODO_TOOL_DEFINITION.approval).toBe("read");
		expect(TODO_TOOL_DEFINITION.description.length).toBeLessThanOrEqual(200);
		expect(TODO_TOOL_DEFINITION.description).toContain("todo({})");
		expect(TODO_TOOL_DEFINITION.description).not.toContain("todo://");
		expect(TODO_TOOL_DEFINITION.description).not.toContain("tool://");
		expect(TODO_TOOL_DEFINITION.description).not.toContain("xd://");
		expect("docTopics" in TODO_TOOL_DEFINITION).toBe(false);
		expect("customFormat" in TODO_TOOL_DEFINITION).toBe(false);
	});

	test("todo({}) and todo({ view }) resolve full, current, and single-phase views without mutating state", async () => {
		const manager = SessionManager.inMemory("/tmp/todo-more-view-tests");
		const session = hostSession(manager);

		const emptyView = await runTodo(session, {});
		expect(emptyView.isError).toBeUndefined();
		expect(emptyView.details?.op).toBe("view");
		expect((emptyView.content[0] as { text: string }).text).toContain("Todo list is empty.");

		await runPersisted(session, {
			goal: { title: "Native Todo", summary: "Tests pass", acceptance: "Views work" },
			add: [
				{ phase: "Setup Files", title: "Prepare state", detail: "Seed items", minutes: 10 },
				{ phase: "Verify Suite", title: "Run checks", detail: "Verify green", minutes: 15 },
			],
		});
		await runPersisted(session, { done_id: "t1" });

		const full = await runTodo(session, {});
		expect(full.isError).toBeUndefined();
		expect(full.details?.op).toBe("view");
		const fullText = (full.content[0] as { text: string }).text;
		expect(fullText).toContain("Objective: Native Todo");
		expect(fullText).toContain("[t1] [completed]");
		expect(fullText).toContain("[t2] [in_progress]");
		expect(fullText).not.toContain("todo://");

		const current = await runTodo(session, { view: "current" });
		const currentText = (current.content[0] as { text: string }).text;
		expect(currentText).not.toContain("Prepare state");
		expect(currentText).toContain("[t2] [in_progress]");

		const phaseBySlug = await runTodo(session, { view: "verify-suite" });
		const phaseText = (phaseBySlug.content[0] as { text: string }).text;
		expect(phaseText).toContain('Phase "Verify Suite"');
		expect(phaseText).toContain("[t2] [in_progress]");
		expect(phaseText).not.toContain("Prepare state");

		const missing = await runTodo(session, { view: "missing" });
		expect(missing.isError).toBe(true);
		expect((missing.content[0] as { text: string }).text).toContain('Phase "missing" not found');
	});
});
