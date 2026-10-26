import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type ToolRenderResultOptions, z } from "@oh-my-pi/pi-coding-agent";
import { type Component, replaceTabs, Text, type Theme, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { tr } from "./i18n.ts";
import { previewTodo, type TodoCommand, type TodoPreview, type TodoTarget } from "./protocol.ts";
import {
	commitScopeSchema,
	commitScopeText,
	TODO_STATUSES,
	type TodoMoreSnapshot,
	type TodoStatus,
	todoGoalSchema,
	todoMoreSnapshotSchema,
} from "./state.ts";
import { OPS, RESULT_OPS, type TodoMoreDetails } from "./tool.ts";

const itemParamSchema = z.object({
	title: z.string(),
	explanation: z.string(),
	estimatedMinutes: z.number(),
});

const changeSchema = z.object({
	op: z.enum(OPS),
	goal: todoGoalSchema.optional(),
	list: z.array(z.object({ phase: z.string(), items: z.array(itemParamSchema) })).optional(),
	task: z.string().optional(),
	phase: z.string().optional(),
	items: z.array(itemParamSchema).optional(),
	reason: z.string().optional(),
	explanation: z.string().optional(),
	estimatedMinutes: z.number().optional(),
	commit: z.object({ scope: commitScopeSchema, message: z.string() }).optional(),
});

/** Result snapshots are display copies, not a second source of todo state. */
export const detailsSchema = z.object({
	op: z.enum(RESULT_OPS).optional(),
	operations: z.array(z.enum(OPS)).optional(),
	changes: z.array(changeSchema).optional(),
	phases: z.array(
		z.object({
			name: z.string(),
			tasks: z.array(z.object({ content: z.string(), status: z.enum(TODO_STATUSES), blocker: z.string().optional() }).passthrough()),
		}),
	),
	storage: z.enum(["session", "memory"]),
	completedTasks: z.array(z.object({ phase: z.string(), content: z.string() })).optional(),
	todoMore: z.literal(true),
	more: todoMoreSnapshotSchema,
});
type Item = TodoMoreSnapshot["phases"][number]["items"][number];

function goalUiLines(goal: TodoMoreSnapshot["goal"]): string[] {
	const missing = tr("[goal missing]", "[缺少目标]");
	if (goal === null) {
		return [
			`${tr("Objective", "目标")}: ${missing}`,
			`${tr("Measure", "衡量方式")}: ${missing}`,
			`${tr("Done when", "完成条件")}: ${missing}`,
		];
	}
	return [
		`${tr("Objective", "目标")}: ${goal.objective}`,
		`${tr("Measure", "衡量方式")}: ${goal.measure}`,
		`${tr("Done when", "完成条件")}: ${goal.doneWhen}`,
	];
}

// Streaming arguments may not yet contain input; protocol parsing owns complete-line detection.
const callSchema = z.object({ input: z.string().optional() });
type Call = TodoPreview;
export function parseCall(args: unknown): Call {
	const parsed = callSchema.safeParse(args);
	if (!parsed.success) return { commands: [], pending: "", complete: false, error: tr("Expected Todo input text", "需要 Todo 输入文本") };
	return previewTodo(parsed.data.input ?? "");
}

function previewTarget(target: TodoTarget): string {
	switch (target.kind) {
		case "task":
			return `${tr("task", "任务")}: ${target.title}`;
		case "phase":
			return `${tr("phase", "阶段")}: ${target.name}`;
		case "all":
			return tr("all todos", "全部待办");
		default: {
			const unreachable: never = target;
			throw new Error(`Unexpected todo target: ${String(unreachable)}`);
		}
	}
}

function commandPreviewLines(command: TodoCommand): string[] {
	switch (command.kind) {
		case "init":
		case "goal":
			return [
				`${command.kind.toUpperCase()} ${tr("goal", "目标")}`,
				`  ${tr("Objective", "目标")}: ${command.goal.objective}`,
				`  ${tr("Measure", "衡量方式")}: ${command.goal.measure}`,
				`  ${tr("Done when", "完成条件")}: ${command.goal.doneWhen}`,
			];
		case "phase":
			return [`PHASE: ${command.name} (${tr("ADD context", "ADD 上下文")})`];
		case "add":
			return [
				`ADD ${tr("task", "任务")}: ${command.title}`,
				`  ${tr("Explanation", "说明")}: ${command.explanation}`,
				`  ${tr("Estimate", "预计")}: ${command.estimatedMinutes}${tr("m", "分钟")}`,
			];
		case "explain":
			return [`EXPLAIN ${tr("task", "任务")}: ${command.title}`, `  ${tr("Explanation", "说明")}: ${command.explanation}`];
		case "estimate":
			return [
				`ESTIMATE ${tr("task", "任务")}: ${command.title}`,
				`  ${tr("Estimate", "预计")}: ${command.estimatedMinutes}${tr("m", "分钟")}`,
			];
		case "start":
			return [`START ${tr("task", "任务")}: ${command.title}`];
		case "done":
			return [
				`DONE ${previewTarget(command.target)}`,
				...(command.commit === undefined
					? []
					: [
							`  ${tr("Commit", "提交")} ${
								command.commit.scope.kind === "all" ? tr("all changes", "全部更改") : commitScopeText(command.commit.scope)
							}: ${command.commit.message}`,
						]),
			];
		case "drop":
		case "rm":
		case "unblock":
			return [`${command.kind.toUpperCase()} ${previewTarget(command.target)}`];
		case "block":
			return [
				`BLOCK ${previewTarget(command.target)}`,
				...(command.reason === undefined ? [] : [`  ${tr("Reason", "原因")}: ${command.reason}`]),
			];
		case "view":
			return [`VIEW ${tr("current todos", "当前待办")}`];
		default: {
			const unreachable: never = command;
			throw new Error(`Unexpected todo command: ${String(unreachable)}`);
		}
	}
}

/** Shared display-only intent for ANSI and native call views, never a projected snapshot. */
export function callPreviewLines(call: Call): string[] {
	const lines = [tr("Preview only — not committed.", "仅预览 — 未提交。")];
	for (const command of call.commands) lines.push(...commandPreviewLines(command));
	if (call.commands.length === 0) lines.push(tr("Waiting for complete command lines.", "等待完整命令行。"));
	if (call.error) lines.push(`${tr("Invalid preview", "预览无效")}: ${call.error}`);
	if (!call.complete && call.pending !== "")
		lines.push(`${tr("Pending line — unfinished, not executable", "待处理行 — 未完成，无法执行")}: ${call.pending}`);
	lines.push(
		call.complete
			? tr("Document complete; awaiting execution.", "文档完整；等待执行。")
			: tr("Generating — awaiting a complete Todo document.", "正在生成 — 等待完整 Todo 文档。"),
	);
	return lines.map(forDisplay);
}

// @upstream adapted @oh-my-pi/pi-utils@18.10.1 src/sanitize-text.ts#sanitizeText
const ESC_CHAR = "\x1b";
// biome-ignore lint/suspicious/noControlCharactersInRegex: render boundaries must strip terminal control characters.
const CONTROL_RE = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;
const REPLACEMENT_CHAR = "\ufffd";
function sanitizeText(text: string): string {
	const wellFormed = text.toWellFormed();
	if (wellFormed !== text) {
		return sanitizeWellFormedText(wellFormed.replaceAll(REPLACEMENT_CHAR, ""));
	}
	return sanitizeWellFormedText(text);
}
function sanitizeWellFormedText(text: string): string {
	CONTROL_RE.lastIndex = 0;
	if (CONTROL_RE.exec(text) === null) return text;

	const stripped = text.indexOf(ESC_CHAR) === -1 ? text : Bun.stripANSI(text);
	CONTROL_RE.lastIndex = 0;
	return stripped.replace(CONTROL_RE, "");
}
// @upstream-end

// @upstream verbatim @oh-my-pi/pi-tui@18.10.1 src/tools/todo.ts#forDisplay
function forDisplay(text: string): string {
	return replaceTabs(sanitizeText(text));
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-tui@18.10.1 src/tools/todo.ts#phaseRomanNumeral
const ROMAN_PAIRS: readonly (readonly [number, string])[] = [
	[1000, "M"],
	[900, "CM"],
	[500, "D"],
	[400, "CD"],
	[100, "C"],
	[90, "XC"],
	[50, "L"],
	[40, "XL"],
	[10, "X"],
	[9, "IX"],
	[5, "V"],
	[4, "IV"],
	[1, "I"],
];
function phaseRomanNumeral(index: number): string {
	let text = "";
	for (const [value, symbol] of ROMAN_PAIRS) {
		while (index >= value) {
			text += symbol;
			index -= value;
		}
	}
	return text;
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-tui@18.10.1 src/tools/todo.ts#isClosedTodo
export function isClosed(item: { status: TodoStatus }): boolean {
	return item.status === "completed" || item.status === "abandoned";
}
// @upstream-end

/** Closed and total task counts over non-empty phases: the `closed/total` header progress of a todo result. */
export function progressCounts(more: TodoMoreSnapshot): { closed: number; total: number } {
	const phases = more.phases.filter((phase) => phase.items.length > 0);
	return {
		closed: phases.reduce((sum, phase) => sum + phase.items.filter(isClosed).length, 0),
		total: phases.reduce((sum, phase) => sum + phase.items.length, 0),
	};
}

// @upstream adapted @oh-my-pi/pi-tui@18.10.1 src/tools/todo.ts#selectWithinCap
const COLLAPSED_ITEMS = 8;
function selectWithinCap(items: Item[]): { items: Item[]; summary: string } {
	if (items.length <= COLLAPSED_ITEMS + 1) return { items, summary: "" };
	const active = items.filter((item) => item.status === "in_progress");
	if (active.length > COLLAPSED_ITEMS) {
		const hidden = active.length - COLLAPSED_ITEMS;
		return {
			items: active.slice(0, COLLAPSED_ITEMS),
			summary: tr(`… ${hidden} more active todo${hidden === 1 ? "" : "s"}`, `… 还有 ${hidden} 个进行中的待办`),
		};
	}
	const firstActive = active[0];
	const start = firstActive === undefined ? 0 : items.indexOf(firstActive);
	const fill: Item[] = [];
	for (let index = start; index < items.length && active.length + fill.length < COLLAPSED_ITEMS; index++) {
		const item = items[index];
		if (item !== undefined && item.status !== "in_progress") fill.push(item);
	}
	const selected = [...active, ...fill];
	const hidden = items.length - selected.length;
	return {
		items: selected,
		summary: hidden > 0 ? tr(`… ${hidden} more todo${hidden === 1 ? "" : "s"}`, `… 还有 ${hidden} 个待办`) : "",
	};
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-tui@18.10.1 src/tools/todo.ts#selectCollapsedTodos
function selectCollapsed(items: Item[]): { items: Item[]; summary: string } {
	const open = items.filter((item) => !isClosed(item));
	if (open.length === 0) return selectWithinCap(items);
	const lead = items.filter(isClosed).slice(-1);
	const selected = selectWithinCap(open);
	return { items: [...lead, ...selected.items], summary: selected.summary };
}
// @upstream-end

export type DeltaPhase =
	| { readonly kind: "items"; readonly name: string; readonly items: readonly Item[]; readonly explained: ReadonlySet<string> }
	| { readonly kind: "removed_phase"; readonly name: string }
	| { readonly kind: "removed_tasks"; readonly titles: readonly string[] };

export type ResultView =
	| { readonly kind: "full" }
	| { readonly kind: "delta"; readonly goalChanged: boolean; readonly phases: readonly DeltaPhase[] };

export function compactRemovedLabel(title: string): string {
	return `${forDisplay(title)} · ${tr("removed", "已删除")}`;
}

/** Full view for INIT, VIEW and expanded cards; incremental CRUD shows only the items/goal changed in this call. */
export function resultView(details: TodoMoreDetails, args: unknown, expanded: boolean): ResultView {
	if (expanded) return { kind: "full" };
	const call = parseCall(args);
	if (
		details.op === "init" ||
		details.op === "view" ||
		details.operations?.includes("init") ||
		details.changes?.some((change) => change.op === "init" || change.op === "view") ||
		call.commands.some((command) => command.kind === "init" || command.kind === "view")
	) {
		return { kind: "full" };
	}
	let goalChanged = details.op === "goal";
	const touchedTasks = new Set<string>();
	const explainedTasks = new Set<string>();
	const removedTaskCandidates: string[] = [];
	const removedPhaseCandidates: string[] = [];
	for (const completed of details.completedTasks ?? []) touchedTasks.add(completed.content);
	if (details.changes !== undefined && details.changes.length > 0) {
		for (const change of details.changes) {
			switch (change.op) {
				case "init":
				case "view":
					return { kind: "full" };
				case "goal":
					goalChanged = true;
					break;
				case "append":
					for (const item of change.items ?? []) touchedTasks.add(item.title);
					break;
				case "start":
				case "estimate":
					if (change.task !== undefined) touchedTasks.add(change.task);
					break;
				case "explain":
					if (change.task !== undefined) {
						touchedTasks.add(change.task);
						explainedTasks.add(change.task);
					}
					break;
				case "done":
				case "drop":
				case "block":
				case "unblock":
					if (change.task !== undefined) {
						touchedTasks.add(change.task);
					} else if (change.phase !== undefined) {
						const phase = details.more.phases.find((candidate) => candidate.name === change.phase);
						if (phase) for (const item of phase.items) touchedTasks.add(item.title);
					} else {
						for (const phase of details.more.phases) for (const item of phase.items) touchedTasks.add(item.title);
					}
					break;
				case "rm":
					if (change.task !== undefined) removedTaskCandidates.push(change.task);
					else if (change.phase !== undefined) removedPhaseCandidates.push(change.phase);
					break;
				default: {
					const unreachable: never = change.op;
					throw new Error(`Unexpected todo operation: ${String(unreachable)}`);
				}
			}
		}
	} else if (call.commands.length > 0) {
		for (const command of call.commands) {
			switch (command.kind) {
				case "init":
				case "view":
					return { kind: "full" };
				case "goal":
					goalChanged = true;
					break;
				case "phase":
					break;
				case "add":
				case "start":
				case "estimate":
					touchedTasks.add(command.title);
					break;
				case "explain":
					touchedTasks.add(command.title);
					explainedTasks.add(command.title);
					break;
				case "done":
				case "drop":
				case "block":
				case "unblock":
					switch (command.target.kind) {
						case "task":
							touchedTasks.add(command.target.title);
							break;
						case "phase": {
							const name = command.target.name;
							const phase = details.more.phases.find((candidate) => candidate.name === name);
							if (phase) for (const item of phase.items) touchedTasks.add(item.title);
							break;
						}
						case "all":
							for (const phase of details.more.phases) for (const item of phase.items) touchedTasks.add(item.title);
							break;
						default: {
							const unreachable: never = command.target;
							throw new Error(`Unexpected todo target: ${String(unreachable)}`);
						}
					}
					break;
				case "rm":
					if (command.target.kind === "task") removedTaskCandidates.push(command.target.title);
					else if (command.target.kind === "phase") removedPhaseCandidates.push(command.target.name);
					break;
				default: {
					const unreachable: never = command;
					throw new Error(`Unexpected todo command: ${String(unreachable)}`);
				}
			}
		}
	}
	const phases: DeltaPhase[] = [];
	const existingTitles = new Set(details.more.phases.flatMap((phase) => phase.items.map((item) => item.title)));
	for (const phase of details.more.phases) {
		const items = phase.items.filter((item) => touchedTasks.has(item.title));
		if (items.length > 0) phases.push({ kind: "items", name: phase.name, items, explained: explainedTasks });
	}
	for (const name of new Set(removedPhaseCandidates)) {
		if (!details.more.phases.some((phase) => phase.name === name && phase.items.length > 0)) {
			phases.push({ kind: "removed_phase", name });
		}
	}
	const removedTitles = [...new Set(removedTaskCandidates)].filter((title) => !existingTitles.has(title));
	if (removedTitles.length > 0) phases.push({ kind: "removed_tasks", titles: removedTitles });
	if (!goalChanged && phases.length === 0) return { kind: "full" };
	return { kind: "delta", goalChanged, phases };
}

// @upstream adapted @oh-my-pi/pi-tui@18.10.1 src/tools/todo.ts#partialStrikethrough
function strike(text: string): string {
	return `\x1b[9m${text}\x1b[29m`;
}
function completionLabel(text: string, transitioned: boolean, frame: number | undefined): string {
	// Extensions do not always receive animation frames; without one leave the checked label plain.
	if (frame === undefined || !transitioned) return text;
	if (frame <= 2) return text;
	const chars = [...text];
	const count = Math.ceil((chars.length * Math.min(frame - 2, 12)) / 12);
	if (count >= chars.length) return strike(text);
	return `${strike(chars.slice(0, count).join(""))}${chars.slice(count).join("")}`;
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-tui@18.10.1 src/tools/todo.ts#formatTodoLine
/** One row per task: estimate and missing explanation stay inline so the collapsed card keeps every field on one line. */
export function compactTodoLabel(item: Item): string {
	const parts = [forDisplay(item.title), item.time.kind === "estimated" ? `${item.time.minutes}m` : tr("no estimate", "无估计")];
	if (item.explanation === null) parts.push(tr("[explanation missing]", "[缺少说明]"));
	if (item.status === "blocked")
		parts.push(item.blocker ? `${tr("blocked", "已阻塞")}: ${forDisplay(item.blocker)}` : tr("blocked", "已阻塞"));
	if (item.commit !== undefined) parts.push(item.commit.sha.slice(0, 7));
	return parts.join(" · ");
}

function formatItem(item: Item, theme: Theme, transitioned: boolean, frame: number | undefined): string {
	const text = compactTodoLabel(item);
	switch (item.status) {
		case "completed":
			return theme.fg("success", `${theme.checkbox.checked} ${completionLabel(text, transitioned, frame)}`);
		case "in_progress":
			return theme.fg("accent", `${theme.checkbox.unchecked} ${text}`);
		case "abandoned":
			return theme.fg("error", `${theme.checkbox.unchecked} ${strike(text)}`);
		case "blocked":
			return theme.fg("warning", `${theme.checkbox.unchecked} ${text}`);
		case "pending":
			return theme.fg("dim", `${theme.checkbox.unchecked} ${text}`);
		default: {
			const unreachable: never = item.status;
			throw new Error(`Unexpected todo status: ${String(unreachable)}`);
		}
	}
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-tui@18.10.1 src/render/status-line.ts#renderStatusLine
function statusLine(theme: Theme, icon: string, meta: string): string {
	return `${icon} ${theme.fg("accent", tr("Todo", "待办"))}${meta ? ` ${theme.fg("dim", forDisplay(meta).replace(/\r\n?|\n/g, " "))}` : ""}`;
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-tui@18.10.1 src/render/output-block.ts#renderOutputBlock
/** Single-section, background-free frame using only public TUI primitives. */
function framedCard(theme: Theme, header: string, build: () => string[], error = false): Component {
	return {
		invalidate() {},
		render(width) {
			const box = theme.boxRound;
			const border = (text: string): string => theme.fg(error ? "error" : "borderMuted", text);
			const safeWidth = Math.max(1, width);
			const contentWidth = Math.max(1, safeWidth - 4);
			const left = `${box.topLeft}${box.horizontal.repeat(3)}`;
			const label = truncateToWidth(` ${header} `, Math.max(0, safeWidth - visibleWidth(left) - visibleWidth(box.topRight)));
			const fill = Math.max(0, safeWidth - visibleWidth(left) - visibleWidth(label) - visibleWidth(box.topRight));
			const lines = [`${border(left)}${label}${border(box.horizontal.repeat(fill) + box.topRight)}`];
			for (const line of build()) {
				for (const part of line.split("\n"))
					for (const wrapped of wrapTextWithAnsi(part.trimEnd(), contentWidth)) {
						lines.push(
							`${border(box.vertical)} ${wrapped}${" ".repeat(Math.max(0, contentWidth - visibleWidth(wrapped)))} ${border(box.vertical)}`,
						);
					}
			}
			lines.push(border(`${box.bottomLeft}${box.horizontal.repeat(Math.max(0, safeWidth - 2))}${box.bottomRight}`));
			return lines.map((line) => truncateToWidth(line, safeWidth, ""));
		},
	};
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-tui@18.10.1 src/tools/todo.ts#todoToolRenderer.renderCall
export function renderTodoCall(args: unknown, _options: ToolRenderResultOptions, theme: Theme): Component {
	const call = parseCall(args);
	const header = statusLine(theme, theme.styledSymbol("status.pending", "muted"), tr("preview — not committed", "预览 — 未提交"));
	return framedCard(theme, header, () => callPreviewLines(call).map((line) => theme.fg("dim", line)));
}
// @upstream-end

// @upstream adapted @oh-my-pi/pi-tui@18.10.1 src/tools/todo.ts#todoToolRenderer.renderResult
export function renderTodoResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	args?: unknown,
): Component {
	const text = result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	const parsed = detailsSchema.safeParse(result.details);
	if (result.isError || !parsed.success) {
		const detail = forDisplay(
			text ||
				(result.isError ? tr("Todo operation failed", "待办操作失败") : tr("Invalid todo-more result details", "Todo More 结果详情无效")),
		)
			.replace(/^Error:\s*/, "")
			.trim();
		return framedCard(theme, statusLine(theme, theme.styledSymbol("status.error", "error"), ""), () => [theme.fg("error", detail)], true);
	}
	const details: TodoMoreDetails = parsed.data;
	const phases = details.more.phases.filter((phase) => phase.items.length > 0);
	const completed = details.completedTasks ?? [];
	const completionKeys = new Set(completed.map((item) => `${item.phase}\u0000${item.content}`));
	const { closed, total } = progressCounts(details.more);
	const header = statusLine(theme, theme.styledSymbol("tool.todo", "accent"), `${closed}/${total}`);
	if (total === 0) return new Text(`${header}\n  ${theme.fg("dim", tr("No todos", "没有待办"))}`, 0, 0);
	return framedCard(theme, header, () => {
		const lines: string[] = [];
		const { expanded, spinnerFrame } = options;
		const view = resultView(details, args, expanded);
		if (view.kind === "delta") {
			if (view.goalChanged) {
				if (details.more.goal === null)
					lines.push(theme.fg("warning", `${tr("Objective", "目标")}: ${tr("[goal missing]", "[缺少目标]")}`));
				else for (const line of goalUiLines(details.more.goal)) lines.push(theme.fg("dim", forDisplay(line)));
			}
			for (let index = 0; index < view.phases.length; index++) {
				const phase = view.phases[index];
				if (phase === undefined) continue;
				switch (phase.kind) {
					case "items": {
						const name = `${phaseRomanNumeral(index + 1)}. ${forDisplay(phase.name)}`;
						lines.push(theme.fg("accent", theme.bold(name)));
						for (let row = 0; row < phase.items.length; row++) {
							const item = phase.items[row];
							if (item === undefined) continue;
							const last = row === phase.items.length - 1;
							const branch = theme.fg("dim", last ? theme.tree.last : theme.tree.branch);
							const continued = last ? "   " : `${theme.tree.vertical}  `;
							lines.push(`  ${branch} ${formatItem(item, theme, completionKeys.has(`${phase.name}\u0000${item.title}`), spinnerFrame)}`);
							if (phase.explained.has(item.title)) {
								const explanation = forDisplay(
									item.explanation ?? tr("(no explanation yet: add one with EXPLAIN)", "（尚无说明：请使用 EXPLAIN 添加）"),
								);
								for (const line of explanation.split("\n")) lines.push(`  ${theme.fg("dim", continued)}  ${theme.fg("dim", line)}`);
							}
						}
						break;
					}
					case "removed_phase": {
						const name = `${phaseRomanNumeral(index + 1)}. ${forDisplay(phase.name)}`;
						lines.push(theme.fg("accent", theme.bold(name)));
						lines.push(
							`  ${theme.fg("dim", theme.tree.last)} ${theme.fg("error", `${theme.checkbox.unchecked} ${strike(tr("Phase removed", "阶段已删除"))}`)}`,
						);
						break;
					}
					case "removed_tasks": {
						const name = `${phaseRomanNumeral(index + 1)}. ${tr("Removed", "已删除")}`;
						lines.push(theme.fg("accent", theme.bold(name)));
						for (let row = 0; row < phase.titles.length; row++) {
							const title = phase.titles[row];
							if (title === undefined) continue;
							const last = row === phase.titles.length - 1;
							const branch = theme.fg("dim", last ? theme.tree.last : theme.tree.branch);
							lines.push(`  ${branch} ${theme.fg("error", `${theme.checkbox.unchecked} ${strike(compactRemovedLabel(title))}`)}`);
						}
						break;
					}
					default: {
						const unreachable: never = phase;
						throw new Error(`Unexpected delta phase: ${String(unreachable)}`);
					}
				}
			}
			return lines;
		}
		if (details.more.goal === null) lines.push(theme.fg("warning", `${tr("Objective", "目标")}: ${tr("[goal missing]", "[缺少目标]")}`));
		else {
			const goal = goalUiLines(details.more.goal);
			for (const line of expanded ? goal : goal.slice(0, 1)) lines.push(theme.fg("dim", forDisplay(line)));
		}
		const multiPhase = phases.length > 1;
		for (let index = 0; index < phases.length; index++) {
			const phase = phases[index];
			if (phase === undefined) continue;
			const collapsed = !expanded && multiPhase && phase.items.every(isClosed);
			const name = `${phaseRomanNumeral(index + 1)}. ${forDisplay(phase.name)}`;
			const progress = `${phase.items.filter(isClosed).length}/${phase.items.length}`;
			lines.push(`${theme.fg(collapsed ? "dim" : "accent", theme.bold(name))}${theme.fg("dim", `  ${progress}`)}`);
			if (collapsed) continue;
			const selection = expanded ? { items: phase.items, summary: "" } : selectCollapsed(phase.items);
			for (let row = 0; row < selection.items.length; row++) {
				const item = selection.items[row];
				if (item === undefined) continue;
				const last = row === selection.items.length - 1 && selection.summary === "";
				const branch = theme.fg("dim", last ? theme.tree.last : theme.tree.branch);
				const continued = last ? "   " : `${theme.tree.vertical}  `;
				lines.push(`  ${branch} ${formatItem(item, theme, completionKeys.has(`${phase.name}\u0000${item.title}`), spinnerFrame)}`);
				if (expanded && !isClosed(item)) {
					const explanation = forDisplay(
						item.explanation ?? tr("(no explanation yet: add one with EXPLAIN)", "（尚无说明：请使用 EXPLAIN 添加）"),
					);
					for (const line of explanation.split("\n")) lines.push(`  ${theme.fg("dim", continued)}  ${theme.fg("dim", line)}`);
				}
			}
			if (selection.summary) lines.push(`  ${theme.fg("dim", theme.tree.last)} ${theme.fg("muted", selection.summary)}`);
		}
		return lines;
	});
}
// @upstream-end
