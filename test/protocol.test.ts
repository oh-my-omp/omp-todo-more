import { describe, expect, test } from "bun:test";
import { parseTodoParams, previewTodoArgs } from "../src/protocol.ts";

const goal = {
	title: "Ship structured todos",
	summary: "One accepted snapshot",
	acceptance: "All requested tasks are represented",
};

describe("Todo parameter schema", () => {
	test("accepts phased initialization with goal and add", () => {
		const parsed = parseTodoParams({
			goal,
			add: [
				{ phase: "Delivery", title: "Implement schema", detail: "Use flat JSON", minutes: 25 },
				{ phase: "Verification", title: "Run tests", detail: "Verify all pass", minutes: 15 },
			],
		});
		expect(parsed.kind).toBe("ok");
	});

	test("accepts incremental updates across start_id, explain, estimate, done_id, and drop_ids", () => {
		const parsed = parseTodoParams({
			start_id: "t2",
			explain: [{ id: "t2", note: "Updated scope" }],
			estimate: [{ id: "t2", minutes: 20 }],
			done_id: "t1",
			drop_ids: ["t3"],
		});
		expect(parsed.kind).toBe("ok");
	});

	test("accepts empty objects and view queries for read-only inspection; rejects non-object or combined view+mutation", () => {
		expect(parseTodoParams({}).kind).toBe("ok");
		expect(parseTodoParams({ view: "all" }).kind).toBe("ok");
		expect(parseTodoParams({ view: "current" }).kind).toBe("ok");
		expect(parseTodoParams({ view: "all", done_id: "t1" }).kind).toBe("invalid");
		expect(parseTodoParams("not an object").kind).toBe("invalid");
		expect(parseTodoParams(null).kind).toBe("invalid");
	});

	test("rejects empty goal fields, empty task titles/details, and non-positive or fractional minutes", () => {
		expect(parseTodoParams({ goal: { ...goal, title: "   " } }).kind).toBe("invalid");
		expect(parseTodoParams({ add: [{ title: "", detail: "ok", minutes: 10 }] }).kind).toBe("invalid");
		expect(parseTodoParams({ add: [{ title: "ok", detail: "   ", minutes: 10 }] }).kind).toBe("invalid");
		expect(parseTodoParams({ add: [{ title: "ok", detail: "ok", minutes: 0 }] }).kind).toBe("invalid");
		expect(parseTodoParams({ add: [{ title: "ok", detail: "ok", minutes: 1.5 }] }).kind).toBe("invalid");
		expect(parseTodoParams({ estimate: [{ id: "t1", minutes: -5 }] }).kind).toBe("invalid");
	});

	test("previewTodoArgs handles partial streaming args without throwing", () => {
		const partial = previewTodoArgs({ goal: { title: "Halfway" }, add: [{ title: "Step 1" }] });
		expect(partial.complete).toBe(false);
		expect(partial.goal?.title).toBe("Halfway");
		expect(partial.add).toHaveLength(1);
	});
});
