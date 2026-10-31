import { z } from "@oh-my-pi/pi-coding-agent";
import { type CommitScope, estimatedMinutesSchema, type TodoGoal } from "./state.ts";

export const parametersSchema = z.object({ input: z.string().describe("Complete Todo document; batch related changes in one call") });

/** Like OMP edit's customFormat, with the same {input} function-tool representation. */
export const customFormat = {
	syntax: "lark" as const,
	definition: String.raw`start: "*** Begin Todo" LF command+ "*** End Todo" LF?
?command: "INIT" SP string SP string SP string LF
    | "GOAL" SP string SP string SP string LF
    | "PHASE" SP string LF
    | "ADD" SP string SP string SP MINUTES LF
    | "START" SP string LF
    | "EXPLAIN" SP string SP string LF
    | "ESTIMATE" SP string SP MINUTES LF
    | "DONE" SP done LF
    | ("DROP" | "RM") SP target LF
    | "UNBLOCK" SP block_target LF
    | "BLOCK" SP block_target (SP string)? LF
    | "VIEW" LF
?done: target | target SP string | target SP string SP string
?target: string | "PHASE" SP string | "ALL"
?block_target: string | "PHASE" SP string
string: /"(?:[^"\\\x00-\x1f]|\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4}))*"/
MINUTES: /[1-9][0-9]*/
SP: /[ \t]+/
LF: /\r?\n/`,
};

export type TodoTarget = { kind: "task"; title: string } | { kind: "phase"; name: string } | { kind: "all" };
/** The commit a DONE clause asks for: what to stage, and the message git records. */
export type TodoCommitClause = { readonly scope: CommitScope; readonly message: string };
export type TodoCommand =
	| { kind: "init" | "goal"; goal: TodoGoal }
	| { kind: "phase"; name: string }
	| { kind: "add"; title: string; explanation: string; estimatedMinutes: number }
	| { kind: "start"; title: string }
	| { kind: "explain"; title: string; explanation: string }
	| { kind: "estimate"; title: string; estimatedMinutes: number }
	| { kind: "done"; target: TodoTarget; commit?: TodoCommitClause }
	| { kind: "drop" | "rm"; target: TodoTarget }
	| { kind: "unblock"; target: Exclude<TodoTarget, { kind: "all" }> }
	| { kind: "block"; target: Exclude<TodoTarget, { kind: "all" }>; reason?: string }
	| { kind: "view" };
export type TodoProgram = { kind: "ok"; commands: TodoCommand[] } | { kind: "invalid"; message: string };
type TodoLineError =
	| { kind: "quoted-string" | "estimate" | "token" | "argument-spacing" | "trailing-whitespace" | "uppercase-command" }
	| { kind: "command"; command: string };
export type TodoParseError =
	| TodoLineError
	| { kind: "input" | "begin" | "after-end" }
	| { kind: "line"; line: number; error: TodoLineError };
export type TodoPreview = { commands: TodoCommand[]; pending: string; complete: boolean; error?: TodoParseError };

/** Parser diagnostics stay structured until the model or human boundary chooses a language. */
export function formatTodoParseError(error: TodoParseError, language: "en" | "zh" = "en"): string {
	const zh = language === "zh";
	switch (error.kind) {
		case "input":
			return zh ? "需要 Todo 输入文本" : "Expected Todo input text";
		case "begin":
			return zh ? "需要 *** Begin Todo" : "Expected *** Begin Todo";
		case "after-end":
			return zh ? "*** End Todo 后有意外文本" : "Unexpected text after *** End Todo";
		case "quoted-string":
			return zh ? "需要带引号的 JSON 字符串" : "Expected a quoted JSON string";
		case "estimate":
			return zh ? "预计时间必须是支持范围内的正整数分钟数" : "Estimate must be a supported positive integer minute value";
		case "token":
			return zh
				? "需要命令、选择器、带引号的 JSON 字符串或正整数预计时间"
				: "Expected a command, selector, quoted JSON string, or positive integer estimate";
		case "argument-spacing":
			return zh ? "参数之间须用空格分隔" : "Separate arguments with spaces";
		case "trailing-whitespace":
			return zh ? "行末有意外空白" : "Unexpected trailing whitespace";
		case "uppercase-command":
			return zh ? "需要大写命令" : "Expected an uppercase command";
		case "command":
			return zh ? `${error.command} 命令或参数无效` : `Invalid ${error.command} command or arguments`;
		case "line":
			return zh
				? `第 ${error.line} 行：${formatTodoParseError(error.error, language)}`
				: `Line ${error.line}: ${formatTodoParseError(error.error, language)}`;
		default: {
			const unreachable: never = error;
			throw new Error(`Unexpected Todo parse error: ${String(unreachable)}`);
		}
	}
}

type Token = { kind: "string"; value: string } | { kind: "word"; value: string } | { kind: "minutes"; value: number };
type Tokens = { kind: "ok"; tokens: Token[] } | { kind: "invalid"; error: TodoLineError };
type ParsedLine = { kind: "ok"; command: TodoCommand } | { kind: "invalid"; error: TodoLineError };

function tokenize(line: string): Tokens {
	const tokens: Token[] = [];
	let offset = 0;
	while (offset < line.length) {
		const rest = line.slice(offset);
		// biome-ignore lint/suspicious/noControlCharactersInRegex: JSON strings cannot contain raw control characters.
		const quoted = /^"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(rest);
		const word = quoted ? undefined : /^[A-Z]+/.exec(rest);
		const minutes = quoted || word ? undefined : /^[1-9][0-9]*/.exec(rest);
		if (quoted) {
			const value: unknown = JSON.parse(quoted[0]);
			if (typeof value !== "string") return { kind: "invalid", error: { kind: "quoted-string" } };
			tokens.push({ kind: "string", value });
			offset += quoted[0].length;
		} else if (word) {
			tokens.push({ kind: "word", value: word[0] });
			offset += word[0].length;
		} else if (minutes) {
			const parsed = estimatedMinutesSchema.safeParse(Number(minutes[0]));
			if (!parsed.success) return { kind: "invalid", error: { kind: "estimate" } };
			tokens.push({ kind: "minutes", value: parsed.data });
			offset += minutes[0].length;
		} else return { kind: "invalid", error: { kind: "token" } };
		if (offset === line.length) break;
		const space = /^[ \t]+/.exec(line.slice(offset));
		if (!space) return { kind: "invalid", error: { kind: "argument-spacing" } };
		offset += space[0].length;
		if (offset === line.length) return { kind: "invalid", error: { kind: "trailing-whitespace" } };
	}
	return { kind: "ok", tokens };
}

function targetOf(tokens: Token[]): TodoTarget | undefined {
	if (tokens.length === 1) {
		const token = tokens[0];
		if (token?.kind === "string" && token.value.length > 0) return { kind: "task", title: token.value };
		if (token?.kind === "word" && token.value === "ALL") return { kind: "all" };
	}
	if (
		tokens.length === 2 &&
		tokens[0]?.kind === "word" &&
		tokens[0].value === "PHASE" &&
		tokens[1]?.kind === "string" &&
		tokens[1].value.length > 0
	) {
		return { kind: "phase", name: tokens[1].value };
	}
	return undefined;
}

/**
 * A DONE clause: no strings asks for no commit, one string is the message for
 * every change, two strings are a scope and its message. `invalid` is a
 * malformed clause, not a missing one.
 */
function commitClause(tokens: Token[]): TodoCommitClause | "invalid" | undefined {
	if (tokens.length === 0) return undefined;
	if (tokens.length === 1) {
		const message = tokens[0];
		if (message?.kind !== "string" || message.value.trim().length === 0) return "invalid";
		return { scope: { kind: "all" }, message: message.value };
	}
	if (tokens.length === 2) {
		const [spec, message] = tokens;
		if (spec?.kind !== "string" || message?.kind !== "string" || message.value.trim().length === 0) return "invalid";
		const paths = spec.value.trim();
		return paths.length === 0
			? { scope: { kind: "all" }, message: message.value }
			: { scope: { kind: "paths", files: paths.split(/\s+/) }, message: message.value };
	}
	return "invalid";
}

function parseLine(line: string): ParsedLine {
	const parsed = tokenize(line);
	if (parsed.kind === "invalid") return parsed;
	const [head, ...args] = parsed.tokens;
	if (head?.kind !== "word") return { kind: "invalid", error: { kind: "uppercase-command" } };
	const strings = args.filter((token) => token.kind === "string").map((token) => token.value);
	const onlyStrings = strings.length === args.length;
	switch (head.value) {
		case "INIT":
		case "GOAL":
			if (onlyStrings && strings.length === 3) {
				return {
					kind: "ok",
					command: {
						kind: head.value === "INIT" ? "init" : "goal",
						goal: { objective: strings[0]!, measure: strings[1]!, doneWhen: strings[2]! },
					},
				};
			}
			break;
		case "PHASE":
			if (onlyStrings && strings.length === 1) return { kind: "ok", command: { kind: "phase", name: strings[0]! } };
			break;
		case "ADD":
			if (args.length === 3 && args[0]?.kind === "string" && args[1]?.kind === "string" && args[2]?.kind === "minutes") {
				return { kind: "ok", command: { kind: "add", title: args[0].value, explanation: args[1].value, estimatedMinutes: args[2].value } };
			}
			break;
		case "EXPLAIN":
			if (onlyStrings && strings.length === 2) {
				return { kind: "ok", command: { kind: "explain", title: strings[0]!, explanation: strings[1]! } };
			}
			break;
		case "ESTIMATE":
			if (args.length === 2 && args[0]?.kind === "string" && args[1]?.kind === "minutes") {
				return { kind: "ok", command: { kind: "estimate", title: args[0].value, estimatedMinutes: args[1].value } };
			}
			break;
		case "START":
			if (onlyStrings && strings.length === 1) return { kind: "ok", command: { kind: "start", title: strings[0]! } };
			break;
		case "DONE": {
			const width = args[0]?.kind === "word" && args[0].value === "PHASE" ? 2 : 1;
			const target = targetOf(args.slice(0, width));
			const commit = commitClause(args.slice(width));
			if (target && commit !== "invalid") {
				return { kind: "ok", command: { kind: "done", target, ...(commit === undefined ? {} : { commit }) } };
			}
			break;
		}
		case "DROP":
		case "RM": {
			const target = targetOf(args);
			if (target) {
				const kind = { DROP: "drop", RM: "rm" } as const;
				return { kind: "ok", command: { kind: kind[head.value], target } };
			}
			break;
		}
		case "UNBLOCK": {
			const target = targetOf(args);
			if (target && target.kind !== "all") return { kind: "ok", command: { kind: "unblock", target } };
			break;
		}
		case "BLOCK": {
			const width = args[0]?.kind === "word" && args[0].value === "PHASE" ? 2 : 1;
			const target = targetOf(args.slice(0, width));
			const reason = args[width];
			if (target && target.kind !== "all" && (args.length === width || (args.length === width + 1 && reason?.kind === "string"))) {
				return { kind: "ok", command: { kind: "block", target, ...(reason?.kind === "string" ? { reason: reason.value } : {}) } };
			}
			break;
		}
		case "VIEW":
			if (args.length === 0) return { kind: "ok", command: { kind: "view" } };
			break;
	}
	return { kind: "invalid", error: { kind: "command", command: head.value } };
}

/** Pure display-only intent. Only newline-terminated commands are interpreted while generating. */
export function previewTodo(input: string): TodoPreview {
	const lines = input.split("\n");
	const pending = lines.pop() ?? "";
	const commands: TodoCommand[] = [];
	if (lines.length === 0) return { commands, pending, complete: false };
	if (lines[0]?.replace(/\r$/, "") !== "*** Begin Todo") return { commands, pending, complete: false, error: { kind: "begin" } };
	for (let index = 1; index < lines.length; index++) {
		const line = lines[index]!.replace(/\r$/, "");
		if (line === "*** End Todo") {
			return index === lines.length - 1 && pending === ""
				? { commands, pending: "", complete: true }
				: { commands, pending, complete: false, error: { kind: "after-end" } };
		}
		const parsed = parseLine(line);
		if (parsed.kind === "invalid")
			return { commands, pending, complete: false, error: { kind: "line", line: index + 1, error: parsed.error } };
		commands.push(parsed.command);
	}
	return { commands, pending, complete: pending === "*** End Todo" };
}

/** Final execution always reparses; an unfinished or invalid suffix rejects the whole call. */
export function parseTodo(input: string): TodoProgram {
	const preview = previewTodo(input);
	if (preview.error) return { kind: "invalid", message: formatTodoParseError(preview.error) };
	if (!preview.complete) return { kind: "invalid", message: "Expected complete *** Begin Todo / *** End Todo document" };
	if (preview.commands.length === 0) return { kind: "invalid", message: "Todo document needs at least one command" };
	if (preview.commands.some((command) => command.kind === "view") && preview.commands.length !== 1) {
		return { kind: "invalid", message: "VIEW must be the only command" };
	}
	if (preview.commands.some((command, index) => command.kind === "init" && index !== 0)) {
		return { kind: "invalid", message: "INIT must be the first command and may appear only once" };
	}
	return { kind: "ok", commands: preview.commands };
}
