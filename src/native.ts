import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { type NativeChild, type NativeNode, node, stableKey } from "@oh-my-pi/pi-tui";
import { isClosedTodo } from "@oh-my-pi/pi-tui/tools/todo";
import { tr } from "../omomp-shared/i18n.ts";
import { type parametersSchema, previewTodoArgs } from "./protocol.ts";
import {
	callPreviewLines,
	compactTodoLabel,
	detailsSchema,
	previewOperationCount,
	progressCounts,
	type ReadTodoDetails,
	resultView,
} from "./render.ts";
import { commitRecordText, type SnapshotItem, type TodoMoreSnapshot, type TodoStatus } from "./state.ts";
import type { TodoMoreDetails } from "./tool.ts";

export function uiTimeEstimate(item: Pick<SnapshotItem, "estimate">): string {
	return item.estimate.kind === "estimated"
		? `${tr("Estimate", "预计")}: ${item.estimate.minutes} ${tr("min", "分钟")}`
		: tr("(no time estimate yet: add one with estimate)", "（尚无时间估计：请使用 estimate 添加）");
}

function checklistStatus(status: TodoStatus): "pending" | "active" | "done" | "dropped" {
	switch (status) {
		case "pending":
			return "pending";
		case "in_progress":
			return "active";
		case "completed":
			return "done";
		case "abandoned":
			return "dropped";
		default: {
			const unreachable: never = status;
			throw new Error(`Unexpected todo status: ${String(unreachable)}`);
		}
	}
}

function checklistPhases(snapshot: TodoMoreSnapshot) {
	return snapshot.phases.map((phase) => ({
		id: phase.name,
		title: phase.name,
		collapsed: false,
		items: phase.items.map((item) => ({
			id: item.id,
			text: item.title,
			status: checklistStatus(item.status),
			note: `${uiTimeEstimate(item)}\n${tr("Explanation", "说明")}: ${item.explanation ?? tr("[explanation missing]", "[缺少说明]")}${item.commit === null ? "" : `\n${tr("Commit", "提交")}: ${commitRecordText(item.commit)}`}`,
		})),
	}));
}

export function describeSnapshot(snapshot: TodoMoreSnapshot, editable = false, selectedId?: string): NativeChild[] {
	const missingGoal = tr("[goal missing]", "[缺少目标]");
	const body: NativeChild[] = [
		node(
			"kv",
			{
				role: "todo-more.goal",
				items: [
					{ k: tr("Objective", "目标"), v: snapshot.goal?.objective ?? missingGoal },
					{ k: tr("Measure", "衡量方式"), v: snapshot.goal?.measure ?? missingGoal },
					{ k: tr("Done when", "完成条件"), v: snapshot.goal?.doneWhen ?? missingGoal },
				],
			},
			undefined,
			"goal",
		),
		node(
			"checklist",
			{
				role: "todo-more.list",
				mode: "full",
				phases: checklistPhases(snapshot),
			},
			undefined,
			"list",
		),
	];
	if (snapshot.phases.every((phase) => phase.items.length === 0))
		body.push(node("text", { text: tr("Todo list is empty.", "待办列表为空。") }));
	if (editable) {
		for (const phase of snapshot.phases) {
			for (const item of phase.items) {
				const editExplanation = `${tr("Edit explanation", "编辑说明")}: ${item.title}`;
				body.push(
					node(
						"row",
						{
							role: "omp.btn",
							actions: { click: `todo-more.explain:${item.id}` },
							title: editExplanation,
							tone: selectedId === item.id ? "accent" : undefined,
						},
						[node("text", { text: editExplanation })],
						stableKey(item.id),
					),
				);
			}
		}
	}
	return body;
}

export function describeTodoHud(snapshot: TodoMoreSnapshot, expanded = false): NativeNode | null {
	let total = 0;
	let closed = 0;
	let active: string | undefined;
	let pending: string | undefined;
	for (const phase of snapshot.phases) {
		for (const item of phase.items) {
			total++;
			switch (item.status) {
				case "completed":
				case "abandoned":
					closed++;
					break;
				case "in_progress":
					active ??= item.title;
					break;
				case "pending":
					pending ??= item.title;
					break;
				default: {
					const unreachable: never = item.status;
					throw new Error(`Unexpected todo status: ${String(unreachable)}`);
				}
			}
		}
	}
	if (total === 0) return null;
	const label = active ?? pending ?? (closed === total ? tr("All done", "全部完成") : tr("Todos", "待办"));
	return node(
		"row",
		{ role: "omp.hud.activity", aria: tr("Todo More progress", "Todo More 进度"), align: "center", gap: "sm" },
		[
			node(
				"col",
				{ role: "omp.hud.todo", aria: tr("Todo More pill", "Todo More 待办条"), gap: "none" },
				[
					node(
						"card",
						{
							aria: tr("Todo More disclosure", "Todo More 展开项"),
							head: `${label} ${closed}/${total}`,
							variant: "bare",
							collapsible: true,
							collapsed: !expanded,
						},
						[node("checklist", { role: "todo-more.visual", mode: "hud", phases: checklistPhases(snapshot) }, undefined, "visual")],
						"control",
					),
					...(expanded
						? [
								node(
									"col",
									{ role: "todo-more.popover", aria: tr("Todo More popover", "Todo More 弹出面板") },
									[
										node(
											"col",
											{ role: "todo-more.details", gap: "sm" },
											[
												...describeSnapshot(snapshot),
												node(
													"row",
													{ role: "omp.btn", actions: { click: "todo-more.open" } },
													[node("text", { text: tr("Edit goal / explanations", "编辑目标/说明") })],
													"edit",
												),
											],
											"details",
										),
									],
									"popover",
								),
							]
						: []),
				],
				"pill",
			),
		],
		"todo-more.hud",
	);
}

export const describeTodoCall: NonNullable<ToolDefinition<typeof parametersSchema, TodoMoreDetails>["describeCall"]> = (args) => {
	const call = previewTodoArgs(args);
	const count = previewOperationCount(call);
	return {
		tool: {
			title: tr("Todo More", "Todo More"),
			target: tr("preview — not committed", "预览 — 未提交"),
			meta: [tr(`${count} operation${count === 1 ? "" : "s"}`, `${count} 项操作`)],
		},
		open: true,
		preview: "children",
		body: [
			node(
				"col",
				{ role: "todo-more.preview", gap: "sm" },
				callPreviewLines(call).map((text, index) => node("text", { text, wrap: "word" }, undefined, `line-${index}`)),
			),
		],
	};
};

export const describeTodoResult: NonNullable<ToolDefinition<typeof parametersSchema, TodoMoreDetails>["describeResult"]> = (
	result,
	options,
) => {
	const parsed = detailsSchema.safeParse(result.details);
	if (result.isError || !parsed.success) {
		const text = result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
		return {
			tool: { title: tr("Todo", "待办") },
			tone: "error",
			body: [node("text", { text: text || tr("Invalid todo-more result details", "Todo More 结果详情无效"), wrap: "word" })],
		};
	}
	const { closed, total } = progressCounts(parsed.data.more);
	return {
		tool: total === 0 ? { title: tr("Todo", "待办") } : { title: tr("Todo", "待办"), target: `${closed}/${total}`, targetKind: "text" },
		open: true,
		preview: "none",
		body: [node("col", { role: "todo-more.panel", gap: "sm" }, resultPanel(parsed.data, options.expanded))],
	};
};

function resultPanel(details: ReadTodoDetails, expanded: boolean): NativeChild[] {
	const { more } = details;
	const phases = more.phases.filter((phase) => phase.items.length > 0);
	const missingGoal = tr("[goal missing]", "[缺少目标]");
	if (phases.length === 0) return [node("text", { text: tr("Todo list is empty.", "待办列表为空。"), wrap: "word" }, undefined, "empty")];
	const view = resultView(details, expanded);
	if (view.kind === "delta") {
		const children: NativeChild[] = [];
		if (view.goalChanged) {
			children.push(
				node(
					"kv",
					{
						role: "todo-more.goal",
						items: [
							{ k: tr("Objective", "目标"), v: more.goal?.objective ?? missingGoal },
							{ k: tr("Measure", "衡量方式"), v: more.goal?.measure ?? missingGoal },
							{ k: tr("Done when", "完成条件"), v: more.goal?.doneWhen ?? missingGoal },
						],
					},
					undefined,
					"goal",
				),
			);
		}
		if (view.phases.length > 0) {
			const checklistPhases = view.phases.map((phase, p) => ({
				id: `p${p}`,
				title: phase.name,
				collapsed: false,
				items: phase.items.map((item, t) => ({
					id: `p${p}.${t}`,
					text: compactTodoLabel(item),
					status: checklistStatus(item.status),
					note: view.explained.has(item.id)
						? `${tr("Explanation", "说明")}: ${item.explanation ?? tr("[explanation missing]", "[缺少说明]")}`
						: undefined,
				})),
			}));
			children.push(node("checklist", { role: "todo-more.list", mode: "full", phases: checklistPhases }, undefined, "list"));
		}
		return children;
	}
	const goal = expanded
		? node(
				"kv",
				{
					role: "todo-more.goal",
					items: [
						{ k: tr("Objective", "目标"), v: more.goal?.objective ?? missingGoal },
						{ k: tr("Measure", "衡量方式"), v: more.goal?.measure ?? missingGoal },
						{ k: tr("Done when", "完成条件"), v: more.goal?.doneWhen ?? missingGoal },
					],
				},
				undefined,
				"goal",
			)
		: node("text", { text: `${tr("Objective", "目标")}: ${more.goal?.objective ?? missingGoal}`, wrap: "word" }, undefined, "goal");
	const checklistPhases = phases.map((phase, p) => ({
		id: `p${p}`,
		title: phase.name,
		collapsed: !expanded && phase.items.every(isClosedTodo),
		items: phase.items.map((item, t) => ({
			id: `p${p}.${t}`,
			text: compactTodoLabel(item),
			status: checklistStatus(item.status),
			note: expanded
				? `${tr("Explanation", "说明")}: ${item.explanation ?? tr("[explanation missing]", "[缺少说明]")}${item.commit === null ? "" : `\n${tr("Commit", "提交")}: ${commitRecordText(item.commit)}`}`
				: undefined,
		})),
	}));
	return [goal, node("checklist", { role: "todo-more.list", mode: "full", phases: checklistPhases }, undefined, "list")];
}
