import { expect, test } from "bun:test";
import { TODO_TOOL_DEFINITION } from "../index.ts";

test("registered Todo publishes packaged body-only protocol and lifecycle topics", () => {
	const topics = TODO_TOOL_DEFINITION.docTopics();
	expect(Object.keys(topics)).toEqual(["protocol", "lifecycle"]);
	for (const [key, body] of Object.entries(topics)) {
		expect(TODO_TOOL_DEFINITION.description).toContain(`help://todo/${key}`);
		expect(TODO_TOOL_DEFINITION.description).not.toContain("xd://");
		expect(body.startsWith("# ")).toBe(true);
		expect(body).not.toContain("xd://");
		expect(body).not.toContain("tool://");
	}
	expect(topics.protocol).toContain("help://todo/lifecycle");
	expect(topics.lifecycle).toContain("help://todo/protocol");
	expect(topics.protocol).toContain('DONE "title" "<paths>" "<message>"');
	expect(topics.protocol).toContain("parent agent integrates and commits");
	expect(topics.lifecycle).toContain("NEVER call todo alone");
});
