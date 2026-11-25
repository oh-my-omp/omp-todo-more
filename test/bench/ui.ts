import * as jsc from "bun:jsc";
import { mkdirSync } from "node:fs";
import { isUiNode, type JSXNode } from "@oh-my-pi/pi-tui";
import { liveState } from "../../src/commit.ts";
import { toSnapshot } from "../../src/state.ts";
import { type HudController, hudController } from "../../src/ui.ts";
import { appendTodoChange, fillBranch, fixture, messageEntry, type UiFixture } from "../ui-fixture.ts";

const args = new Map<string, string>();
for (let i = 2; i < Bun.argv.length; i += 2) args.set(Bun.argv[i] ?? "", Bun.argv[i + 1] ?? "");
const scenario = args.get("--scenario") ?? "";
const frames = Number(args.get("--frames") ?? "50");
const appends = Number(args.get("--appends") ?? "500");
const BRANCH_SIZE = 10_000;

let failed = false;
const fail = (message: string): void => {
	failed = true;
	console.error(`FAIL ${message}`);
};
const ok = (message: string): void => console.log(`ok   ${message}`);

const benchDir = `/tmp/ui-bench-${process.pid}`;
mkdirSync(benchDir, { recursive: true });

function makeFixture(name: string): UiFixture {
	const fx = fixture(`${benchDir}/${name}`);
	fillBranch(fx.raw, BRANCH_SIZE);
	return fx;
}

function makeHud(fx: UiFixture): HudController {
	return hudController(
		() => toSnapshot(liveState(fx.session)),
		() => {},
	);
}

function shows(value: JSXNode, needle: string): boolean {
	if (isUiNode(value)) return JSON.stringify(value.props()).includes(needle) || value.children().some((child) => shows(child, needle));
	if (Array.isArray(value)) return value.some((child) => shows(child, needle));
	return false;
}

function scenarioHud(): void {
	const fx = makeFixture("hud");
	const hud = makeHud(fx);
	const first = hud.node();
	let copies = 0;
	let views = 0;
	for (let i = 1; i < frames; i++) {
		fx.resetCounters();
		hud.refresh();
		const node = hud.node();
		copies += fx.counters.copies;
		views += fx.counters.views;
		if (node !== first) fail(`frame ${i + 1}: an unchanged branch built a new node`);
	}
	if (copies !== 0) fail(`frames 2..${frames}: ${copies} branch copies (want 0)`);
	if (!failed) ok(`${frames} repaints of an unchanged branch: one node identity, ${copies} copies, ${views} view reads`);
}

function scenarioGrow(): void {
	const fx = makeFixture("grow");
	const hud = makeHud(fx);
	const before = hud.node();
	for (let i = 0; i < appends; i++) messageEntry(fx.raw, BRANCH_SIZE + i);
	fx.resetCounters();
	hud.refresh();
	const kept = hud.node();
	const messageCounts = { ...fx.counters };
	if (kept !== before) fail("plain message growth replaced the HUD node");
	appendTodoChange(fx.raw, "Grown task");
	fx.resetCounters();
	hud.refresh();
	const grown = hud.node();
	const todoCounts = { ...fx.counters };
	if (grown === before) fail("a todo change did not re-derive the HUD");
	if (!shows(grown, "Grown task")) fail("a todo change is missing from the re-derived HUD");
	if (todoCounts.copies !== 0) fail(`grown HUD frame copied the branch ${todoCounts.copies}× (want 0)`);
	if (!failed)
		ok(`+${appends} entries: node kept (${JSON.stringify(messageCounts)}); todo change re-derived (${JSON.stringify(todoCounts)})`);
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function scenarioIdleLoop(): void {
	const fx = makeFixture("idle-loop");
	const warm = makeHud(fx);
	warm.node();
	const rounds = 30;
	const callsPerRound = 100;
	const coldTime: number[] = [];
	const warmTime: number[] = [];
	for (let r = 0; r < rounds; r++) {
		const t0 = performance.now();
		for (let i = 0; i < callsPerRound; i++) makeHud(fx).node();
		coldTime.push((performance.now() - t0) / callsPerRound);
		const t1 = performance.now();
		for (let i = 0; i < callsPerRound; i++) {
			warm.refresh();
			warm.node();
		}
		warmTime.push((performance.now() - t1) / callsPerRound);
	}
	const coldHeap: number[] = [];
	const coldArrays: number[] = [];
	const warmHeap: number[] = [];
	const warmArrays: number[] = [];
	for (let r = 0; r < 100; r++) {
		jsc.gcAndSweep();
		const a0 = jsc.heapStats().objectTypeCounts.Array ?? 0;
		const h0 = process.memoryUsage().heapUsed;
		makeHud(fx).node();
		coldHeap.push(process.memoryUsage().heapUsed - h0);
		coldArrays.push((jsc.heapStats().objectTypeCounts.Array ?? 0) - a0);
		jsc.gcAndSweep();
		const a1 = jsc.heapStats().objectTypeCounts.Array ?? 0;
		const h1 = process.memoryUsage().heapUsed;
		warm.refresh();
		warm.node();
		warmHeap.push(process.memoryUsage().heapUsed - h1);
		warmArrays.push((jsc.heapStats().objectTypeCounts.Array ?? 0) - a1);
	}
	const mt = median(coldTime);
	const nt = median(warmTime);
	const mh = median(coldHeap);
	const nh = median(warmHeap);
	const ma = median(coldArrays);
	const na = median(warmArrays);
	console.log(`cold: ${(mt * 1000).toFixed(1)} µs/call, ${(mh / 1024).toFixed(1)} KiB heapUsed, +${ma} Array objects (median)`);
	console.log(`warm: ${(nt * 1000).toFixed(1)} µs/call, ${(nh / 1024).toFixed(1)} KiB heapUsed, +${na} Array objects (median)`);
	console.log(`ratios:    ${(mt / nt).toFixed(1)}× faster; Array objects/call ${na} vs ${ma}; heapUsed ${nh} vs ${mh} bytes`);
}

const scenarios: Record<string, () => void> = {
	hud: scenarioHud,
	grow: scenarioGrow,
	"idle-loop": scenarioIdleLoop,
};

const run = scenarios[scenario];
if (run === undefined) {
	console.error(`usage: bun test/bench/ui.ts --scenario ${Object.keys(scenarios).join("|")} [--frames N] [--appends N]`);
	process.exit(2);
}
run();
if (failed) process.exit(1);
