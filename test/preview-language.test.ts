import { describe, expect, test } from "bun:test";
import { describeTodoCall } from "../src/native.ts";
import { callPreviewLines, parseCall } from "../src/render.ts";

const cases: readonly { args: unknown; en: string; zh: string }[] = [
	{
		args: "bad",
		en: "Invalid preview: Expected todo arguments object",
		zh: "预览无效: Expected todo arguments object",
	},
	{
		args: { start_id: "" },
		en: "Generating — awaiting complete todo arguments.",
		zh: "正在生成 — 等待完整待办参数。",
	},
];

describe("human preview diagnostics", () => {
	for (const entry of cases) {
		test(entry.en, () => {
			const previous = process.env.OMOMP_LANG;
			try {
				process.env.OMOMP_LANG = "en";
				const call = parseCall(entry.args);
				expect(callPreviewLines(call)).toContain(entry.en);
				process.env.OMOMP_LANG = "zh";
				expect(callPreviewLines(call)).toContain(entry.zh);
				expect(JSON.stringify(describeTodoCall(entry.args as never, { expanded: true, isPartial: true }))).toContain(entry.zh);
			} finally {
				if (previous === undefined) delete process.env.OMOMP_LANG;
				else process.env.OMOMP_LANG = previous;
			}
		});
	}

	test("valid previews have no diagnostic", () => {
		const call = parseCall({ done_id: "t1" });
		expect(call.complete).toBe(true);
		expect(call.error).toBeUndefined();
		expect(callPreviewLines(call)).toContain("Arguments complete; awaiting execution.");
	});
});
