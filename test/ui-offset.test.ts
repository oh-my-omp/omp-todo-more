import { describe, expect, test } from "bun:test";
import { isUiNode, type JSXNode, type UiNode } from "@oh-my-pi/pi-tui";
import { liveState } from "../src/commit.ts";
import { type SnapshotItem, type TodoNgSnapshot, toSnapshot } from "../src/state.ts";
import {
	applyExplainForm,
	applyGoalForm,
	explainFormHtml,
	goalFormHtml,
	goalFromForm,
	type HudController,
	hudController,
	hudNode,
	itemIds,
	type PanelChoice,
	panelKeyCommand,
	panelSize,
	panelView,
	selectionChoice,
	stepSelection,
} from "../src/ui.tsx";
import { appendTodoChange, fillBranch, fixture, messageEntry } from "./ui-fixture.ts";

const DIR = "/tmp/ui-offset-test";

function tree(value: JSXNode): unknown {
	if (isUiNode(value)) {
		const props: Record<string, unknown> = {};
		for (const [name, prop] of Object.entries(value.props())) props[name] = prop;
		return { kind: value.kind, props, children: value.children().map(tree) };
	}
	if (Array.isArray(value)) return value.map(tree);
	if (typeof value === "function") return tree(value());
	return value ?? null;
}

function drawn(jsx: JSXNode): string {
	return JSON.stringify(tree(jsx));
}

function propsOf(node: UiNode): Record<string, unknown> {
	return Object.fromEntries(Object.entries(node.props()));
}

function clickOf(node: UiNode): string | undefined {
	const actions = propsOf(node).actions;
	if (typeof actions !== "object" || actions === null || !("click" in actions)) return undefined;
	const click = actions.click;
	return typeof click === "string" ? click : undefined;
}

function nodeOf(jsx: JSXNode): UiNode {
	if (!isUiNode(jsx)) throw new Error(`expected one node, received ${typeof jsx}`);
	return jsx;
}

function itemOf(id: string): SnapshotItem {
	return { id, title: `Task ${id}`, explanation: null, status: "pending", estimate: { kind: "missing" }, commit: null };
}

function snapshotOf(...ids: string[]): TodoNgSnapshot {
	return { goal: { objective: "Ship", measure: "Green", doneWhen: "Merged" }, phases: [{ name: "Delivery", items: ids.map(itemOf) }] };
}

function makeHud(name: string, grow = true): HudController {
	const fx = fixture(`${DIR}/${name}-${process.pid}`);
	if (grow) fillBranch(fx.raw, 600);
	return hudController(
		() => toSnapshot(liveState(fx.session)),
		() => {},
	);
}

describe("HUD", () => {
	test("an empty session draws the hidden activity slot", () => {
		const hud = makeHud("hud-empty", false);
		expect(drawn(hud.node())).toContain('"hidden":true');
		expect(hudNode(undefined, false)).toBeTruthy();
	});

	test("a todo change reaches the pill after a repaint", () => {
		const fx = fixture(`${DIR}/hud-grow-${process.pid}`);
		fillBranch(fx.raw, 600);
		const hud = hudController(
			() => toSnapshot(liveState(fx.session)),
			() => {},
		);
		expect(drawn(hud.node())).not.toContain("Brand new task");
		appendTodoChange(fx.raw, "Brand new task");
		hud.refresh();
		const after = drawn(hud.node());
		expect(after).toContain("Brand new task");
		expect(after).not.toContain('"hidden":true');
	});

	test("a repaint without a todo change keeps the same node", () => {
		const fx = fixture(`${DIR}/hud-plain-${process.pid}`);
		fillBranch(fx.raw, 600);
		const hud = hudController(
			() => toSnapshot(liveState(fx.session)),
			() => {},
		);
		const first = hud.node();
		messageEntry(fx.raw, 10_001);
		hud.refresh();
		expect(hud.node()).toBe(first);
	});

	test("expansion adds the popover and collapsing removes it", () => {
		const hud = makeHud("hud-expand");
		expect(drawn(hud.node())).not.toContain("todo-ng.popover");
		hud.handlers.onToggle(false);
		expect(hud.expanded()).toBe(true);
		const expanded = drawn(hud.node());
		expect(expanded).toContain("todo-ng.popover");
		expect(expanded).toContain("todo-ng.open");
		hud.handlers.onToggle(true);
		expect(hud.expanded()).toBe(false);
		expect(drawn(hud.node())).not.toContain("todo-ng.popover");
	});

	test("the popover edit action collapses the pill and opens the panel", () => {
		let opened = 0;
		const hud = hudController(
			() => snapshotOf("t1"),
			() => {
				opened += 1;
			},
		);
		hud.handlers.onToggle(false);
		expect(drawn(hud.node())).toContain("todo-ng.popover");
		hud.handlers.onOpen();
		expect(opened).toBe(1);
		expect(hud.expanded()).toBe(false);
		expect(drawn(hud.node())).not.toContain("todo-ng.popover");
	});
});

describe("panel selection", () => {
	test("key ids map to navigation, activation and cancel", () => {
		expect(panelKeyCommand("tab")).toBe("next");
		expect(panelKeyCommand("down")).toBe("next");
		expect(panelKeyCommand("shift+tab")).toBe("previous");
		expect(panelKeyCommand("up")).toBe("previous");
		expect(panelKeyCommand("enter")).toBe("activate");
		expect(panelKeyCommand("escape")).toBe("cancel");
		expect(panelKeyCommand("ctrl+c")).toBeUndefined();
		expect(panelKeyCommand("a")).toBeUndefined();
	});

	test("selection wraps at both ends", () => {
		expect(stepSelection(4, 3, 1)).toBe(0);
		expect(stepSelection(4, 0, -1)).toBe(3);
		expect(stepSelection(4, 1, 1)).toBe(2);
		expect(stepSelection(4, 1, -1)).toBe(0);
		expect(stepSelection(1, 0, 1)).toBe(0);
	});

	test("goal, items and close are the entries and activation maps to a choice", () => {
		const snapshot = snapshotOf("t1", "t2");
		expect(panelSize(snapshot)).toBe(4);
		expect(selectionChoice(snapshot, 0)).toEqual({ kind: "goal" });
		expect(selectionChoice(snapshot, 1)).toEqual({ kind: "explain", id: "t1" });
		expect(selectionChoice(snapshot, 2)).toEqual({ kind: "explain", id: "t2" });
		expect(selectionChoice(snapshot, 3)).toEqual({ kind: "close" });
		expect(selectionChoice(snapshot, 9)).toEqual({ kind: "close" });
		expect(selectionChoice(snapshot, -5)).toEqual({ kind: "goal" });
		expect(itemIds(snapshot)).toEqual(["t1", "t2"]);
	});

	test("an empty list has only goal and close", () => {
		const snapshot = snapshotOf();
		expect(panelSize(snapshot)).toBe(2);
		expect(selectionChoice(snapshot, 1)).toEqual({ kind: "close" });
	});
});

describe("panel view", () => {
	test("its card lists edit goal, the items, then close", () => {
		const fx = fixture(`${DIR}/panel-view-${process.pid}`);
		fillBranch(fx.raw, 600);
		const ids = itemIds(toSnapshot(liveState(fx.session)));
		const card = nodeOf(panelView(fx.session, 0, () => {}));
		expect(card.kind).toBe("card");
		expect(propsOf(card)).toMatchObject({ role: "todo-ng.panel", head: "Todo NG" });
		const acts = card.children().map(clickOf);
		expect(acts).toContain("todo-ng.goal");
		expect(acts).toContain("close");
		for (const id of ids) expect(acts).toContain(`todo-ng.explain:${id}`);
	});

	test("keys move the selection and activate the entry under it", () => {
		const fx = fixture(`${DIR}/panel-keys-${process.pid}`);
		fillBranch(fx.raw, 600);
		const first = itemIds(toSnapshot(liveState(fx.session)))[0];
		if (first === undefined) throw new Error("fixture has no todo item");
		const choices: PanelChoice[] = [];
		const card = nodeOf(panelView(fx.session, 0, (choice) => choices.push(choice)));
		const key = (id: string) => ({ id, kind: "press" as const, raw: "" });
		expect(card.handlers.onKey?.(key("a"))).toBe(false);
		expect(card.handlers.onKey?.(key("up"))).toBe(true);
		expect(card.handlers.onKey?.(key("enter"))).toBe(true);
		expect(choices).toEqual([{ kind: "close" }]);
		expect(card.handlers.onKey?.(key("down"))).toBe(true);
		expect(card.handlers.onKey?.(key("down"))).toBe(true);
		expect(card.handlers.onKey?.(key("enter"))).toBe(true);
		expect(choices.at(-1)).toEqual({ kind: "explain", id: first });
		expect(card.handlers.onKey?.(key("escape"))).toBe(true);
		expect(choices.at(-1)).toEqual({ kind: "close" });
	});

	test("the rows dispatch their acts to a choice", () => {
		const fx = fixture(`${DIR}/panel-acts-${process.pid}`);
		fillBranch(fx.raw, 600);
		const ids = itemIds(toSnapshot(liveState(fx.session)));
		const choices: PanelChoice[] = [];
		const card = nodeOf(panelView(fx.session, 0, (choice) => choices.push(choice)));
		const event = (act: string) => ({ type: "action" as const, key: "todo-ng.panel", act, mods: [] });
		card.handlers.onAction?.("todo-ng.goal", event("todo-ng.goal"));
		card.handlers.onAction?.("todo-ng.explain:missing-task", event("todo-ng.explain:missing-task"));
		for (const id of ids) card.handlers.onAction?.(`todo-ng.explain:${id}`, event(`todo-ng.explain:${id}`));
		card.handlers.onAction?.("close", event("close"));
		const expected: PanelChoice[] = [{ kind: "goal" }, ...ids.map((id): PanelChoice => ({ kind: "explain", id })), { kind: "close" }];
		expect(choices).toEqual(expected);
	});

	test("the first entry activates the goal editor", () => {
		const fx = fixture(`${DIR}/panel-goal-key-${process.pid}`);
		fillBranch(fx.raw, 600);
		const choices: PanelChoice[] = [];
		const card = nodeOf(panelView(fx.session, 0, (choice) => choices.push(choice)));
		card.handlers.onKey?.({ id: "enter", kind: "press", raw: "" });
		expect(choices).toEqual([{ kind: "goal" }]);
	});
});

describe("goal and explanation forms", () => {
	test("the goal form names every field and escapes the current values", () => {
		const html = goalFormHtml({ objective: `a<b & "c"`, measure: "Green", doneWhen: "Merged" });
		expect(html).toContain('name="objective"');
		expect(html).toContain('name="measure"');
		expect(html).toContain('name="doneWhen"');
		expect(html).toContain("a&lt;b &amp; &quot;c&quot;");
		expect(html).toContain(">Green</textarea>");
		expect(html).not.toContain("a<b");
	});

	test("a missing goal renders empty fields", () => {
		const html = goalFormHtml(undefined);
		expect(html).toContain('name="objective" rows="3"></textarea>');
		expect(html).toContain('name="measure" rows="3"></textarea>');
		expect(html).toContain('name="doneWhen" rows="3"></textarea>');
	});

	test("the explanation form carries its task and current text", () => {
		const html = explainFormHtml("Task t1", "Work <done>");
		expect(html).toContain('name="explanation"');
		expect(html).toContain("Task t1");
		expect(html).toContain("Work &lt;done&gt;");
	});

	test("submitted goal data becomes a goal", () => {
		expect(goalFromForm({ objective: "Ship", measure: "Green", doneWhen: "Merged" })).toEqual({
			objective: "Ship",
			measure: "Green",
			doneWhen: "Merged",
		});
		expect(goalFromForm({ objective: "Ship", measure: "Green" })).toBeUndefined();
	});
});

describe("edits through the form path", () => {
	test("a goal form saves the goal the list then reports", () => {
		const fx = fixture(`${DIR}/edit-goal-${process.pid}`);
		fillBranch(fx.raw, 600);
		const outcome = applyGoalForm(fx.session, { objective: "Ship the port", measure: "Measured", doneWhen: "Merged" });
		expect(outcome).toEqual({ kind: "saved" });
		expect(toSnapshot(liveState(fx.session)).goal).toEqual({ objective: "Ship the port", measure: "Measured", doneWhen: "Merged" });
	});

	test("the HUD shows a saved goal", () => {
		const fx = fixture(`${DIR}/edit-goal-hud-${process.pid}`);
		fillBranch(fx.raw, 600);
		const hud = hudController(
			() => toSnapshot(liveState(fx.session)),
			() => {},
		);
		hud.handlers.onToggle(false);
		expect(drawn(hud.node())).toContain("Ship it");
		applyGoalForm(fx.session, { objective: "Ported objective", measure: "Measured", doneWhen: "Merged" });
		hud.refresh();
		const expanded = drawn(hud.node());
		expect(expanded).toContain("Ported objective");
		expect(expanded).not.toContain("Ship it");
	});

	test("an empty goal field is rejected and changes nothing", () => {
		const fx = fixture(`${DIR}/edit-goal-reject-${process.pid}`);
		fillBranch(fx.raw, 600);
		const before = toSnapshot(liveState(fx.session)).goal;
		const outcome = applyGoalForm(fx.session, { objective: "   ", measure: "Measured", doneWhen: "Merged" });
		expect(outcome.kind).toBe("rejected");
		if (outcome.kind !== "rejected") throw new Error("expected a rejection");
		expect(outcome.message).toContain("must not be empty");
		expect(toSnapshot(liveState(fx.session)).goal).toEqual(before);
	});

	test("a form without every field is a cancelled edit", () => {
		const fx = fixture(`${DIR}/edit-goal-cancel-${process.pid}`);
		fillBranch(fx.raw, 600);
		const before = toSnapshot(liveState(fx.session)).goal;
		expect(applyGoalForm(fx.session, { measure: "Measured" })).toEqual({ kind: "cancelled" });
		expect(toSnapshot(liveState(fx.session)).goal).toEqual(before);
	});

	test("an explanation form saves the item's explanation", () => {
		const fx = fixture(`${DIR}/edit-explain-${process.pid}`);
		fillBranch(fx.raw, 600);
		const id = itemIds(toSnapshot(liveState(fx.session)))[0];
		if (id === undefined) throw new Error("fixture has no todo item");
		expect(applyExplainForm(fx.session, id, { explanation: "Explained by the test" })).toEqual({ kind: "saved" });
		const saved = toSnapshot(liveState(fx.session))
			.phases.flatMap((phase) => phase.items)
			.find((item) => item.id === id);
		expect(saved?.explanation).toBe("Explained by the test");
	});

	test("an explanation form for an unknown task is rejected", () => {
		const fx = fixture(`${DIR}/edit-explain-missing-${process.pid}`);
		fillBranch(fx.raw, 600);
		const outcome = applyExplainForm(fx.session, "no-such-task", { explanation: "Text" });
		expect(outcome.kind).toBe("rejected");
	});
});
