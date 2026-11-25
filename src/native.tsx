/** @jsxImportSource @oh-my-pi/pi-tui */
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ToolRenderResultOptions } from "@oh-my-pi/pi-coding-agent";
import { isClosedTodo } from "@oh-my-pi/pi-coding-agent/tools/details/todo";
import type { JSXNode } from "@oh-my-pi/pi-tui";
import { tr } from "../omomp-shared/i18n.ts";
import { previewTodoArgs } from "./protocol.ts";
import { callPreviewLines, compactTodoLabel, detailsSchema, type ReadTodoDetails, resultView } from "./render.ts";
import { commitRecordText, type SnapshotItem, type TodoNgSnapshot, type TodoStatus } from "./state.ts";

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

function explanationNote(item: SnapshotItem): string {
	return `${tr("Explanation", "说明")}: ${item.explanation ?? tr("[explanation missing]", "[缺少说明]")}`;
}

function fullNote(item: SnapshotItem): string {
	return `${explanationNote(item)}${item.commit === null ? "" : `\n${tr("Commit", "提交")}: ${commitRecordText(item.commit)}`}`;
}

function snapshotPhases(snapshot: TodoNgSnapshot) {
	return snapshot.phases.map((phase) => ({
		id: phase.name,
		title: phase.name,
		collapsed: false,
		items: phase.items.map((item) => ({
			id: item.id,
			text: item.title,
			status: checklistStatus(item.status),
			note: `${uiTimeEstimate(item)}\n${fullNote(item)}`,
		})),
	}));
}

function GoalKv({ goal }: { goal: TodoNgSnapshot["goal"] }): JSXNode {
	const missing = tr("[goal missing]", "[缺少目标]");
	return (
		<kv
			key="goal"
			role="todo-ng.goal"
			items={[
				{ k: tr("Objective", "目标"), v: goal?.objective ?? missing },
				{ k: tr("Measure", "衡量方式"), v: goal?.measure ?? missing },
				{ k: tr("Done when", "完成条件"), v: goal?.doneWhen ?? missing },
			]}
		/>
	);
}

export function explainAction(id: string): string {
	return `todo-ng.explain:${id}`;
}

export function describeSnapshot(snapshot: TodoNgSnapshot, editable = false, selectedId?: string): JSXNode[] {
	const body: JSXNode[] = [
		<GoalKv goal={snapshot.goal} />,
		<checklist key="list" role="todo-ng.list" mode="full" phases={snapshotPhases(snapshot)} />,
	];
	if (snapshot.phases.every((phase) => phase.items.length === 0)) body.push(<text text={tr("Todo list is empty.", "待办列表为空。")} />);
	if (editable) {
		for (const phase of snapshot.phases) {
			for (const item of phase.items) {
				const label = `${tr("Edit explanation", "编辑说明")}: ${item.title}`;
				body.push(
					<row
						key={explainAction(item.id)}
						role="omp.btn"
						actions={{ click: explainAction(item.id) }}
						title={label}
						tone={selectedId === item.id ? "accent" : undefined}
					>
						<text text={label} />
					</row>,
				);
			}
		}
	}
	return body;
}

export const HUD_OPEN_ACTION = "todo-ng.open";

export type HudHandlers = {
	readonly onToggle: (collapsed: boolean) => void;
	readonly onOpen: () => void;
};

const NO_HUD_HANDLERS: HudHandlers = { onToggle: () => {}, onOpen: () => {} };

export function describeTodoHud(snapshot: TodoNgSnapshot, expanded = false, handlers: HudHandlers = NO_HUD_HANDLERS): JSXNode {
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
	return (
		<row
			key="todo-ng.hud"
			role="omp.hud.activity"
			aria={tr("Todo NG progress", "Todo NG 进度")}
			align="center"
			gap="sm"
			onAction={(act) => {
				if (act === HUD_OPEN_ACTION) handlers.onOpen();
			}}
		>
			<col key="pill" role="omp.hud.todo" aria={tr("Todo NG pill", "Todo NG 待办条")} gap="none">
				<card
					key="control"
					aria={tr("Todo NG disclosure", "Todo NG 展开项")}
					head={`${label} ${closed}/${total}`}
					variant="bare"
					collapsible={true}
					collapsed={!expanded}
					onToggle={(collapsed) => handlers.onToggle(collapsed)}
				>
					<checklist key="visual" role="todo-ng.visual" mode="hud" phases={snapshotPhases(snapshot)} />
				</card>
				{expanded ? (
					<col key="popover" role="todo-ng.popover" aria={tr("Todo NG popover", "Todo NG 弹出面板")}>
						<col key="details" role="todo-ng.details" gap="sm">
							{describeSnapshot(snapshot)}
							<row key="edit" role="omp.btn" actions={{ click: HUD_OPEN_ACTION }}>
								<text text={tr("Edit goal / explanations", "编辑目标/说明")} />
							</row>
						</col>
					</col>
				) : undefined}
			</col>
		</row>
	);
}

export function renderTodoCall(args: unknown): JSXNode {
	return (
		<col role="todo-ng.preview" gap="sm">
			{callPreviewLines(previewTodoArgs(args)).map((text, index) => (
				<text key={`line-${index}`} text={text} wrap="word" />
			))}
		</col>
	);
}

export function renderTodoResult(result: AgentToolResult<unknown>, options: Pick<ToolRenderResultOptions, "expanded">): JSXNode {
	const parsed = detailsSchema.safeParse(result.details);
	if (result.isError || !parsed.success) {
		const text = result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
		return (
			<text
				role="todo-ng.error"
				tone="error"
				text={text || (result.isError ? tr("Todo operation failed", "待办操作失败") : tr("Invalid todo-ng result details", "Todo NG 结果详情无效"))}
				wrap="word"
			/>
		);
	}
	return (
		<col role="todo-ng.panel" gap="sm">
			{resultPanel(parsed.data, options.expanded)}
		</col>
	);
}

function resultPanel(details: ReadTodoDetails, expanded: boolean): JSXNode[] {
	const { more } = details;
	const phases = more.phases.filter((phase) => phase.items.length > 0);
	if (phases.length === 0) return [<text key="empty" text={tr("Todo list is empty.", "待办列表为空。")} wrap="word" />];
	const view = resultView(details, expanded);
	if (view.kind === "delta") {
		const children: JSXNode[] = [];
		if (view.goalChanged) children.push(<GoalKv goal={more.goal} />);
		if (view.phases.length > 0) {
			const deltaPhases = view.phases.map((phase, p) => ({
				id: `p${p}`,
				title: phase.name,
				collapsed: false,
				items: phase.items.map((item, t) => ({
					id: `p${p}.${t}`,
					text: compactTodoLabel(item),
					status: checklistStatus(item.status),
					note: view.explained.has(item.id) ? explanationNote(item) : undefined,
				})),
			}));
			children.push(<checklist key="list" role="todo-ng.list" mode="full" phases={deltaPhases} />);
		}
		return children;
	}
	const goal = expanded ? (
		<GoalKv goal={more.goal} />
	) : (
		<text
			key="goal"
			text={`${tr("Objective", "目标")}: ${more.goal?.objective ?? tr("[goal missing]", "[缺少目标]")}`}
			wrap="word"
		/>
	);
	const fullPhases = phases.map((phase, p) => ({
		id: `p${p}`,
		title: phase.name,
		collapsed: !expanded && phase.items.every(isClosedTodo),
		items: phase.items.map((item, t) => ({
			id: `p${p}.${t}`,
			text: compactTodoLabel(item),
			status: checklistStatus(item.status),
			note: expanded ? fullNote(item) : undefined,
		})),
	}));
	return [goal, <checklist key="list" role="todo-ng.list" mode="full" phases={fullPhases} />];
}
