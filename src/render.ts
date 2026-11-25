import { z } from "@oh-my-pi/omptype/zod";
import { replaceTabs } from "@oh-my-pi/pi-tui/text/width";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { tr } from "../omomp-shared/i18n.ts";
import { OPS } from "./kernel.ts";
import type { TodoCallPreview } from "./protocol.ts";
import { type SnapshotItem, TODO_STATUSES, todoNgSnapshotSchema } from "./state.ts";
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

function previewOperationCount(call: TodoCallPreview): number {
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

export function compactTodoLabel(item: SnapshotItem): string {
	const parts = [forDisplay(item.title), item.estimate.kind === "estimated" ? `${item.estimate.minutes}m` : tr("no estimate", "无估计")];
	if (item.explanation === null) parts.push(tr("[explanation missing]", "[缺少说明]"));
	if (item.commit !== null) parts.push(item.commit.sha.slice(0, 7));
	return parts.join(" · ");
}
