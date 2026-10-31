import { expect, test } from "bun:test";
import { TODO_TOOL_DEFINITION } from "../index.ts";
import { ctxDocTopics } from "../src/topics.ts";

test("registered Todo publishes packaged body-only protocol and lifecycle topics", () => {
	const topics = TODO_TOOL_DEFINITION.docTopics();
	expect(Object.keys(topics)).toEqual(["protocol", "lifecycle"]);
	for (const [key, body] of Object.entries(topics)) {
		expect(TODO_TOOL_DEFINITION.description).toContain(`xd://todo/${key}`);
		expect(body.startsWith("# ")).toBe(true);
		expect(body).not.toContain("tool://");
	}
	expect(topics.protocol).toContain('DONE "title" "<paths>" "<message>"');
	expect(topics.protocol).toContain("parent agent integrates and commits");
	expect(topics.lifecycle).toContain("NEVER call todo alone");
});

test("ctx recall topic retains scope and transcript fallback rules", () => {
	const topics = ctxDocTopics();
	expect(Object.keys(topics)).toEqual(["recall"]);
	expect(topics.recall).toContain("this session and its descendants only");
	expect(topics.recall).toContain("fallback, not the default");
	expect(topics.recall).toContain("historical, not the current Todo projection");
	expect(topics.recall).not.toContain("tool://");
});
