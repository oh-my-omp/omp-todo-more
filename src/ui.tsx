/** @jsxImportSource @oh-my-pi/pi-tui */
import type { AgentSession, ExtensionAPI, ExtensionContext, HtmlFormData, HtmlFormValue } from "@oh-my-pi/pi-coding-agent";
import { type Accessor, computed, type JSXNode, signal, type Signal } from "@oh-my-pi/pi-tui";
import { tr } from "../omomp-shared/i18n.ts";
import { type HostListSession, liveState } from "./commit.ts";
import { saveTodoEdit, type TodoEditResult } from "./edit.ts";
import { errorText } from "./errors.ts";
import { describeSnapshot, describeTodoHud, explainAction, type HudHandlers } from "./native.tsx";
import { sessionOf } from "./session.ts";
import { type TodoGoal, type TodoNgSnapshot, toSnapshot } from "./state.ts";

const HUD_WIDGET_KEY = "todo-ng.hud";
const GOAL_FIELDS = ["objective", "measure", "doneWhen"] as const;
const EXPLANATION_FIELD = "explanation";
const PANEL_GOAL_ACT = "todo-ng.goal";
const PANEL_CLOSE_ACT = "close";
const EXPLAIN_PREFIX = explainAction("");

type GoalField = (typeof GOAL_FIELDS)[number];

function goalFieldLabel(field: GoalField): string {
	switch (field) {
		case "objective":
			return tr("Objective", "目标");
		case "measure":
			return tr("Measure", "衡量方式");
		case "doneWhen":
			return tr("Done when", "完成条件");
		default: {
			const unreachable: never = field;
			throw new Error(`Unexpected goal field: ${String(unreachable)}`);
		}
	}
}

function escapeHtml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function formText(data: HtmlFormData, name: string): string | undefined {
	const value: HtmlFormValue | undefined = data[name];
	if (value === undefined) return undefined;
	return Array.isArray(value) ? value.join("\n") : String(value);
}

export function goalFormHtml(goal: TodoGoal | undefined): string {
	const fields = GOAL_FIELDS.map(
		(field) =>
			`<label>${escapeHtml(goalFieldLabel(field))}<textarea name="${field}" rows="3">${escapeHtml(goal?.[field] ?? "")}</textarea></label>`,
	);
	return `<form><fieldset><legend>${escapeHtml(tr("Edit goal", "编辑目标"))}</legend>${fields.join("")}</fieldset></form>`;
}

export function explainFormHtml(title: string, explanation: string | undefined): string {
	const label = escapeHtml(`${tr("Explanation", "说明")}: ${title}`);
	return `<form><fieldset><legend>${escapeHtml(tr("Edit explanation", "编辑说明"))}</legend><label>${label}<textarea name="${EXPLANATION_FIELD}" rows="4">${escapeHtml(explanation ?? "")}</textarea></label></fieldset></form>`;
}

export function goalFromForm(data: HtmlFormData): TodoGoal | undefined {
	const objective = formText(data, "objective");
	const measure = formText(data, "measure");
	const doneWhen = formText(data, "doneWhen");
	if (objective === undefined || measure === undefined || doneWhen === undefined) return undefined;
	return { objective, measure, doneWhen };
}

export function explanationFromForm(data: HtmlFormData): string | undefined {
	return formText(data, EXPLANATION_FIELD);
}

export type EditOutcome = { readonly kind: "saved" } | { readonly kind: "rejected"; readonly message: string } | { readonly kind: "cancelled" };

function outcomeOf(result: TodoEditResult): EditOutcome {
	switch (result.kind) {
		case "saved":
			return { kind: "saved" };
		case "rejected":
			return { kind: "rejected", message: result.message };
		default: {
			const unreachable: never = result;
			throw new Error(`Unexpected todo edit result: ${String(unreachable)}`);
		}
	}
}

export function applyGoalForm(session: HostListSession, data: HtmlFormData): EditOutcome {
	const goal = goalFromForm(data);
	if (goal === undefined) return { kind: "cancelled" };
	return outcomeOf(saveTodoEdit(session, { kind: "set_goal", goal }));
}

export function applyExplainForm(session: HostListSession, id: string, data: HtmlFormData): EditOutcome {
	const explanation = explanationFromForm(data);
	if (explanation === undefined) return { kind: "cancelled" };
	return outcomeOf(saveTodoEdit(session, { kind: "explain", id, explanation }));
}

export type PanelChoice = { readonly kind: "close" } | { readonly kind: "goal" } | { readonly kind: "explain"; readonly id: string };

export type PanelCommand = "next" | "previous" | "activate" | "cancel";

export function panelKeyCommand(id: string): PanelCommand | undefined {
	switch (id) {
		case "tab":
		case "down":
			return "next";
		case "shift+tab":
		case "up":
			return "previous";
		case "enter":
			return "activate";
		case "escape":
			return "cancel";
		default:
			return undefined;
	}
}

export function itemIds(snapshot: TodoNgSnapshot): readonly string[] {
	return snapshot.phases.flatMap((phase) => phase.items.map((item) => item.id));
}

export function panelSize(snapshot: TodoNgSnapshot): number {
	return itemIds(snapshot).length + 2;
}

function normalizeSelection(size: number, selected: number): number {
	if (size <= 0) return 0;
	return Math.min(Math.max(selected, 0), size - 1);
}

export function stepSelection(size: number, selected: number, step: -1 | 1): number {
	if (size <= 0) return 0;
	return (normalizeSelection(size, selected) + step + size) % size;
}

export function selectionChoice(snapshot: TodoNgSnapshot, selected: number): PanelChoice {
	const index = normalizeSelection(panelSize(snapshot), selected);
	if (index === 0) return { kind: "goal" };
	const id = itemIds(snapshot)[index - 1];
	return id === undefined ? { kind: "close" } : { kind: "explain", id };
}

export function panelView(session: HostListSession, start: number, done: (choice: PanelChoice) => void): JSXNode {
	const selected: Signal<number> = signal(start);
	const snapshot = (): TodoNgSnapshot => toSnapshot(liveState(session));
	const current = (): number => normalizeSelection(panelSize(snapshot()), selected());

	const move = (step: -1 | 1): void => {
		selected.set(stepSelection(panelSize(snapshot()), selected.peek(), step));
	};
	const accent = (chosen: () => boolean) => () => (chosen() ? "accent" : undefined);

	return (
		<card
			role="todo-ng.panel"
			head={tr("Todo NG", "Todo NG")}
			onKey={(key) => {
				const command = panelKeyCommand(key.id);
				switch (command) {
					case undefined:
						return false;
					case "next":
						move(1);
						return true;
					case "previous":
						move(-1);
						return true;
					case "activate":
						done(selectionChoice(snapshot(), selected.peek()));
						return true;
					case "cancel":
						done({ kind: "close" });
						return true;
					default: {
						const unreachable: never = command;
						throw new Error(`Unexpected panel command: ${String(unreachable)}`);
					}
				}
			}}
			onAction={(act) => {
				if (act === PANEL_GOAL_ACT) {
					done({ kind: "goal" });
					return;
				}
				if (act === PANEL_CLOSE_ACT) {
					done({ kind: "close" });
					return;
				}
				if (!act.startsWith(EXPLAIN_PREFIX)) return;
				const id = act.slice(EXPLAIN_PREFIX.length);
				if (itemIds(snapshot()).includes(id)) done({ kind: "explain", id });
			}}
		>
			<row role="omp.btn" actions={{ click: PANEL_GOAL_ACT }} tone={accent(() => current() === 0)}>
				<text text={tr("Edit goal", "编辑目标")} />
			</row>
			{() => describeSnapshot(snapshot(), true, itemIds(snapshot())[current() - 1])}
			<text text={tr("Tab / arrows select · Enter edit · Escape close", "Tab / 方向键选择 · Enter 编辑 · Escape 关闭")} wrap="word" />
			<row role="omp.btn" actions={{ click: PANEL_CLOSE_ACT }} tone={accent(() => current() === panelSize(snapshot()) - 1)}>
				<text text={tr("Close", "关闭")} />
			</row>
		</card>
	);
}

const NO_HUD_HANDLERS: HudHandlers = { onToggle: () => {}, onOpen: () => {} };

export function hudNode(
	snapshot: TodoNgSnapshot | undefined,
	expanded: boolean,
	handlers: HudHandlers = NO_HUD_HANDLERS,
): JSXNode {
	const hud = snapshot === undefined ? null : describeTodoHud(snapshot, expanded, handlers);
	return hud ?? <row role="omp.hud.activity" aria={tr("Todo NG progress", "Todo NG 进度")} hidden={true} />;
}

export type HudController = {
	readonly node: Accessor<JSXNode>;
	readonly expanded: Signal<boolean>;
	readonly handlers: HudHandlers;
	refresh(): void;
};

export function hudController(snapshotOf: () => TodoNgSnapshot | undefined, open: () => void): HudController {
	const revision = signal(0);
	const expanded = signal(false);
	let cached: { readonly snapshot: TodoNgSnapshot | undefined; readonly expanded: boolean; readonly node: JSXNode } | undefined;
	const handlers: HudHandlers = {
		onToggle: (collapsed) => expanded.set(!collapsed),
		onOpen: () => {
			expanded.set(false);
			open();
		},
	};
	const node = computed<JSXNode>(() => {
		revision();
		const wantExpanded = expanded();
		const snapshot = snapshotOf();
		if (cached !== undefined && cached.expanded === wantExpanded && Bun.deepEquals(cached.snapshot, snapshot)) return cached.node;
		const next = hudNode(snapshot, wantExpanded, handlers);
		cached = { snapshot, expanded: wantExpanded, node: next };
		return next;
	});
	return { node, expanded, handlers, refresh: () => revision.update((value) => value + 1) };
}

export function registerUi(pi: ExtensionAPI): void {
	let active: AbortController | undefined;
	let hud: HudController | undefined;

	const cancel = (): void => {
		active?.abort();
		active = undefined;
	};

	const snapshotOf = (session: AgentSession): TodoNgSnapshot | undefined => {
		try {
			return toSnapshot(liveState(session));
		} catch (error) {
			pi.logger.warn("todo-ng HUD could not read the current branch", { error: errorText(error) });
			return undefined;
		}
	};

	const readGoalForm = async (ctx: ExtensionContext, abort: AbortSignal, goal: TodoGoal | undefined): Promise<HtmlFormData | undefined> => {
		const dialog = ctx.ui.formDialog;
		if (dialog !== undefined) {
			const result = await dialog.call(ctx.ui, goalFormHtml(goal), { signal: abort });
			return result?.data;
		}
		const data: HtmlFormData = {};
		for (const field of GOAL_FIELDS) {
			const text = await ctx.ui.editor(goalFieldLabel(field), goal?.[field] ?? "", { signal: abort });
			if (text === undefined) return undefined;
			data[field] = text;
		}
		return data;
	};

	const readExplainForm = async (
		ctx: ExtensionContext,
		abort: AbortSignal,
		title: string,
		explanation: string | undefined,
	): Promise<HtmlFormData | undefined> => {
		const dialog = ctx.ui.formDialog;
		if (dialog !== undefined) {
			const result = await dialog.call(ctx.ui, explainFormHtml(title, explanation), { signal: abort });
			return result?.data;
		}
		const text = await ctx.ui.editor(`${tr("Explanation", "说明")}: ${title}`, explanation ?? "", { signal: abort });
		if (text === undefined) return undefined;
		return { [EXPLANATION_FIELD]: text };
	};

	const report = (ctx: ExtensionContext, outcome: EditOutcome): void => {
		switch (outcome.kind) {
			case "saved":
			case "cancelled":
				return;
			case "rejected":
				ctx.ui.notify(outcome.message, "error");
				return;
			default: {
				const unreachable: never = outcome;
				throw new Error(`Unexpected edit outcome: ${String(unreachable)}`);
			}
		}
	};

	const editGoal = async (ctx: ExtensionContext, session: AgentSession, abort: AbortSignal): Promise<void> => {
		const data = await readGoalForm(ctx, abort, toSnapshot(liveState(session)).goal ?? undefined);
		if (data === undefined) return;
		if (sessionOf(ctx.agent.id) !== session) return;
		report(ctx, applyGoalForm(session, data));
	};

	const editExplanation = async (
		ctx: ExtensionContext,
		session: AgentSession,
		abort: AbortSignal,
		id: string,
	): Promise<void> => {
		const snapshot = toSnapshot(liveState(session));
		const item = snapshot.phases.flatMap((phase) => phase.items).find((candidate) => candidate.id === id);
		if (item === undefined) return;
		const data = await readExplainForm(ctx, abort, item.title, item.explanation ?? undefined);
		if (data === undefined) return;
		if (sessionOf(ctx.agent.id) !== session) return;
		report(ctx, applyExplainForm(session, id, data));
	};

	const runPanel = async (ctx: ExtensionContext, session: AgentSession, controller: AbortController): Promise<void> => {
		let start = 0;
		for (;;) {
			const choice = await ctx.ui.custom<PanelChoice>(
				(_ui, _theme, _keys, done) => panelView(session, start, done),
				{ overlay: true, signal: controller.signal },
			);
			switch (choice.kind) {
				case "close":
					return;
				case "goal":
					start = 0;
					await editGoal(ctx, session, controller.signal);
					break;
				case "explain": {
					const index = itemIds(toSnapshot(liveState(session))).indexOf(choice.id);
					start = index < 0 ? 0 : index + 1;
					await editExplanation(ctx, session, controller.signal, choice.id);
					break;
				}
				default: {
					const unreachable: never = choice;
					throw new Error(`Unexpected panel choice: ${String(unreachable)}`);
				}
			}
			if (controller.signal.aborted) return;
			if (sessionOf(ctx.agent.id) !== session) return;
		}
	};

	const open = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI) {
			pi.sendMessage({
				customType: "todo-ng.ui-unavailable",
				content: "Todo NG editor requires an interactive UI.",
				display: true,
				attribution: "agent",
			});
			return;
		}
		const session = sessionOf(ctx.agent.id);
		if (session === undefined || active !== undefined) return;
		const controller = new AbortController();
		active = controller;
		try {
			await runPanel(ctx, session, controller);
		} catch (error) {
			if (!controller.signal.aborted) {
				pi.logger.warn("todo-ng UI failed", { error: errorText(error) });
				ctx.ui.notify(`${tr("Todo NG UI failed", "Todo NG 界面失败")}: ${errorText(error)}`, "error");
			}
		} finally {
			if (active === controller) active = undefined;
		}
	};

	const installHud = (ctx: ExtensionContext): void => {
		hud = undefined;
		if (!ctx.hasUI) return;
		const session = sessionOf(ctx.agent.id);
		if (session === undefined) {
			ctx.ui.setWidget(HUD_WIDGET_KEY, undefined);
			return;
		}
		const controller = hudController(() => snapshotOf(session), () => void open(ctx));
		hud = controller;
		ctx.ui.setWidget(HUD_WIDGET_KEY, () => controller.node, { placement: "aboveEditor" });
	};

	pi.on("session_start", (_event, ctx) => installHud(ctx));
	const reinstall = (_event: unknown, ctx: ExtensionContext): void => {
		cancel();
		installHud(ctx);
	};
	pi.on("session_switch", reinstall);
	pi.on("session_branch", reinstall);
	pi.on("session_tree", reinstall);
	pi.on("session_shutdown", (_event, ctx) => {
		cancel();
		hud = undefined;
		if (ctx.hasUI) ctx.ui.setWidget(HUD_WIDGET_KEY, undefined);
	});
	const repaint = (): void => hud?.refresh();
	pi.on("tool_execution_end", repaint);
	pi.on("tool_result", repaint);
	pi.on("message_end", repaint);
	pi.on("turn_end", repaint);
	pi.on("agent_end", repaint);
	pi.on("session_compact", repaint);
	pi.registerCommand("todo-ng", {
		description: tr("Show rich todos and edit the current session's goal and explanations", "显示丰富待办并编辑当前会话的目标和说明"),
		handler: async (_args: string, ctx: ExtensionContext) => open(ctx),
	});
}
