import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { type NativeChild, type NativeNode, node, stableKey } from "@oh-my-pi/pi-tui";
import { tr } from "./i18n.ts";
import type { parametersSchema } from "./protocol.ts";
import {
	callPreviewLines,
	compactRemovedLabel,
	compactTodoLabel,
	detailsSchema,
	isClosed,
	parseCall,
	progressCounts,
	resultView,
} from "./render.ts";
import { commitRecordText, type TodoMoreSnapshot, type TodoStatus } from "./state.ts";
import type { TodoMoreDetails } from "./tool.ts";

function uiTimeEstimate(item: TodoMoreSnapshot["phases"][number]["items"][number]): string {
	return item.time.kind === "estimated"
		? `${tr("Estimate", "预计")}: ${item.time.minutes} ${tr("min", "分钟")}`
		: tr("(no time estimate yet: add one with ESTIMATE)", "（尚无时间估计：请使用 ESTIMATE 添加）");
}

function checklistStatus(status: TodoStatus): "pending" | "active" | "done" | "dropped" | "blocked" {
	switch (status) {
		case "pending":
			return "pending";
		case "in_progress":
			return "active";
		case "completed":
			return "done";
		case "abandoned":
			return "dropped";
		case "blocked":
			return "blocked";
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
			id: item.title,
			text: item.title,
			status: checklistStatus(item.status),
			note: `${uiTimeEstimate(item)}\n${tr("Explanation", "说明")}: ${item.explanation ?? tr("[explanation missing]", "[缺少说明]")}${item.blocker === undefined ? "" : `\n${tr("Blocker", "阻塞原因")}: ${item.blocker}`}${item.commit === undefined ? "" : `\n${tr("Commit", "提交")}: ${commitRecordText(item.commit)}`}`,
		})),
	}));
}

/** A presentation of a snapshot only; callers must read the branch before editing. */
export function describeSnapshot(snapshot: TodoMoreSnapshot, editable = false, selectedTitle?: string): NativeChild[] {
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
							actions: { click: `todo-more.explain:${item.title}` },
							title: editExplanation,
							tone: selectedTitle === item.title ? "accent" : undefined,
						},
						[node("text", { text: editExplanation })],
						stableKey(item.title),
					),
				);
			}
		}
	}
	return body;
}

/** Tern draws the pill; the plugin owns its accessible trigger and anchored rich disclosure. */
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
				case "blocked":
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
	const call = parseCall(args);
	return {
		tool: {
			title: tr("Todo More", "Todo More"),
			target: tr("preview — not committed", "预览 — 未提交"),
			meta: [tr(`${call.commands.length} complete command${call.commands.length === 1 ? "" : "s"}`, `${call.commands.length} 条完整命令`)],
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
	args,
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
		body: [node("col", { role: "todo-more.panel", gap: "sm" }, resultPanel(parsed.data, args, options.expanded))],
	};
};

/** Native-shaped result card: INIT/VIEW/expanded show the full list; incremental CRUD shows only the changed items/goal. */
function resultPanel(details: TodoMoreDetails, args: unknown, expanded: boolean): NativeChild[] {
	const { more } = details;
	const phases = more.phases.filter((phase) => phase.items.length > 0);
	const missingGoal = tr("[goal missing]", "[缺少目标]");
	if (phases.length === 0) return [node("text", { text: tr("Todo list is empty.", "待办列表为空。"), wrap: "word" }, undefined, "empty")];
	const view = resultView(details, args, expanded);
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
			const checklistPhases = view.phases.map((phase, p) => {
				switch (phase.kind) {
					case "items":
						return {
							id: `p${p}`,
							title: phase.name,
							collapsed: false,
							items: phase.items.map((item, t) => ({
								id: `p${p}.${t}`,
								text: compactTodoLabel(item),
								status: checklistStatus(item.status),
								...(phase.explained.has(item.title)
									? { note: `${tr("Explanation", "说明")}: ${item.explanation ?? tr("[explanation missing]", "[缺少说明]")}` }
									: {}),
							})),
						};
					case "removed_phase":
						return {
							id: `p${p}`,
							title: phase.name,
							collapsed: false,
							items: [{ id: `p${p}.0`, text: tr("Phase removed", "阶段已删除"), status: "dropped" as const }],
						};
					case "removed_tasks":
						return {
							id: `p${p}`,
							title: tr("Removed", "已删除"),
							collapsed: false,
							items: phase.titles.map((title, t) => ({
								id: `p${p}.${t}`,
								text: compactRemovedLabel(title),
								status: "dropped" as const,
							})),
						};
					default: {
						const unreachable: never = phase;
						throw new Error(`Unexpected delta phase: ${String(unreachable)}`);
					}
				}
			});
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
		collapsed: !expanded && phase.items.every(isClosed),
		items: phase.items.map((item, t) => ({
			id: `p${p}.${t}`,
			text: compactTodoLabel(item),
			status: checklistStatus(item.status),
			...(expanded
				? {
						note: `${tr("Explanation", "说明")}: ${item.explanation ?? tr("[explanation missing]", "[缺少说明]")}${item.commit === undefined ? "" : `\n${tr("Commit", "提交")}: ${commitRecordText(item.commit)}`}`,
					}
				: {}),
		})),
	}));
	return [goal, node("checklist", { role: "todo-more.list", mode: "full", phases: checklistPhases }, undefined, "list")];
}
