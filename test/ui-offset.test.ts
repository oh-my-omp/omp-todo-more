import { describe, expect, test } from "bun:test";
import { TodoHud, TodoPanel } from "../src/ui.ts";
import { appendTodoChange, fillBranch, fixture, messageEntry, type UiFixture } from "./ui-fixture.ts";

const DIR = "/tmp/ui-offset-test";

function smallFixture(name: string): UiFixture {
	const fx = fixture(`${DIR}/${name}-${process.pid}`);
	fillBranch(fx.raw, 600);
	return fx;
}

function makeHud(fx: UiFixture): TodoHud {
	const stubPi = { logger: { warn: () => {} } } as never;
	return new TodoHud(
		stubPi,
		() => fx.session,
		async () => {},
		fx.tui(),
		() => {},
	);
}

function makePanel(fx: UiFixture): TodoPanel {
	const controller = new AbortController();
	return new TodoPanel(
		fx.session,
		fx.theme(),
		() => {},
		() => {},
		controller.signal,
		() => true,
	);
}

const jsonEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

describe("growth re-derives", () => {
	test("HUD reflects a genuine todo change", () => {
		const fx = smallFixture("hud-grow");
		const hud = makeHud(fx);
		const before = hud.describe();
		appendTodoChange(fx.raw, "Brand new task");
		const after = hud.describe();
		expect(jsonEqual(after, makeHud(fx).describe())).toBe(true);
		expect(jsonEqual(after, before)).toBe(false);
	});

	test("plain message growth re-derives with identical output", () => {
		const fx = smallFixture("hud-plain");
		const hud = makeHud(fx);
		const before = hud.describe();
		messageEntry(fx.raw, 10_001);
		const after = hud.describe();
		expect(jsonEqual(after, makeHud(fx).describe())).toBe(true);
		expect(jsonEqual(after, before)).toBe(true);
	});

	test("panel describe reflects a genuine todo change", () => {
		const fx = smallFixture("panel-grow");
		const panel = makePanel(fx);
		panel.describe();
		appendTodoChange(fx.raw, "Brand new task");
		const node = panel.describe();
		expect(JSON.stringify(node)).toContain("Brand new task");
		expect(JSON.stringify(node)).toBe(JSON.stringify(makePanel(fx).describe()));
	});

	test("panel handleInput sees appended titles", () => {
		const fx = smallFixture("panel-input-grow");
		const panel = makePanel(fx);
		panel.describe();
		appendTodoChange(fx.raw, "Brand new task");
		panel.handleInput("\t");
		const rendered = panel.render(120).join("\n");
		expect(rendered).toContain("Brand new task");
	});
});

describe("empty branch keeps its placeholder", () => {
	test("every describe() returns the hidden placeholder and agrees with a fresh HUD", () => {
		const fx = fixture(`${DIR}/hud-empty-${process.pid}`);
		const hud = makeHud(fx);
		const first = hud.describe();
		const second = hud.describe();
		expect(JSON.stringify(first)).toContain('"hidden":true');
		expect(JSON.stringify(second)).toContain('"hidden":true');
		expect(second).toBe(first);
		expect(jsonEqual(second, makeHud(fx).describe())).toBe(true);
	});

	test("a plain message after the empty frame still yields the placeholder", () => {
		const fx = fixture(`${DIR}/hud-empty-plain-${process.pid}`);
		const hud = makeHud(fx);
		hud.describe();
		hud.describe();
		messageEntry(fx.raw, 2);
		const after = hud.describe();
		expect(JSON.stringify(after)).toContain('"hidden":true');
		expect(jsonEqual(after, makeHud(fx).describe())).toBe(true);
	});

	test("the first snapshot turns the cached placeholder into a visible pill", () => {
		const fx = fixture(`${DIR}/hud-empty-grow-${process.pid}`);
		const hud = makeHud(fx);
		hud.describe();
		hud.describe();
		appendTodoChange(fx.raw, "First task");
		const first = hud.describe();
		const second = hud.describe();
		expect(JSON.stringify(first)).not.toContain('"hidden":true');
		expect(JSON.stringify(first)).toContain("First task");
		expect(second).toBe(first);
		expect(jsonEqual(second, makeHud(fx).describe())).toBe(true);
	});
});

describe("session switch clears the offset", () => {
	test("HUD re-derives for a new session", () => {
		const fxA = smallFixture("hud-session-a");
		const hud = makeHud(fxA);
		hud.describe();
		const fxB = smallFixture("hud-session-b");
		appendTodoChange(fxB.raw, "Other session task");
		const switched = new TodoHud(
			{ logger: { warn: () => {} } } as never,
			() => fxB.session,
			async () => {},
			fxB.tui(),
			() => {},
		);
		const first = switched.describe();
		expect(JSON.stringify(first)).toContain("Other session task");
		expect(jsonEqual(first, makeHud(fxB).describe())).toBe(true);
		const again = switched.describe();
		expect(jsonEqual(again, first)).toBe(true);
	});
});

describe("disclosure toggle invalidates", () => {
	test("HUD expanded output differs and then stays steady", () => {
		const fx = smallFixture("hud-disclosure");
		const tui = {
			requestRender() {},
			requestComponentRender() {},
			addInputListener: () => () => {},
		} as never;
		const hud = new TodoHud(
			{ logger: { warn: () => {} } } as never,
			() => fx.session,
			async () => {},
			tui,
			() => {},
		);
		const collapsed = hud.describe();
		hud.handleNativeEvent({ type: "toggle", key: "pill/control", collapsed: false });
		const expanded = hud.describe();
		expect(jsonEqual(expanded, collapsed)).toBe(false);
		fx.resetCounters();
		const steady = hud.describe();
		expect(jsonEqual(steady, expanded)).toBe(true);
		expect(fx.counters.reads).toBeLessThanOrEqual(1);
	});
});

describe("selection survives offset hits", () => {
	test("panel selection moves reflect in describe without re-reads", () => {
		const fx = smallFixture("panel-select");
		const panel = makePanel(fx);
		const first = panel.describe();
		panel.handleInput("\t");
		const second = panel.describe();
		expect(jsonEqual(second, first)).toBe(false);
		fx.resetCounters();
		panel.describe();
		expect(fx.counters.reads).toBeLessThanOrEqual(1);
	});
});

describe("width change re-renders", () => {
	test("panel ANSI render follows width", () => {
		const fx = smallFixture("panel-width");
		const panel = makePanel(fx);
		panel.describe();
		const narrow = panel.render(40).join("\n");
		const wide = panel.render(120).join("\n");
		expect(narrow).not.toBe(wide);
		fx.resetCounters();
		panel.render(120);
		expect(fx.counters.reads).toBeLessThanOrEqual(1);
	});
});
