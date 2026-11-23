import { describe, expect, test } from "bun:test";
import { previewTodoArgs } from "../src/protocol.ts";

describe("human preview diagnostics", () => {
	test("valid previews have no diagnostic", () => {
		const call = previewTodoArgs({ done_id: "t1" });
		expect(call.complete).toBe(true);
		expect(call.error).toBeUndefined();
	});
});
