import { z } from "@oh-my-pi/omptype/zod";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ToolRenderResultOptions } from "@oh-my-pi/pi-coding-agent";
import { type Component, replaceTabs, Text, type Theme } from "@oh-my-pi/pi-tui";
import { renderOutputBlock } from "@oh-my-pi/pi-tui/render/output-block";
import { renderStatusLine } from "@oh-my-pi/pi-tui/render/status-line";
import { isClosedTodo, phaseRomanNumeral, selectCollapsedTodos } from "@oh-my-pi/pi-tui/tools/todo";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { tr } from "../omomp-shared/i18n.ts";
import { OPS } from "./kernel.ts";
import { previewTodoArgs, type TodoCallPreview } from "./protocol.ts";
import { type SnapshotItem, TODO_STATUSES, type TodoNgSnapshot, todoNgSnapshotSchema } from "./state.ts";
import { RESULT_OPS } from "./tool.ts";

const changeSchema = z.union([
	z.object({ op: z.literal("goal") }),
	z.object({ op: z.literal("add"), items: z.array(z.object({ id: z.string() })) }),
	z.object({ op: z.enum(["start", "explain", "estimate", "done", "drop"]), id: z.string() }),
]);

export const detailsSchema = z.object({
	op: z.enum(RESULT_OPS).optional(),
	operations: z.array(z.enum(OPS)).optional(),
	changes: z.array(changeSchema).optional(),
	phases: z.array(z.object({ name: z.string(), tasks: z.array(z.object({ content: z.string(), status: z.enum(TODO_STATUSES) })) })),
	storage: z.enum(["session", "memory"]),
	todoMore: z.literal(true),
	more: todoNgSnapshotSchema,
});

export type ReadTodoDetails = Omit<z.infer<typeof detailsSchema>, "phases">;

function goalUiLines(goal: TodoNgSnapshot["goal"]): string[] {
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

export function previewOperationCount(call: TodoCallPreview): number {
	return (
		(call.goal === undefined ? 0 : 1) +
		call.add.length +
		(call.start_id === undefined ? 0 : 1) +
		call.explain.length +
		call.estimate.length +
		(call.done_id === undefined ? 0 : 1) +
		call.drop_ids.length
	);
}

export function callPreviewLines(call: TodoCallPreview): string[] {
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
	if (call.done_id !== undefined) lines.push(`done_id: ${call.done_id}`);
	if (call.commit !== undefined) {
		lines.push(
			`commit`,
			...(call.commit.paths === undefined ? [] : [`  ${tr("Paths", "路径")}: ${call.commit.paths.join(" ")}`]),
			`  ${tr("Message", "说明")}: ${call.commit.message ?? ""}`,
		);
	}
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

export function progressCounts(more: TodoNgSnapshot): { closed: number; total: number } {
	const phases = more.phases.filter((phase) => phase.items.length > 0);
	return {
		closed: phases.reduce((sum, phase) => sum + phase.items.filter(isClosedTodo).length, 0),
		total: phases.reduce((sum, phase) => sum + phase.items.length, 0),
	};
}

const COLLAPSED_ITEMS = 8;

function selectCollapsed(items: SnapshotItem[]): { items: SnapshotItem[]; summary: string } {
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

export type DeltaPhase = { readonly name: string; readonly items: readonly SnapshotItem[] };

export type ResultView =
	| { readonly kind: "full" }
	| {
			readonly kind: "delta";
			readonly goalChanged: boolean;
			readonly phases: readonly DeltaPhase[];
			readonly explained: ReadonlySet<string>;
	  };

export function resultView(details: ReadTodoDetails, expanded: boolean): ResultView {
	if (expanded || details.changes === undefined) return { kind: "full" };
	if (details.op === "init" || details.op === "view" || details.operations?.includes("init")) return { kind: "full" };
	let goalChanged = false;
	const touched = new Set<string>();
	const explained = new Set<string>();
	for (const change of details.changes) {
		switch (change.op) {
			case "goal":
				goalChanged = true;
				break;
			case "add":
				for (const item of change.items) touched.add(item.id);
				break;
			case "explain":
				explained.add(change.id);
				touched.add(change.id);
				break;
			case "start":
			case "estimate":
			case "done":
			case "drop":
				touched.add(change.id);
				break;
			default: {
				const unreachable: never = change;
				throw new Error(`Unexpected todo change: ${String(unreachable)}`);
			}
		}
	}
	const phases = details.more.phases.flatMap((phase) => {
		const items = phase.items.filter((item) => touched.has(item.id));
		return items.length > 0 ? [{ name: phase.name, items }] : [];
	});
	if (!goalChanged && phases.length === 0) return { kind: "full" };
	return { kind: "delta", goalChanged, phases, explained };
}

export function completedIds(details: ReadTodoDetails): ReadonlySet<string> {
	return new Set(details.changes?.flatMap((change) => (change.op === "done" ? [change.id] : [])));
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

export function compactTodoLabel(item: SnapshotItem): string {
	const parts = [forDisplay(item.title), item.estimate.kind === "estimated" ? `${item.estimate.minutes}m` : tr("no estimate", "无估计")];
	if (item.explanation === null) parts.push(tr("[explanation missing]", "[缺少说明]"));
	if (item.commit !== null) parts.push(item.commit.sha.slice(0, 7));
	return parts.join(" · ");
}

function formatItem(item: SnapshotItem, theme: Theme, transitioned: boolean, frame: number | undefined): string {
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
	const call = previewTodoArgs(args);
	const header = statusLine(theme, theme.styledSymbol("status.pending", "muted"), tr("preview — not committed", "预览 — 未提交"));
	return framedCard(theme, header, () => callPreviewLines(call).map((line) => theme.fg("dim", line)));
}

export function renderTodoResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme): Component {
	const text = result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	const parsed = detailsSchema.safeParse(result.details);
	if (result.isError || !parsed.success) {
		const detail = forDisplay(
			text || (result.isError ? tr("Todo operation failed", "待办操作失败") : tr("Invalid todo-ng result details", "Todo NG 结果详情无效")),
		)
			.replace(/^Error:\s*/, "")
			.trim();
		return framedCard(theme, statusLine(theme, theme.styledSymbol("status.error", "error"), ""), () => [theme.fg("error", detail)], true);
	}
	const details: ReadTodoDetails = parsed.data;
	const phases = details.more.phases.filter((phase) => phase.items.length > 0);
	const completed = completedIds(details);
	const { closed, total } = progressCounts(details.more);
	const header = statusLine(theme, theme.styledSymbol("tool.todo", "accent"), `${closed}/${total}`);
	if (total === 0) return new Text(`${header}\n  ${theme.fg("dim", tr("No todos", "没有待办"))}`, 0, 0);
	return framedCard(theme, header, () => {
		const lines: string[] = [];
		const { expanded, spinnerFrame } = options;
		const view = resultView(details, expanded);
		if (view.kind === "delta") {
			if (view.goalChanged) {
				if (details.more.goal === null)
					lines.push(theme.fg("warning", `${tr("Objective", "目标")}: ${tr("[goal missing]", "[缺少目标]")}`));
				else for (const line of goalUiLines(details.more.goal)) lines.push(theme.fg("dim", forDisplay(line)));
			}
			for (const [index, phase] of view.phases.entries()) {
				lines.push(theme.fg("accent", theme.bold(`${phaseRomanNumeral(index + 1)}. ${forDisplay(phase.name)}`)));
				for (const [row, item] of phase.items.entries()) {
					const last = row === phase.items.length - 1;
					const branch = theme.fg("dim", last ? theme.tree.last : theme.tree.branch);
					const continued = last ? "   " : `${theme.tree.vertical}  `;
					lines.push(`  ${branch} ${formatItem(item, theme, completed.has(item.id), spinnerFrame)}`);
					if (view.explained.has(item.id)) {
						const explanation = forDisplay(
							item.explanation ?? tr("(no explanation yet: add one with explain)", "（尚无说明：请使用 explain 添加）"),
						);
						for (const line of explanation.split("\n")) lines.push(`  ${theme.fg("dim", continued)}  ${theme.fg("dim", line)}`);
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
				lines.push(`  ${branch} ${formatItem(item, theme, completed.has(item.id), spinnerFrame)}`);
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
