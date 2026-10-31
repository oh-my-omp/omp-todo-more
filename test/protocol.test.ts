import { describe, expect, test } from "bun:test";
import { parseTodo, previewTodo, type TodoCommand } from "../src/protocol.ts";

const init = 'INIT "Ship streaming todos" "One accepted snapshot" "All requested tasks are represented"';
const goal = {
	objective: "Ship streaming todos",
	measure: "One accepted snapshot",
	doneWhen: "All requested tasks are represented",
};

function document(...lines: string[]): string {
	return ["*** Begin Todo", ...lines, "*** End Todo"].join("\n");
}

function expectInvalid(input: string): void {
	const parsed = parseTodo(input);
	expect(parsed.kind).toBe("invalid");
	if (parsed.kind !== "invalid") throw new Error("Expected the complete document to be rejected");
}

describe("Todo document consumption", () => {
	test("parses a complete phased initialization in task and phase order", () => {
		expect(
			parseTodo(
				document(
					init,
					'PHASE "Delivery"',
					'ADD "Implement" "Consume the document" 25',
					'ADD "Review" "Inspect saved fields" 10',
					'PHASE "Verification"',
					'ADD "Exercise" "Use the real tool" 15',
				),
			),
		).toEqual({
			kind: "ok",
			commands: [
				{ kind: "init", goal },
				{ kind: "phase", name: "Delivery" },
				{ kind: "add", title: "Implement", explanation: "Consume the document", estimatedMinutes: 25 },
				{ kind: "add", title: "Review", explanation: "Inspect saved fields", estimatedMinutes: 10 },
				{ kind: "phase", name: "Verification" },
				{ kind: "add", title: "Exercise", explanation: "Use the real tool", estimatedMinutes: 15 },
			],
		});
	});

	test("parses flat initialization without inventing a phase command for default Tasks", () => {
		expect(parseTodo(`${document(init, 'ADD "First" "First acceptance" 5', 'ADD "Second" "Second acceptance" 8')}\n`)).toEqual({
			kind: "ok",
			commands: [
				{ kind: "init", goal },
				{ kind: "add", title: "First", explanation: "First acceptance", estimatedMinutes: 5 },
				{ kind: "add", title: "Second", explanation: "Second acceptance", estimatedMinutes: 8 },
			],
		});
	});

	test("decodes JSON escapes without trimming, splitting, or changing complete task identity", () => {
		const title = '  检查 "quoted" \\ path\nnext\tline 🧪  ';
		const explanation = 'Measure\r\nall fields: "yes" \\ done';
		expect(parseTodo(document(`EXPLAIN ${JSON.stringify(title)} ${JSON.stringify(explanation)}`))).toEqual({
			kind: "ok",
			commands: [{ kind: "explain", title, explanation }],
		});
		expect(parseTodo(document(String.raw`START "\u68c0\u67e5 \ud83e\uddea\nline"`))).toEqual({
			kind: "ok",
			commands: [{ kind: "start", title: "检查 🧪\nline" }],
		});
		expect(
			parseTodo(document(`ADD ${JSON.stringify(title)} ${JSON.stringify(explanation)} 12`, `ESTIMATE ${JSON.stringify(title)} 20`)),
		).toEqual({
			kind: "ok",
			commands: [
				{ kind: "add", title, explanation, estimatedMinutes: 12 },
				{ kind: "estimate", title, estimatedMinutes: 20 },
			],
		});
	});

	test("accepts CRLF documents and distinguishes title, phase, and ALL selectors", () => {
		const input = document(
			'DONE "ALL"',
			'DROP PHASE "Delivery"',
			"RM ALL",
			'BLOCK "Wait" "Waiting for service"',
			'UNBLOCK PHASE "Verification"',
		).replaceAll("\n", "\r\n");
		expect(parseTodo(input)).toEqual({
			kind: "ok",
			commands: [
				{ kind: "done", target: { kind: "task", title: "ALL" } },
				{ kind: "drop", target: { kind: "phase", name: "Delivery" } },
				{ kind: "rm", target: { kind: "all" } },
				{ kind: "block", target: { kind: "task", title: "Wait" }, reason: "Waiting for service" },
				{ kind: "unblock", target: { kind: "phase", name: "Verification" } },
			],
		});
	});

	test("accepts a commit clause on DONE and reads scope and message from its strings", () => {
		expect(
			parseTodo(
				document(
					'DONE "Implement"',
					'DONE ALL "Commit every change"',
					'DONE "Implement" "Commit one change"',
					'DONE "Implement" "src/ index.ts" "Commit a scope"',
					'DONE PHASE "Delivery" "" "Commit a phase"',
				),
			),
		).toEqual({
			kind: "ok",
			commands: [
				{ kind: "done", target: { kind: "task", title: "Implement" } },
				{ kind: "done", target: { kind: "all" }, commit: { scope: { kind: "all" }, message: "Commit every change" } },
				{ kind: "done", target: { kind: "task", title: "Implement" }, commit: { scope: { kind: "all" }, message: "Commit one change" } },
				{
					kind: "done",
					target: { kind: "task", title: "Implement" },
					commit: { scope: { kind: "paths", files: ["src/", "index.ts"] }, message: "Commit a scope" },
				},
				{ kind: "done", target: { kind: "phase", name: "Delivery" }, commit: { scope: { kind: "all" }, message: "Commit a phase" } },
			],
		});
	});

	test("parses a goal update and explicit re-estimate in mutation order", () => {
		expect(
			parseTodo(
				document(
					'GOAL "Finish delivery" "One accepted result" "Runtime evidence recorded"',
					'ESTIMATE "Implement" 35',
					'START "Implement"',
				),
			),
		).toEqual({
			kind: "ok",
			commands: [
				{
					kind: "goal",
					goal: { objective: "Finish delivery", measure: "One accepted result", doneWhen: "Runtime evidence recorded" },
				},
				{ kind: "estimate", title: "Implement", estimatedMinutes: 35 },
				{ kind: "start", title: "Implement" },
			],
		});
	});

	test("accepts VIEW as the sole command", () => {
		expect(parseTodo(document("VIEW"))).toEqual({ kind: "ok", commands: [{ kind: "view" }] });
	});

	test("accepts the smallest and largest supported integer minute estimates without changing their values", () => {
		const maximumMinutes = Math.floor(Number.MAX_SAFE_INTEGER / 60_000);
		expect(
			parseTodo(
				document(
					'ADD "Short" "One minute of work" 1',
					`ADD "Long" "Largest representable millisecond budget" ${maximumMinutes}`,
					'ESTIMATE "Long" 1',
					`ESTIMATE "Short" ${maximumMinutes}`,
				),
			),
		).toEqual({
			kind: "ok",
			commands: [
				{ kind: "add", title: "Short", explanation: "One minute of work", estimatedMinutes: 1 },
				{
					kind: "add",
					title: "Long",
					explanation: "Largest representable millisecond budget",
					estimatedMinutes: maximumMinutes,
				},
				{ kind: "estimate", title: "Long", estimatedMinutes: 1 },
				{ kind: "estimate", title: "Short", estimatedMinutes: maximumMinutes },
			],
		});
	});

	test("accepts tab-separated estimates in CRLF command lines", () => {
		const input = document('ADD\t"Task"\t"Acceptance"\t7', 'ESTIMATE\t"Task"\t13').replaceAll("\n", "\r\n");
		expect(parseTodo(input)).toEqual({
			kind: "ok",
			commands: [
				{ kind: "add", title: "Task", explanation: "Acceptance", estimatedMinutes: 7 },
				{ kind: "estimate", title: "Task", estimatedMinutes: 13 },
			],
		});
	});

	const invalidDocuments = [
		{ label: "empty command list", input: document() },
		{ label: "missing begin envelope", input: "VIEW\n*** End Todo" },
		{ label: "missing end envelope", input: "*** Begin Todo\nVIEW\n" },
		{ label: "unfinished final command", input: '*** Begin Todo\nSTART "Task' },
		{ label: "unfinished end envelope", input: "*** Begin Todo\nVIEW\n*** End Tod" },
		{ label: "leading text before envelope", input: `preface\n${document("VIEW")}` },
		{ label: "trailing command", input: `${document("VIEW")}\nSTART "Task"\n` },
		{ label: "trailing text without newline", input: `${document("VIEW")}garbage` },
		{ label: "extra blank line after envelope", input: `${document("VIEW")}\n\n` },
		{ label: "unquoted task identity", input: document("START Task") },
		{ label: "unterminated quote", input: document('START "Task') },
		{ label: "unsupported JSON escape", input: document(String.raw`START "bad\q"`) },
		{ label: "malformed unicode escape", input: document(String.raw`START "bad\u123"`) },
		{ label: "literal newline inside quoted title", input: document('START "Task\nnext"') },
		{ label: "adjacent quoted arguments", input: document('EXPLAIN "Task""Reason"') },
		{ label: "extra argument", input: document('START "Task" "extra"') },
		{ label: "unknown command", input: document('APPEND "Task" "Reason"') },
		{ label: "lowercase command", input: document('start "Task"') },
		{ label: "duplicate INIT", input: document(init, 'ADD "Task" "Reason" 3', init) },
		{ label: "INIT after another command", input: document('START "Task"', init) },
		{ label: "INIT after estimate", input: document('ESTIMATE "Task" 6', init) },
		{ label: "VIEW mixed with mutations", input: document("VIEW", 'DONE "Task"') },
		{ label: "VIEW following mutations", input: document('DONE "Task"', "VIEW") },
		{ label: "VIEW following estimate", input: document('ESTIMATE "Task" 6', "VIEW") },
		{ label: "BLOCK ALL", input: document("BLOCK ALL") },
		{ label: "UNBLOCK ALL", input: document("UNBLOCK ALL") },
		{ label: "empty task selector", input: document('DONE ""') },
		{ label: "empty phase selector", input: document('RM PHASE ""') },
		{ label: "ADD missing estimate", input: document('ADD "Task" "Reason"') },
		{ label: "ESTIMATE missing estimate", input: document('ESTIMATE "Task"') },
		{ label: "ESTIMATE missing title", input: document("ESTIMATE 10") },
		{ label: "ESTIMATE unquoted title", input: document("ESTIMATE Task 10") },
		{ label: "ESTIMATE phase selector", input: document('ESTIMATE PHASE "Delivery" 10') },
		{ label: "ESTIMATE ALL selector", input: document("ESTIMATE ALL 10") },
		{ label: "ADD extra argument", input: document('ADD "Task" "Reason" 10 "extra"') },
		{ label: "ESTIMATE extra argument", input: document('ESTIMATE "Task" 10 "extra"') },
		{ label: "empty commit message", input: document('DONE "Task" ""') },
		{ label: "empty scoped commit message", input: document('DONE "Task" "src/" ""') },
		{ label: "whitespace commit message", input: document('DONE "Task" "  "') },
		{ label: "three-string commit clause", input: document('DONE "Task" "a.txt" "Message" "extra"') },
		{ label: "unquoted scope", input: document('DONE "Task" src.txt "Message"') },
		{ label: "commit clause on DROP", input: document('DROP "Task" "Message"') },
		{ label: "commit clause on RM", input: document('RM "Task" "Message"') },
	];
	for (const { label, input } of invalidDocuments) {
		test(`rejects ${label} instead of accepting its valid prefix`, () => expectInvalid(input));
	}

	const invalidEstimates = [
		{ label: "zero", token: "0" },
		{ label: "negative integer", token: "-1" },
		{ label: "fractional minutes", token: "1.5" },
		{ label: "decimal-form integer", token: "10.0" },
		{ label: "unsafe integer", token: "9007199254740992" },
		{ label: "one minute over the supported maximum", token: String(Math.floor(Number.MAX_SAFE_INTEGER / 60_000) + 1) },
		{ label: "quoted number", token: '"10"' },
		{ label: "leading zero", token: "01" },
		{ label: "explicit positive sign", token: "+10" },
		{ label: "exponent notation", token: "1e2" },
		{ label: "hexadecimal notation", token: "0x10" },
		{ label: "numeric prefix followed by text", token: "12x" },
		{ label: "multiple numbers", token: "10 20" },
		{ label: "non-finite word", token: "Infinity" },
	];
	for (const { label, token } of invalidEstimates) {
		for (const command of ['ADD "Task" "Reason"', 'ESTIMATE "Task"']) {
			test(`rejects ${label} for ${command}`, () => {
				expectInvalid(document(init, 'ADD "Accepted" "Keep the valid prefix atomic" 4', `${command} ${token}`));
			});
		}
	}
});

describe("streamed Todo intent preview", () => {
	test("only newline-complete commands become preview intent", () => {
		const prefix = `*** Begin Todo\n${init}\n`;
		const addition = 'ADD "Task with \\"quotes\\"" "Acceptance" 14';
		const expected: TodoCommand[] = [{ kind: "init", goal }];
		for (let length = 0; length <= addition.length; length++) {
			expect(previewTodo(prefix + addition.slice(0, length))).toEqual({
				commands: expected,
				pending: addition.slice(0, length),
				complete: false,
			});
		}
		expect(previewTodo(`${prefix}${addition}\n`)).toEqual({
			commands: [...expected, { kind: "add", title: 'Task with "quotes"', explanation: "Acceptance", estimatedMinutes: 14 }],
			pending: "",
			complete: false,
		});
	});

	test("an incomplete malformed suffix stays pending until its line is complete", () => {
		const prefix = `*** Begin Todo\n${init}\n`;
		expect(previewTodo(`${prefix}START not-quoted`)).toEqual({
			commands: [{ kind: "init", goal }],
			pending: "START not-quoted",
			complete: false,
		});
		const invalid = previewTodo(`${prefix}START not-quoted\n`);
		expect(invalid.commands).toEqual([{ kind: "init", goal }]);
		expect(invalid.complete).toBe(false);
		expect(invalid.error).toEqual({ kind: "line", line: 3, error: { kind: "token" } });
		expectInvalid(`${prefix}START not-quoted\n*** End Todo`);
	});

	test("estimate digits remain pending until newline even when a numeric prefix is already valid", () => {
		const prefix = `*** Begin Todo\n${init}\nADD "Task" "Acceptance" 9\n`;
		const estimate = 'ESTIMATE "Task" 120';
		const commands: TodoCommand[] = [
			{ kind: "init", goal },
			{ kind: "add", title: "Task", explanation: "Acceptance", estimatedMinutes: 9 },
		];
		for (let length = 0; length <= estimate.length; length++) {
			expect(previewTodo(prefix + estimate.slice(0, length))).toEqual({
				commands,
				pending: estimate.slice(0, length),
				complete: false,
			});
		}
		expect(previewTodo(`${prefix}${estimate}\n`)).toEqual({
			commands: [...commands, { kind: "estimate", title: "Task", estimatedMinutes: 120 }],
			pending: "",
			complete: false,
		});
	});

	for (const line of [
		'ADD "Task" "Acceptance"',
		'ADD "Task" "Acceptance" 12x',
		'ADD "Task" "Acceptance" 0',
		'ESTIMATE "Task"',
		'ESTIMATE "Task" 12x',
		'ESTIMATE "Task" 1.5',
		'ESTIMATE "Task" "12"',
	]) {
		test(`does not accept an invalid numeric line or its numeric prefix: ${line}`, () => {
			const prefix = `*** Begin Todo\n${init}\nADD "Accepted" "Retain the completed intent" 4\n`;
			const commands: TodoCommand[] = [
				{ kind: "init", goal },
				{ kind: "add", title: "Accepted", explanation: "Retain the completed intent", estimatedMinutes: 4 },
			];
			expect(previewTodo(prefix + line)).toEqual({ commands, pending: line, complete: false });
			const invalid = previewTodo(`${prefix}${line}\n`);
			expect(invalid.commands).toEqual(commands);
			expect(invalid.pending).toBe("");
			expect(invalid.complete).toBe(false);
			expect(invalid.error).toMatchObject({ kind: "line", line: 4 });
			expectInvalid(`${prefix}${line}\n*** End Todo`);
		});
	}

	test("completion requires the end envelope, with or without its final newline", () => {
		const input = document(init, 'ADD "Task" "Acceptance" 6');
		for (const suffix of ["", "\n"]) {
			const preview = previewTodo(input + suffix);
			expect(preview.complete).toBe(true);
			expect(preview.error).toBeUndefined();
			expect(preview.commands).toHaveLength(2);
			expect(parseTodo(input + suffix)).toEqual({ kind: "ok", commands: preview.commands });
		}
		expect(previewTodo(input.replace("*** End Todo", "*** End To")).complete).toBe(false);
	});
});
