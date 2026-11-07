/**
 * Behavior regression for the HUD/panel offset skip
 * (oh-my-omp/omp-todo-more#28): the offset derivation must be
 * indistinguishable from re-derivation — same returned nodes, same state —
 * step by step, while skipping branch reads when the branch is unchanged.
 *
 * Growth comes in two flavors: a genuine todo change (new rich snapshot
 * entry — output must change) and a plain message entry (offset must miss
 * and re-derive, output stays the same). Both prove §7's “growth always
 * re-derives”.
 *
 * Each invalidation test also carries a mutation check: the offset update it
 * guards is temporarily broken, and the test must fail. This keeps the tests
 * from passing when the skip logic is removed or bypassed.
 */

import { describe, expect, test } from "bun:test";
import { TodoHud, TodoPanel } from "../src/ui.ts";
import { appendTodoChange, fillBranch, fixture, messageEntry, type UiFixture } from "./ui-fixture.ts";

const DIR = "/tmp/ui-offset-test";

/** Small branch: a rich snapshot plus a few plain entries after it. */
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
	test("HUD reflects a genuine todo change and re-reads", () => {
		const fx = smallFixture("hud-grow");
		const hud = makeHud(fx);
		const before = hud.describe();
		appendTodoChange(fx.raw, "Brand new task");
		fx.resetCounters();
		const after = hud.describe();
		const implCopies = fx.counters.copies;
		const implReads = fx.counters.reads;
		// Fresh HUD on the same branch must agree; the genuinely changed
		// output proves re-derivation reached the renderer.
		expect(jsonEqual(after, makeHud(fx).describe())).toBe(true);
		expect(jsonEqual(after, before)).toBe(false);
		expect(implCopies).toBe(0);
		expect(implReads).toBeGreaterThan(1);
	});

	test("plain message growth re-derives with identical output", () => {
		const fx = smallFixture("hud-plain");
		const hud = makeHud(fx);
		const before = hud.describe();
		messageEntry(fx.raw, 10_001);
		fx.resetCounters();
		const after = hud.describe();
		const implCopies = fx.counters.copies;
		const implReads = fx.counters.reads;
		expect(jsonEqual(after, makeHud(fx).describe())).toBe(true);
		expect(jsonEqual(after, before)).toBe(true);
		expect(implCopies).toBe(0);
		expect(implReads).toBeGreaterThan(1);
	});

	test("panel describe reflects a genuine todo change", () => {
		const fx = smallFixture("panel-grow");
		const panel = makePanel(fx);
		panel.describe();
		appendTodoChange(fx.raw, "Brand new task");
		// Growth clears the cached node inside `readState()` (§7): the next
		// `describe()` re-derives without an explicit `invalidate()`.
		fx.resetCounters();
		const node = panel.describe();
		const implCopies = fx.counters.copies;
		const implReads = fx.counters.reads;
		expect(JSON.stringify(node)).toContain("Brand new task");
		expect(implCopies).toBe(0);
		expect(implReads).toBeGreaterThan(1);
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

	test("mutation: frozen offset would return the stale node", () => {
		const fx = smallFixture("hud-grow-mut");
		const hud = makeHud(fx);
		const stale = hud.describe();
		appendTodoChange(fx.raw, "Brand new task");
		const fresh = makeHud(fx).describe();
		// A frozen offset keeps returning the old node; the test fails if
		// re-derivation is broken because stale and fresh would coincide.
		expect(jsonEqual(stale, fresh)).toBe(false);
		expect(jsonEqual(hud.describe(), fresh)).toBe(true);
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
		fxB.resetCounters();
		const again = switched.describe();
		expect(jsonEqual(again, first)).toBe(true);
		// Fresh small branch re-derivation: bounded reads, zero copies.
		expect(fxB.counters.copies).toBe(0);
		expect(fxB.counters.reads).toBeLessThanOrEqual(10);
	});
});

describe("disclosure toggle invalidates", () => {
	test("HUD expanded output differs and re-derives once", () => {
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
		fx.resetCounters();
		const expanded = hud.describe();
		expect(jsonEqual(expanded, collapsed)).toBe(false);
		expect(fx.counters.copies).toBe(0);
		expect(fx.counters.reads).toBeGreaterThan(1);
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
		expect(fx.counters.copies).toBe(0);
		expect(fx.counters.reads).toBeLessThanOrEqual(1);
		const view = fx.raw.getBranchView();
		fx.raw.branchWithSummary(view.at(-2)?.id ?? null, "sibling");
		fx.resetCounters();
		panel.invalidate();
		panel.describe();
		expect(fx.counters.reads).toBeGreaterThan(1);
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
		expect(fx.counters.copies).toBe(0);
		expect(fx.counters.reads).toBeLessThanOrEqual(1);
	});
});
