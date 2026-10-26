import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	type Component,
	Container,
	col,
	Editor,
	FormField,
	getEditorTheme,
	matchesKey,
	type NativeChild,
	type NativeNode,
	type NativeUiEvent,
	node,
	span,
	Text,
	type Theme,
	type TUI,
} from "@oh-my-pi/pi-tui";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { saveTodoEdit, type TodoEdit } from "./edit.ts";
import { errorText } from "./errors.ts";
import { tr } from "./i18n.ts";
import { describeSnapshot, describeTodoHud } from "./native.ts";
import { type ItemTime, readTodoMore, type TodoGoal, type TodoStatus, toSnapshot } from "./state.ts";

const FIELDS = ["objective", "measure", "doneWhen"] as const;
type GoalField = (typeof FIELDS)[number];

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

function uiGoalLines(goal: TodoGoal): string[] {
	return [
		`${tr("Objective", "目标")}: ${goal.objective}`,
		`${tr("Measure", "衡量方式")}: ${goal.measure}`,
		`${tr("Done when", "完成条件")}: ${goal.doneWhen}`,
	];
}

function uiTimeEstimate(time: ItemTime): string {
	return time.kind === "estimated"
		? `${tr("Estimate", "预计")}: ${time.minutes} ${tr("min", "分钟")}`
		: tr("(no time estimate yet: add one with ESTIMATE)", "（尚无时间估计：请使用 ESTIMATE 添加）");
}

function uiStatus(status: TodoStatus): string {
	switch (status) {
		case "pending":
			return tr("pending", "待处理");
		case "in_progress":
			return tr("in progress", "进行中");
		case "completed":
			return tr("completed", "已完成");
		case "abandoned":
			return tr("abandoned", "已放弃");
		case "blocked":
			return tr("blocked", "已阻塞");
		default: {
			const unreachable: never = status;
			throw new Error(`Unexpected todo status: ${String(unreachable)}`);
		}
	}
}

function editErrorText(message: string): string {
	if (message === "Authority branch did not accept the todo snapshot.")
		return tr("Authority branch did not accept the Todo snapshot.", "权威分支未接受 Todo 快照。");
	if (message.startsWith("Todo branch snapshot was not accepted: "))
		return `${tr("Todo branch snapshot was not accepted", "Todo 分支快照未被接受")}${message.slice("Todo branch snapshot was not accepted".length)}`;
	if (message.startsWith("Todo branch state accepted, but host projection failed: "))
		return `${tr("Todo branch state accepted, but host projection failed", "Todo 分支状态已接受，但宿主投影失败")}${message.slice("Todo branch state accepted, but host projection failed".length)}`;
	return message;
}
type DraftField = { editor: Editor; field: FormField };
type Mode =
	| { kind: "panel"; selected: number }
	| { kind: "goal"; fields: Record<GoalField, DraftField>; active: GoalField }
	| { kind: "explanation"; title: string; draft: DraftField };

/** One overlay owns its drafts; neither a historical tool card nor the opening snapshot can be saved. */
class TodoPanel implements Component {
	private mode: Mode = { kind: "panel", selected: 0 };
	private error: string | undefined;
	private described: NativeNode | undefined;
	private leaf: string | undefined;
	private disposed = false;
	focused = true;
	readonly nativeOverlay = { role: "todo-more.panel", size: "lg" as const, anchor: "center" as const };

	constructor(
		private readonly session: AgentSession,
		private readonly theme: Theme,
		private readonly requestRender: () => void,
		private readonly done: () => void,
		private readonly signal: AbortSignal,
		private readonly isCurrentSession: () => boolean,
	) {}

	private changed(): void {
		this.described = undefined;
		this.requestRender();
	}

	private makeField(label: string, text: string): DraftField {
		const editor = new Editor(getEditorTheme());
		editor.disableSubmit = true;
		editor.setText(text);
		editor.setMaxHeight(6);
		editor.onChange = () => this.changed();
		const field = new FormField(editor, {
			label,
			theme: {
				label: (value) => this.theme.bold(value),
				description: (value) => this.theme.fg("muted", value),
				error: (value) => this.theme.fg("error", value),
				hint: (value) => this.theme.fg("muted", value),
			},
		});
		return { editor, field };
	}

	private discardDraft(): void {
		switch (this.mode.kind) {
			case "panel":
				break;
			case "goal":
				for (const name of FIELDS) this.mode.fields[name].field.dispose();
				break;
			case "explanation":
				this.mode.draft.field.dispose();
				break;
			default: {
				const unreachable: never = this.mode;
				throw new Error(String(unreachable));
			}
		}
	}

	private openGoal(): void {
		const state = readTodoMore(this.session.sessionManager.getBranch());
		if (state.kind === "empty") {
			this.error = tr("Todo list is empty.", "待办列表为空。");
			this.changed();
			return;
		}
		const goal = state.goal.kind === "set" ? state.goal.goal : { objective: "", measure: "", doneWhen: "" };
		this.discardDraft();
		this.mode = {
			kind: "goal",
			active: "objective",
			fields: {
				objective: this.makeField(goalFieldLabel("objective"), goal.objective),
				measure: this.makeField(goalFieldLabel("measure"), goal.measure),
				doneWhen: this.makeField(goalFieldLabel("doneWhen"), goal.doneWhen),
			},
		};
		this.error = undefined;
		this.changed();
	}

	private openExplanation(title: string): void {
		const state = readTodoMore(this.session.sessionManager.getBranch());
		if (state.kind === "empty") {
			this.error = tr("Todo list is empty.", "待办列表为空。");
			this.changed();
			return;
		}
		const item = state.phases.flatMap((phase) => phase.items).find((candidate) => candidate.title === title);
		if (!item) {
			this.error = `${tr("Task", "任务")} "${title}" ${tr("not found", "未找到")}`;
			this.changed();
			return;
		}
		this.discardDraft();
		this.mode = {
			kind: "explanation",
			title,
			draft: this.makeField(`${tr("Explanation", "说明")}: ${title}`, item.explanation.kind === "explained" ? item.explanation.text : ""),
		};
		this.error = undefined;
		this.changed();
	}

	private close(): void {
		if (this.mode.kind === "panel") this.done();
		else {
			this.discardDraft();
			this.mode = { kind: "panel", selected: 0 };
			this.error = undefined;
			this.changed();
		}
	}

	private save(): void {
		if (this.disposed || this.signal.aborted) return;
		if (!this.isCurrentSession()) {
			this.done();
			return;
		}
		let edit: TodoEdit;
		switch (this.mode.kind) {
			case "panel":
				return;
			case "goal":
				edit = {
					kind: "set_goal",
					goal: {
						objective: this.mode.fields.objective.editor.getExpandedText(),
						measure: this.mode.fields.measure.editor.getExpandedText(),
						doneWhen: this.mode.fields.doneWhen.editor.getExpandedText(),
					},
				};
				break;
			case "explanation":
				edit = { kind: "explain", title: this.mode.title, explanation: this.mode.draft.editor.getExpandedText() };
				break;
			default: {
				const unreachable: never = this.mode;
				throw new Error(String(unreachable));
			}
		}
		const result = saveTodoEdit(this.session, edit);
		switch (result.kind) {
			case "saved":
				this.discardDraft();
				this.mode = { kind: "panel", selected: 0 };
				this.error = undefined;
				break;
			case "failed":
			case "rejected":
				this.error = editErrorText(result.message);
				break;
			default: {
				const unreachable: never = result;
				throw new Error(String(unreachable));
			}
		}
		this.changed();
	}

	describe(): NativeNode {
		const branch = this.session.sessionManager.getBranch();
		if (this.leaf !== branch.at(-1)?.id) {
			this.leaf = branch.at(-1)?.id;
			this.described = undefined;
		}
		if (this.described) return this.described;
		const body: NativeChild[] = [];
		let role: string;
		let head: string;
		let actions: NativeNode[];
		switch (this.mode.kind) {
			case "panel": {
				role = "todo-more.panel";
				head = tr("Todo More", "Todo More");
				const snapshot = toSnapshot(readTodoMore(branch));
				let count = 0;
				let selectedTitle: string | undefined;
				for (const phase of snapshot.phases)
					for (const item of phase.items) {
						if (++count === this.mode.selected) selectedTitle = item.title;
					}
				this.mode.selected = Math.min(this.mode.selected, count + 1);
				body.push(
					this.button(tr("Edit goal", "编辑目标"), "todo-more.goal", this.mode.selected === 0),
					...describeSnapshot(snapshot, true, selectedTitle),
				);
				actions = [this.button(tr("Close", "关闭"), "close", this.mode.selected === count + 1)];
				break;
			}
			case "goal": {
				role = "todo-more.goal-editor";
				head = tr("Edit goal", "编辑目标");
				actions = [this.button(tr("Save", "保存"), "todo-more.save"), this.button(tr("Cancel", "取消"), "close")];
				for (const name of FIELDS) {
					const draft = this.mode.fields[name];
					draft.field.focused = this.focused && name === this.mode.active;
					body.push(
						name === this.mode.active
							? draft.field
							: node(
									"col",
									{ gap: "xs", actions: { click: `todo-more.field.${name}` } },
									[
										node("text", { spans: [span(goalFieldLabel(name), "strong")] }),
										node("text", { text: draft.editor.getExpandedText() || tr("[empty]", "[空]"), wrap: "word" }),
									],
									name,
								),
					);
				}
				break;
			}
			case "explanation":
				role = "todo-more.explanation-editor";
				head = `${tr("Edit explanation", "编辑说明")}: ${this.mode.title}`;
				this.mode.draft.field.focused = this.focused;
				body.push(this.mode.draft.field);
				actions = [this.button(tr("Save", "保存"), "todo-more.save"), this.button(tr("Cancel", "取消"), "close")];
				break;
			default: {
				const unreachable: never = this.mode;
				throw new Error(String(unreachable));
			}
		}
		if (this.error) body.push(node("text", { spans: [span(this.error, "error")], wrap: "word" }, undefined, "error"));
		body.push(
			node("text", {
				text:
					this.mode.kind === "panel"
						? tr("Tab / arrows select · Enter edit · Escape close", "Tab / 方向键选择 · Enter 编辑 · Escape 关闭")
						: tr(
								"Enter newline · Tab / Shift+Tab field · Ctrl+Enter save · Escape cancel",
								"Enter 换行 · Tab / Shift+Tab 切换字段 · Ctrl+Enter 保存 · Escape 取消",
							),
				wrap: "word",
			}),
		);
		body.push(col(actions, { gap: "xs" }));
		this.described = node("card", { role, head }, body);
		return this.described;
	}

	private button(label: string, act: string, selected = false): NativeNode {
		return node(
			"row",
			{ role: "omp.btn", actions: { click: act }, title: label, tone: selected ? "accent" : undefined },
			[node("text", { text: label })],
			act,
		);
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (this.disposed || this.signal.aborted || event.type !== "action") return;
		if (event.act === "todo-more.save") this.save();
		else if (event.act === "close") this.close();
		else if (event.act === "todo-more.goal") this.openGoal();
		else if (event.act.startsWith("todo-more.explain:")) this.openExplanation(event.act.slice("todo-more.explain:".length));
		else if (this.mode.kind === "goal") {
			const name = FIELDS.find((field) => event.act === `todo-more.field.${field}`);
			if (name) {
				this.mode.active = name;
				this.changed();
			}
		}
	}

	handleInput(data: string): void {
		if (this.disposed || this.signal.aborted) return;
		if (matchesKey(data, "escape")) {
			this.close();
			return;
		}
		if (matchesKey(data, "ctrl+enter")) {
			this.save();
			return;
		}
		if (this.mode.kind === "panel") {
			const state = readTodoMore(this.session.sessionManager.getBranch());
			const titles = state.kind === "list" ? state.phases.flatMap((phase) => phase.items.map((item) => item.title)) : [];
			if (matchesKey(data, "tab") || matchesKey(data, "down")) this.mode.selected = (this.mode.selected + 1) % (titles.length + 2);
			else if (matchesKey(data, "shift+tab") || matchesKey(data, "up"))
				this.mode.selected = (this.mode.selected + titles.length + 1) % (titles.length + 2);
			else if (matchesKey(data, "enter")) {
				if (this.mode.selected === 0) this.openGoal();
				else {
					const title = titles[this.mode.selected - 1];
					if (title === undefined) this.close();
					else this.openExplanation(title);
				}
			}
			this.changed();
			return;
		}
		if (this.mode.kind === "goal" && (matchesKey(data, "tab") || matchesKey(data, "shift+tab"))) {
			const index = FIELDS.indexOf(this.mode.active);
			this.mode.active = FIELDS[(index + (matchesKey(data, "shift+tab") ? 2 : 1)) % 3]!;
			this.changed();
			return;
		}
		const editor = this.mode.kind === "goal" ? this.mode.fields[this.mode.active].editor : this.mode.draft.editor;
		editor.handleInput(matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n" ? "\n" : data);
		this.changed();
	}

	render(width: number): readonly string[] {
		const lines = [
			this.theme.bold(
				this.mode.kind === "panel"
					? tr("Todo More", "Todo More")
					: this.mode.kind === "goal"
						? tr("Edit goal", "编辑目标")
						: `${tr("Edit explanation", "编辑说明")}: ${this.mode.title}`,
			),
		];
		switch (this.mode.kind) {
			case "panel": {
				const state = readTodoMore(this.session.sessionManager.getBranch());
				const labels = [tr("Edit goal", "编辑目标")];
				if (state.kind === "empty") lines.push(tr("Todo list is empty.", "待办列表为空。"));
				else {
					lines.push(...(state.goal.kind === "set" ? uiGoalLines(state.goal.goal) : [tr("Goal: [missing]", "目标：[缺少]")]));
					for (const phase of state.phases) {
						lines.push(phase.name);
						for (const item of phase.items) {
							lines.push(
								`${item.title} [${uiStatus(item.status)}]`,
								uiTimeEstimate(item.time),
								item.explanation.kind === "explained" ? item.explanation.text : tr("[explanation missing]", "[缺少说明]"),
								`${tr("Blocker", "阻塞原因")}: ${item.blocker ?? tr("(none)", "（无）")}`,
							);
							labels.push(`${tr("Edit explanation", "编辑说明")}: ${item.title}`);
						}
					}
				}
				labels.push(tr("Close", "关闭"));
				const selected = this.mode.selected;
				lines.push(...labels.map((label, index) => `${index === selected ? ">" : " "} ${label}`));
				break;
			}
			case "goal":
				for (const name of FIELDS) {
					this.mode.fields[name].field.focused = this.focused && name === this.mode.active;
					lines.push(...this.mode.fields[name].field.render(width));
				}
				break;
			case "explanation":
				this.mode.draft.field.focused = this.focused;
				lines.push(...this.mode.draft.field.render(width));
				break;
			default: {
				const unreachable: never = this.mode;
				throw new Error(String(unreachable));
			}
		}
		if (this.error) lines.push(this.theme.fg("error", this.error));
		lines.push(tr("Ctrl+Enter save · Escape cancel/close · Tab next", "Ctrl+Enter 保存 · Escape 取消/关闭 · Tab 下一个"));
		return new Text(lines.join("\n"), 0, 0).render(width);
	}

	invalidate(): void {
		this.described = undefined;
	}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.discardDraft();
		this.described = undefined;
	}
}

const HUD_WIDGET_KEY = "todo-more.hud";
const NO_ANSI_HUD_ROWS: readonly string[] = [];

/** The mounted prompt owns the host's live viewed-agent lineage, including during overlays. */
function findPromptEditor(component: Component): CustomEditor | undefined {
	if (component instanceof CustomEditor) return component;
	if (component instanceof Container) {
		for (let index = component.children.length - 1; index >= 0; index--) {
			const child = component.children[index];
			if (child === undefined) continue;
			const editor = findPromptEditor(child);
			if (editor !== undefined) return editor;
		}
	}
	return undefined;
}

function viewedSession(tui: TUI, mainAgentId: string): AgentSession | undefined {
	const editor = findPromptEditor(tui);
	if (editor === undefined) return undefined;
	const viewedAgentId = editor.composerState().viewing?.at(-1) ?? mainAgentId;
	return AgentRegistry.global().get(viewedAgentId)?.session ?? undefined;
}
type HudDisclosure = { kind: "closed" } | { kind: "open"; session: AgentSession; stopInput: () => void };

/** Native-only presentation; the branch remains its only Todo state. */
class TodoHud implements Component {
	private disclosure: HudDisclosure = { kind: "closed" };

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly readSession: () => AgentSession | undefined,
		private readonly open: () => Promise<void>,
		private readonly tui: TUI,
		private readonly onDispose: () => void,
	) {}

	describe(): NativeNode | null {
		try {
			const session = this.readSession();
			if (this.disclosure.kind === "open" && this.disclosure.session !== session) this.closeDisclosure();
			const described =
				session === undefined
					? null
					: describeTodoHud(toSnapshot(readTodoMore(session.sessionManager.getBranch())), this.disclosure.kind === "open");
			if (described === null) this.closeDisclosure();
			// Keep our own slot identifiable when empty, without showing a pill.
			return described ?? node("row", { role: "omp.hud.activity", aria: tr("Todo More progress", "Todo More 进度"), hidden: true });
		} catch (error) {
			this.closeDisclosure();
			this.pi.logger.warn("todo-more HUD could not read the current branch", { error: errorText(error) });
			return null;
		}
	}

	render(): readonly string[] {
		return NO_ANSI_HUD_ROWS;
	}

	closeDisclosure(): void {
		if (this.disclosure.kind === "closed") return;
		this.disclosure.stopInput();
		this.disclosure = { kind: "closed" };
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "toggle" && event.key === "pill/control") {
			this.closeDisclosure();
			if (!event.collapsed) {
				const session = this.readSession();
				if (session === undefined) return;
				const stopInput = this.tui.addInputListener((data) => {
					if (this.disclosure.kind === "closed") return;
					if (this.readSession() !== this.disclosure.session) {
						this.closeDisclosure();
						this.tui.requestRender();
						return;
					}
					if (!matchesKey(data, "escape")) return;
					this.closeDisclosure();
					this.tui.requestRender();
					return { consume: true };
				});
				this.disclosure = { kind: "open", session, stopInput };
			}
			this.tui.requestRender();
		} else if (event.type === "action" && event.act === "todo-more.open") {
			void this.open();
		}
	}

	dispose(): void {
		this.closeDisclosure();
		this.onDispose();
	}
}

export function registerUi(pi: ExtensionAPI): void {
	let active: { controller: AbortController; session: AgentSession } | undefined;
	let hudTui: TUI | undefined;
	let hud: TodoHud | undefined;
	const cancel = (): void => {
		active?.controller.abort();
		active = undefined;
	};
	const currentSession = (tui: TUI, mainAgentId: string): AgentSession | undefined => {
		const session = viewedSession(tui, mainAgentId);
		if (active !== undefined && active.session !== session) cancel();
		return session;
	};
	const open = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI) {
			pi.sendMessage({
				customType: "todo-more.ui-unavailable",
				content: "Todo More editor requires an interactive UI.",
				display: true,
				attribution: "agent",
			});
			return;
		}
		hud?.closeDisclosure();
		hudTui?.requestRender();
		const session = hudTui === undefined ? undefined : currentSession(hudTui, ctx.agent.id);
		if (session == null || active) return;
		const opened = { controller: new AbortController(), session };
		active = opened;
		try {
			await ctx.ui.custom<void>(
				(tui, theme, _keys, done) =>
					new TodoPanel(
						session,
						theme,
						() => tui.requestRender(),
						() => done(),
						opened.controller.signal,
						() => currentSession(tui, ctx.agent.id) === session,
					),
				{ overlay: true, signal: opened.controller.signal },
			);
		} catch (error) {
			// Session transitions abort the old overlay and discard its draft normally.
			if (!opened.controller.signal.aborted) {
				pi.logger.warn("todo-more UI failed", { error: errorText(error) });
				ctx.ui.notify(`${tr("Todo More UI failed", "Todo More 界面失败")}: ${errorText(error)}`, "error");
			}
		} finally {
			if (active === opened) active = undefined;
		}
	};
	const installHud = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		const session = AgentRegistry.global().get(ctx.agent.id)?.session;
		hudTui = undefined;
		ctx.ui.setWidget(
			HUD_WIDGET_KEY,
			session == null
				? undefined
				: (tui) => {
						hudTui = tui;
						const widget: TodoHud = new TodoHud(
							pi,
							() => currentSession(tui, ctx.agent.id),
							() => open(ctx),
							tui,
							() => {
								if (hud === widget) {
									hud = undefined;
									hudTui = undefined;
								}
							},
						);
						hud = widget;
						return widget;
					},
			{ placement: "belowEditor" },
		);
	};
	pi.on("session_start", (_event, ctx) => installHud(ctx));
	pi.on("session_switch", (_event, ctx) => {
		cancel();
		installHud(ctx);
	});
	pi.on("session_branch", (_event, ctx) => {
		cancel();
		installHud(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		cancel();
		installHud(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		cancel();
		if (ctx.hasUI) ctx.ui.setWidget(HUD_WIDGET_KEY, undefined);
		hudTui = undefined;
	});
	pi.on("input", (event, ctx) => {
		if (event.source !== "interactive" || !ctx.hasUI || !hudTui?.nativeRendering) return;
		const command = /^\/todo(?:[\s:]+(.*))?$/s.exec(event.text.trim());
		if (command === null) return;
		const args = (command[1] ?? "").trim().toLowerCase();
		if (args === "" || args === "edit") return { text: "/todo-more" };
	});
	pi.registerCommand("todo-more", {
		description: tr("Show rich todos and edit the current session's goal and explanations", "显示丰富待办并编辑当前会话的目标和说明"),
		handler: async (_args: string, ctx: ExtensionContext) => open(ctx),
	});
}
