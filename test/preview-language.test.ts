import { describe, expect, test } from "bun:test";
import { describeTodoCall } from "../src/native.ts";
import { formatTodoParseError, parseTodo, type TodoParseError } from "../src/protocol.ts";
import { callPreviewLines, parseCall } from "../src/render.ts";

const cases: readonly { input: string; en: string; zh: string }[] = [
	{ input: "bad\n", en: "Expected *** Begin Todo", zh: "需要 *** Begin Todo" },
	{ input: "*** Begin Todo\n*** End Todo\nextra\n", en: "Unexpected text after *** End Todo", zh: "*** End Todo 后有意外文本" },
	{
		input: "*** Begin Todo\nSTART not-quoted\n",
		en: "Line 2: Expected a command, selector, quoted JSON string, or positive integer estimate",
		zh: "第 2 行：需要命令、选择器、带引号的 JSON 字符串或正整数预计时间",
	},
	{ input: "*** Begin Todo\nSTART\n", en: "Line 2: Invalid START command or arguments", zh: "第 2 行：START 命令或参数无效" },
];

describe("human preview diagnostics", () => {
	for (const entry of cases) {
		test(entry.en, () => {
			const previous = process.env.OMOMP_LANG;
			try {
				process.env.OMOMP_LANG = "en";
				const call = parseCall({ input: entry.input });
				expect(callPreviewLines(call)).toContain(`Invalid preview: ${entry.en}`);
				process.env.OMOMP_LANG = "zh";
				// The already-parsed preview must use the language at rendering time.
				expect(callPreviewLines(call)).toContain(`预览无效: ${entry.zh}`);
				expect(JSON.stringify(describeTodoCall({ input: entry.input }, { expanded: true, isPartial: true }))).toContain(entry.zh);
				expect(parseTodo(entry.input)).toEqual({ kind: "invalid", message: entry.en });
			} finally {
				if (previous === undefined) delete process.env.OMOMP_LANG;
				else process.env.OMOMP_LANG = previous;
			}
		});
	}

	test("every diagnostic variant has English and Chinese prose", () => {
		const errors: readonly TodoParseError[] = [
			{ kind: "input" },
			{ kind: "quoted-string" },
			{ kind: "estimate" },
			{ kind: "token" },
			{ kind: "argument-spacing" },
			{ kind: "trailing-whitespace" },
			{ kind: "uppercase-command" },
		];
		for (const error of errors) {
			expect(formatTodoParseError(error, "zh")).toMatch(/[\u4e00-\u9fff]/);
			expect(formatTodoParseError(error, "en")).not.toMatch(/[\u4e00-\u9fff]/);
		}
	});

	test("valid previews have no diagnostic", () => {
		const call = parseCall({ input: "*** Begin Todo\nVIEW\n*** End Todo" });
		expect(call.complete).toBe(true);
		expect(call.error).toBeUndefined();
	});
});
