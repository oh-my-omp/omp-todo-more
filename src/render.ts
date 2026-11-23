import { z } from "@oh-my-pi/omptype/zod";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ToolRenderResultOptions } from "@oh-my-pi/pi-coding-agent";
import { type Component, replaceTabs, Text, type Theme } from "@oh-my-pi/pi-tui";
import { renderOutputBlock } from "@oh-my-pi/pi-tui/render/output-block";
import { renderStatusLine } from "@oh-my-pi/pi-tui/render/status-line";
import { isClosedTodo, phaseRomanNumeral, selectCollapsedTodos } from "@oh-my-pi/pi-tui/tools/todo";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { tr } from "../omomp-shared/i18n.ts";
import { previewTodoArgs, type TodoPreview } from "./protocol.ts";
import { commitScopeSchema, persistedStatusSchema, type TodoMoreSnapshot, todoGoalSchema, todoMoreSnapshotSchema } from "./state.ts";
import { OPS, type Op } from "./tool.ts";

const itemParamSchema = z.object({
	id: z.string().optional(),
	title: z.string(),
	explanation: z.string(),
	estimatedMinutes: z.number(),
});

// Results written before the DSL and BLOCK/UNBLOCK were retired still name those operations.
const HISTORICAL_OPS = ["append", "rm", "view"] as const;
const LEGACY_OPS = ["block", "unblock"] as const;
type HistoricalOp = (typeof HISTORICAL_OPS)[number];
type LegacyOp = (typeof LEGACY_OPS)[number];
type StoredOp = Op | HistoricalOp;
const ALL_STORED_OPS = [...OPS, ...HISTORICAL_OPS] as const;
const ALL_RESULT_OPS = [...OPS, "batch", ...HISTORICAL_OPS, "update"] as const;
const isLegacyOp = (op: string): op is LegacyOp => (LEGACY_OPS as readonly string[]).includes(op);
const currentOp = (op: StoredOp | LegacyOp): op is StoredOp => !isLegacyOp(op);

const changeSchema = z.object({
	op: z.enum([...ALL_STORED_OPS, ...LEGACY_OPS]),
	id: z.string().optional(),
	title: z.string().optional(),
	goal: todoGoalSchema.optional(),
	list: z.array(z.object({ phase: z.string(), items: z.array(itemParamSchema) })).optional(),
	task: z.string().optional(),
	phase: z.string().optional(),
	items: z.array(itemParamSchema).optional(),
	explanation: z.string().optional(),
	estimatedMinutes: z.number().optional(),
	commit: z.object({ scope: commitScopeSchema, message: z.string() }).optional(),
});

type Change = z.infer<typeof changeSchema>;

export const detailsSchema = z.object({
	op: z
		.enum([...ALL_RESULT_OPS, ...LEGACY_OPS])
		.optional()
		.transform((op) => (op === undefined || isLegacyOp(op) ? undefined : op)),
	operations: z
		.array(z.enum([...ALL_STORED_OPS, ...LEGACY_OPS]))
		.optional()
		.transform((operations) => operations?.filter(currentOp)),
	changes: z
		.array(changeSchema)
		.optional()
		.transform((changes) => changes?.filter((change): change is Change & { op: StoredOp } => currentOp(change.op))),
	phases: z.array(z.object({ name: z.string(), tasks: z.array(z.object({ content: z.string(), status: persistedStatusSchema })) })),
	storage: z.enum(["session", "memory"]),
	completedTasks: z.array(z.object({ phase: z.string(), content: z.string() })).optional(),
	todoMore: z.literal(true),
	more: todoMoreSnapshotSchema,
});

export type ReadTodoDetails = Omit<z.infer<typeof detailsSchema>, "phases">;
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

type Call = TodoPreview;
export function parseCall(args: unknown): Call {
	return previewTodoArgs(args);
}

export function previewOperationCount(call: Call): number {
	return (
		(call.goal === undefined ? 0 : 1) +
		call.add.length +
		(call.start_id === undefined ? 0 : 1) +
		call.explain.length +
		call.estimate.length +
		call.done_ids.length +
		call.drop_ids.length
	);
}

export function callPreviewLines(call: Call): string[] {
	const lines = [tr("Preview only — not committed.", "仅预览 — 未提交。")];
	if (call.goal !== undefined) {
		lines.push(
			`goal`,
			`  ${tr("Objective", "目标")}: ${call.goal.title ?? ""}`,
			`  ${tr("Measure", "衡量方式")}: ${call.goal.summary ?? ""}`,
			`  ${tr("Done when", "完成条件")}: ${call.goal.acceptance ?? ""}`,
		);
	}
	for (const item of call.add) {
		lines.push(
			`add [${item.phase ?? "Tasks"}] ${item.title ?? ""}`,
			...(item.detail === undefined ? [] : [`  ${tr("Explanation", "说明")}: ${item.detail}`]),
			...(item.minutes === undefined ? [] : [`  ${tr("Estimate", "预计")}: ${item.minutes}${tr("m", "分钟")}`]),
		);
	}
	if (call.start_id !== undefined) lines.push(`start_id: ${call.start_id}`);
	for (const entry of call.explain) {
		lines.push(`explain ${entry.id ?? ""}`, ...(entry.note === undefined ? [] : [`  ${tr("Explanation", "说明")}: ${entry.note}`]));
	}
	for (const entry of call.estimate) {
		lines.push(`estimate ${entry.id ?? ""}: ${entry.minutes ?? ""}${tr("m", "分钟")}`);
	}
	if (call.done_ids.length > 0) lines.push(`done_ids: ${call.done_ids.join(", ")}`);
	if (call.drop_ids.length > 0) lines.push(`drop_ids: ${call.drop_ids.join(", ")}`);
	if (previewOperationCount(call) === 0) {
		lines.push(call.complete ? `view (${call.view ?? "all"})` : tr("Waiting for todo arguments.", "等待待办参数。"));
	}
	if (call.error !== undefined) lines.push(`${tr("Invalid preview", "预览无效")}: ${call.error}`);
	lines.push(
		call.complete
			? tr("Arguments complete; awaiting execution.", "参数完整；等待执行。")
			: tr("Generating — awaiting complete todo arguments.", "正在生成 — 等待完整待办参数。"),
	);
	return lines.map(forDisplay);
}

function forDisplay(text: string): string {
	return replaceTabs(sanitizeText(text));
}

export function progressCounts(more: TodoMoreSnapshot): { closed: number; total: number } {
	const phases = more.phases.filter((phase) => phase.items.length > 0);
	return {
		closed: phases.reduce((sum, phase) => sum + phase.items.filter(isClosedTodo).length, 0),
		total: phases.reduce((sum, phase) => sum + phase.items.length, 0),
	};
}

const COLLAPSED_ITEMS = 8;

// The host selects the rows but words its summary in English only; recompute the count from the selection so the summary stays localized.
function selectCollapsed(items: Item[]): { items: Item[]; summary: string } {
	const selected = selectCollapsedTodos(items, () => false, COLLAPSED_ITEMS);
	if (selected.summary === "") return { items: selected.items, summary: "" };
	const open = items.filter((item) => !isClosedTodo(item));
	const considered = open.length > 0 ? open : items;
	const active = considered.filter((item) => item.status === "in_progress").length;
	if (active > COLLAPSED_ITEMS) {
		const hidden = active - COLLAPSED_ITEMS;
		return {
			items: selected.items,
			summary: tr(`… ${hidden} more active todo${hidden === 1 ? "" : "s"}`, `… 还有 ${hidden} 个进行中的待办`),
		};
	}
	const shown = new Set(considered);
	const hidden = considered.length - selected.items.filter((item) => shown.has(item)).length;
	return { items: selected.items, summary: tr(`… ${hidden} more todo${hidden === 1 ? "" : "s"}`, `… 还有 ${hidden} 个待办`) };
}

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

function titleById(more: TodoMoreSnapshot, id: string): string | undefined {
	for (const phase of more.phases) {
		const found = phase.items.find((item) => item.id === id);
		if (found) return found.title;
	}
	return undefined;
}

export function resultView(details: ReadTodoDetails, args: unknown, expanded: boolean): ResultView {
	if (expanded) return { kind: "full" };
	const call = parseCall(args);
	if (
		details.op === "init" ||
		details.op === "view" ||
		details.operations?.includes("init") ||
		details.changes?.some((change) => change.op === "init" || change.op === "view")
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
				case "add":
				case "append":
					for (const item of change.items ?? []) touchedTasks.add(item.title);
					break;
				case "start":
				case "estimate": {
					const name = change.title ?? change.task ?? (change.id === undefined ? undefined : titleById(details.more, change.id));
					if (name !== undefined) touchedTasks.add(name);
					break;
				}
				case "explain": {
					const name = change.title ?? change.task ?? (change.id === undefined ? undefined : titleById(details.more, change.id));
					if (name !== undefined) {
						touchedTasks.add(name);
						explainedTasks.add(name);
					}
					break;
				}
				case "done":
				case "drop": {
					const name = change.title ?? change.task ?? (change.id === undefined ? undefined : titleById(details.more, change.id));
					if (name !== undefined) {
						touchedTasks.add(name);
					} else if (change.phase !== undefined) {
						const phase = details.more.phases.find((candidate) => candidate.name === change.phase);
						if (phase) for (const item of phase.items) touchedTasks.add(item.title);
					} else {
						for (const phase of details.more.phases) for (const item of phase.items) touchedTasks.add(item.title);
					}
					break;
				}
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
	} else if (previewOperationCount(call) > 0) {
		if (call.goal !== undefined) goalChanged = true;
		for (const item of call.add) if (item.title !== undefined) touchedTasks.add(item.title);
		if (call.start_id !== undefined) {
			const name = titleById(details.more, call.start_id);
			if (name !== undefined) touchedTasks.add(name);
		}
		for (const entry of call.explain) {
			const name = entry.id === undefined ? undefined : titleById(details.more, entry.id);
			if (name !== undefined) {
				touchedTasks.add(name);
				explainedTasks.add(name);
			}
		}
		for (const entry of call.estimate) {
			const name = entry.id === undefined ? undefined : titleById(details.more, entry.id);
			if (name !== undefined) touchedTasks.add(name);
		}
		for (const id of call.done_ids) {
			const name = titleById(details.more, id);
			if (name !== undefined) touchedTasks.add(name);
		}
		for (const id of call.drop_ids) {
			const name = titleById(details.more, id);
			if (name !== undefined) touchedTasks.add(name);
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

function strike(text: string): string {
	return `\x1b[9m${text}\x1b[29m`;
}
function completionLabel(text: string, transitioned: boolean, frame: number | undefined): string {
	if (frame === undefined || !transitioned) return text;
	if (frame <= 2) return text;
	const chars = [...text];
	const count = Math.ceil((chars.length * Math.min(frame - 2, 12)) / 12);
	if (count >= chars.length) return strike(text);
	return `${strike(chars.slice(0, count).join(""))}${chars.slice(count).join("")}`;
}

export function compactTodoLabel(item: Item): string {
	const parts = [forDisplay(item.title), item.time.kind === "estimated" ? `${item.time.minutes}m` : tr("no estimate", "无估计")];
	if (item.explanation === null) parts.push(tr("[explanation missing]", "[缺少说明]"));
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
		case "pending":
			return theme.fg("dim", `${theme.checkbox.unchecked} ${text}`);
		default: {
			const unreachable: never = item.status;
			throw new Error(`Unexpected todo status: ${String(unreachable)}`);
		}
	}
}

function statusLine(theme: Theme, icon: string, meta: string): string {
	return renderStatusLine({ iconOverride: icon, title: tr("Todo", "待办"), meta: [meta] }, theme);
}

function framedCard(theme: Theme, header: string, build: () => string[], error = false): Component {
	return {
		invalidate() {},
		render(width) {
			return renderOutputBlock(
				{ header, sections: [{ lines: build() }], width, applyBg: false, borderColor: error ? "error" : "borderMuted" },
				theme,
			);
		},
	};
}

export function renderTodoCall(args: unknown, _options: ToolRenderResultOptions, theme: Theme): Component {
	const call = parseCall(args);
	const header = statusLine(theme, theme.styledSymbol("status.pending", "muted"), tr("preview — not committed", "预览 — 未提交"));
	return framedCard(theme, header, () => callPreviewLines(call).map((line) => theme.fg("dim", line)));
}

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
	const details: ReadTodoDetails = parsed.data;
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
									item.explanation ?? tr("(no explanation yet: add one with explain)", "（尚无说明：请使用 explain 添加）"),
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
			const collapsed = !expanded && multiPhase && phase.items.every(isClosedTodo);
			const name = `${phaseRomanNumeral(index + 1)}. ${forDisplay(phase.name)}`;
			const progress = `${phase.items.filter(isClosedTodo).length}/${phase.items.length}`;
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
				if (expanded && !isClosedTodo(item)) {
					const explanation = forDisplay(
						item.explanation ?? tr("(no explanation yet: add one with explain)", "（尚无说明：请使用 explain 添加）"),
					);
					for (const line of explanation.split("\n")) lines.push(`  ${theme.fg("dim", continued)}  ${theme.fg("dim", line)}`);
				}
			}
			if (selection.summary) lines.push(`  ${theme.fg("dim", theme.tree.last)} ${theme.fg("muted", selection.summary)}`);
		}
		return lines;
	});
}
