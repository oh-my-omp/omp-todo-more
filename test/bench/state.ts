/**
 * Branch-reader bench for `src/state.ts` (oh-my-omp/omp-todo-more#25).
 *
 * Load: the #24 §4 branch from `./branch.ts` (N=10,000 by default). Baseline:
 * the same scenario run against `src/state.ts` of the audit anchor
 * (`ANCHOR`, extracted with git archive), in the same process and on the same
 * entries, so every reading has its pre-change counterpart. `--baseline`
 * prints only the anchor readings.
 *
 * Deterministic counters carry the gates; timings (median of rounds) and the
 * §4 `heapUsed` delta after `Bun.gc(true)` are printed as measured, with the
 * JSC live-object delta beside them (on this Bun, `heapUsed` misses short-lived
 * garbage, see oh-my-omp/omp-todo-more#36).
 *
 * Scenarios:
 *   discriminated-read  — no snapshot on the branch (the read walks it all):
 *                         message entries handed to the schema parser, time,
 *                         allocation; states equal.
 *   joins               — `--natives K` pending native records: whole-branch
 *                         walks inside one `readTodoMore` (≤1); states equal.
 *   state-with-waits    — `readTodoMoreWithWaits` equals `readTodoMore` +
 *                         `askWaits`, in exactly one whole-branch walk.
 *   positional          — `--queries Q` positions: `todoMoreHistory(...).at(i)`
 *                         equals `readTodoMore(slice(0, i + 1))` (and every
 *                         position of an edge branch), and the build plus Q
 *                         queries costs less than Q independent prefix reads.
 *   discriminators      — `--corrupt F` of the entries broken or unrelated:
 *                         states equal to the anchor at the leaf and prefixes.
 *
 *   bun test/bench/state.ts --scenario <name> [--n N] [--natives K] [--queries Q] [--corrupt F] [--baseline]
 */

import * as jsc from "bun:jsc";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import * as current from "../../src/state.ts";
import { ANCHOR, anchorModule, branch, counted, flags, median } from "./branch.ts";

type Reader = Pick<typeof current, "readTodoMore" | "askWaits">;

const args = flags(Bun.argv);
const scenario = args.get("--scenario") ?? "";
const n = Number(args.get("--n") ?? "10000");
const natives = Number(args.get("--natives") ?? "50");
const queries = Number(args.get("--queries") ?? "20");
const corrupt = Number(args.get("--corrupt") ?? "0.1");
const baselineOnly = args.has("--baseline");
const anchor = await anchorModule<Reader>("src/state.ts");
const anchorLabel = `baseline (anchor ${ANCHOR.slice(0, 7)})`;

let failed = false;
const check = (label: string, pass: boolean, detail: string): void => {
	if (!pass) failed = true;
	console.log(`${pass ? "ok  " : "FAIL"} ${label}: ${detail}`);
};

/** Milliseconds per call: median over `rounds` rounds of `perRound` calls. */
function timePerCall(fn: () => unknown, rounds = 25, perRound = 10): number {
	for (let warm = 0; warm < perRound; warm++) fn();
	const samples: number[] = [];
	for (let round = 0; round < rounds; round++) {
		const start = performance.now();
		for (let call = 0; call < perRound; call++) fn();
		samples.push((performance.now() - start) / perRound);
	}
	return median(samples);
}

/** Objects on the JSC heap, swept or not: a heap walk (`objectCount` only moves at collection). */
function heapObjects(): number {
	let total = 0;
	for (const count of Object.values(jsc.heapStats().objectTypeCounts)) total += count;
	return total;
}

/**
 * §4 allocation readings for one call (medians of 15): the `heapUsed` delta
 * after a full GC, and the heap-object delta, which counts the call's garbage
 * until a collection runs inside the call (so it is a lower bound).
 */
function allocation(fn: () => unknown): { heapUsed: number; objects: number } {
	const heap: number[] = [];
	const objects: number[] = [];
	for (let run = 0; run < 15; run++) {
		Bun.gc(true);
		const objects0 = heapObjects();
		const heap0 = process.memoryUsage().heapUsed;
		fn();
		heap.push(process.memoryUsage().heapUsed - heap0);
		objects.push(heapObjects() - objects0);
	}
	return { heapUsed: median(heap), objects: median(objects) };
}

type Reading = { readonly ms: number; readonly heapUsed: number; readonly objects: number };

function reading(fn: () => unknown): Reading {
	return { ms: timePerCall(fn), ...allocation(fn) };
}

const show = (label: string, value: Reading, extra = ""): void =>
	console.log(
		`${label}: ${(value.ms * 1000).toFixed(1)} µs/call, heapUsed ${(value.heapUsed / 1024).toFixed(1)} KiB, +${value.objects} objects${extra}`,
	);

/**
 * A copy of `entries` whose messages count schema parses: the parser copies a
 * candidate object's own keys first, so an `ownKeys` on a message means the
 * message entered the parser. Discriminant reads (`role`, `toolName`) do not.
 */
function parseCounted(entries: readonly SessionEntry[]): { readonly entries: SessionEntry[]; readonly parsed: Set<string> } {
	const parsed = new Set<string>();
	const copy = entries.map((entry): SessionEntry => {
		if (entry.type !== "message") return entry;
		const message = new Proxy(entry.message, {
			ownKeys(target) {
				parsed.add(entry.id);
				return Reflect.ownKeys(target);
			},
		});
		return { ...entry, message };
	});
	return { entries: copy, parsed };
}

const isTodoResult = (entry: SessionEntry): boolean =>
	entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "todo";

function scenarioDiscriminatedRead(): void {
	const entries = branch({ n, snapshotEvery: 0 });
	const messages = entries.filter((entry) => entry.type === "message").length;
	const traced = parseCounted(entries);
	anchor.readTodoMore(traced.entries);
	const anchorParsed = traced.parsed.size;
	const base = reading(() => anchor.readTodoMore(entries));
	show(anchorLabel, base, `, ${anchorParsed}/${messages} message entries parsed`);
	if (baselineOnly) return;
	traced.parsed.clear();
	current.readTodoMore(traced.entries);
	const wrong = [...traced.parsed].filter((id) => !isTodoResult(entries.find((entry) => entry.id === id) ?? entries[0]!)).length;
	const now = reading(() => current.readTodoMore(entries));
	show("current", now, `, ${traced.parsed.size}/${messages} message entries parsed`);
	console.log(
		`ratios: ${(base.ms / now.ms).toFixed(1)}× faster; objects/call ${now.objects} vs ${base.objects}; heapUsed ${now.heapUsed} vs ${base.heapUsed} bytes`,
	);
	check("states equal", Bun.deepEquals(current.readTodoMore(entries), anchor.readTodoMore(entries)), "readTodoMore(entries)");
	check("discriminant first", wrong === 0 && anchorParsed > 0, `${wrong} non-todo message entries parsed (baseline ${anchorParsed})`);
	check("faster", now.ms < base.ms, `${(now.ms * 1000).toFixed(1)} µs vs ${(base.ms * 1000).toFixed(1)} µs`);
	check("fewer objects", now.objects < base.objects, `+${now.objects} vs +${base.objects} heap objects after one call`);
}

function scenarioJoins(): void {
	const entries = branch({ n, natives });
	const base = counted(entries);
	anchor.readTodoMore(base.entries);
	console.log(
		`${anchorLabel}: ${base.counters.passes} whole-branch walks, ${base.counters.reads} element reads (${natives} pending natives)`,
	);
	const baseTime = timePerCall(() => anchor.readTodoMore(entries), 9, 3);
	console.log(`${anchorLabel}: ${(baseTime * 1000).toFixed(1)} µs/call`);
	if (baselineOnly) return;
	const now = counted(entries);
	current.readTodoMore(now.entries);
	const nowTime = timePerCall(() => current.readTodoMore(entries), 9, 3);
	console.log(
		`current: ${now.counters.passes} whole-branch walks, ${now.counters.reads} element reads; ${(nowTime * 1000).toFixed(1)} µs/call`,
	);
	check("states equal", Bun.deepEquals(current.readTodoMore(entries), anchor.readTodoMore(entries)), `${natives} natives joined`);
	check("askWaits at most once", now.counters.passes <= 1, `${now.counters.passes} whole-branch walks (baseline ${base.counters.passes})`);
}

function scenarioStateWithWaits(): void {
	const entries = branch({ n, natives: 5 });
	const base = counted(entries);
	const baseState = anchor.readTodoMore(base.entries);
	const baseWaits = anchor.askWaits(base.entries);
	console.log(`${anchorLabel} readTodoMore + askWaits: ${base.counters.passes} whole-branch walks, ${base.counters.reads} element reads`);
	const baseTime = timePerCall(() => [anchor.readTodoMore(entries), anchor.askWaits(entries)]);
	console.log(`${anchorLabel}: ${(baseTime * 1000).toFixed(1)} µs/call`);
	if (baselineOnly) return;
	const now = counted(entries);
	const read = current.readTodoMoreWithWaits(now.entries);
	const nowTime = timePerCall(() => current.readTodoMoreWithWaits(entries));
	console.log(
		`current readTodoMoreWithWaits: ${now.counters.passes} whole-branch walks, ${now.counters.reads} element reads; ${(nowTime * 1000).toFixed(1)} µs/call`,
	);
	check(
		"state equal",
		Bun.deepEquals(read.state, baseState) && Bun.deepEquals(read.state, current.readTodoMore(entries)),
		"vs readTodoMore",
	);
	check(
		"waits equal",
		Bun.deepEquals(read.waits, baseWaits) && Bun.deepEquals(read.waits, current.askWaits(entries)),
		`${read.waits.length} waits vs askWaits`,
	);
	check("one walk", now.counters.passes === 1, `${now.counters.passes} whole-branch walks`);
}

function positions(length: number, count: number): number[] {
	return Array.from({ length: count }, (_, k) => Math.round(((k + 1) * (length - 1)) / count));
}

function scenarioPositional(): void {
	const entries = branch({ n, natives: 20 });
	const at = positions(entries.length, queries);
	const prefixReads = (reader: Reader) => () => at.map((index) => reader.readTodoMore(entries.slice(0, index + 1)));
	const baseTime = timePerCall(prefixReads(anchor), 9, 2);
	console.log(`${anchorLabel}: ${queries} × readTodoMore(slice) ${(baseTime * 1000).toFixed(1)} µs`);
	if (baselineOnly) return;
	const separate = timePerCall(prefixReads(current), 9, 2);
	const amortized = timePerCall(
		() => {
			const history = current.todoMoreHistory(entries);
			return at.map((index) => history.at(index));
		},
		9,
		2,
	);
	console.log(`current: ${queries} × readTodoMore(slice) ${(separate * 1000).toFixed(1)} µs`);
	console.log(`current: todoMoreHistory + ${queries} × at ${(amortized * 1000).toFixed(1)} µs`);
	const history = current.todoMoreHistory(entries);
	const mismatched = at.filter((index) => !Bun.deepEquals(history.at(index), anchor.readTodoMore(entries.slice(0, index + 1))));
	check("queries equal", mismatched.length === 0, `${queries - mismatched.length}/${queries} equal to readTodoMore(prefix)`);
	// Every position of a dense edge branch: asks open across positions, exits, natives between snapshots, corrupt records.
	const edge = branch({ n: 1_500, snapshotEvery: 200, tail: 600, natives: 30, corrupt: 0.05, inProgress: 2 });
	const edgeHistory = current.todoMoreHistory(edge);
	let edgeMismatch = 0;
	for (let index = -1; index <= edge.length; index++) {
		if (!Bun.deepEquals(edgeHistory.at(index), anchor.readTodoMore(edge.slice(0, Math.max(0, index + 1))))) edgeMismatch++;
	}
	check(
		"every position equal",
		edgeMismatch === 0,
		`${edge.length + 2 - edgeMismatch}/${edge.length + 2} positions of a 1,500-entry edge branch`,
	);
	check("amortized", amortized < separate && amortized < baseTime, `${(separate / amortized).toFixed(1)}× under independent reads`);
}

function scenarioDiscriminators(): void {
	const entries = branch({ n, corrupt, natives: 10 });
	const baseState = anchor.readTodoMore(entries);
	console.log(
		`${anchorLabel}: state ${baseState.kind}${baseState.kind === "list" ? ` (${baseState.phases.flatMap((phase) => phase.items).length} items)` : ""}`,
	);
	if (baselineOnly) return;
	check(
		"leaf state equal",
		Bun.deepEquals(current.readTodoMore(entries), baseState),
		`${Math.round(corrupt * 100)}% corrupt or unrelated entries`,
	);
	const read = current.readTodoMoreWithWaits(entries);
	check(
		"shared read equal",
		Bun.deepEquals(read.state, baseState) && Bun.deepEquals(read.waits, anchor.askWaits(entries)),
		"readTodoMoreWithWaits",
	);
	const history = current.todoMoreHistory(entries);
	let mismatch = 0;
	let compared = 0;
	for (let index = 0; index < entries.length; index += 97) {
		compared++;
		const prefix = entries.slice(0, index + 1);
		const expected = anchor.readTodoMore(prefix);
		if (!Bun.deepEquals(current.readTodoMore(prefix), expected) || !Bun.deepEquals(history.at(index), expected)) mismatch++;
	}
	check("prefix states equal", mismatch === 0, `${compared - mismatch}/${compared} prefixes (readTodoMore and todoMoreHistory)`);
}

const scenarios: Record<string, () => void> = {
	"discriminated-read": scenarioDiscriminatedRead,
	joins: scenarioJoins,
	"state-with-waits": scenarioStateWithWaits,
	positional: scenarioPositional,
	discriminators: scenarioDiscriminators,
};

const run = scenarios[scenario];
if (run === undefined) {
	console.error(
		`usage: bun test/bench/state.ts --scenario ${Object.keys(scenarios).join("|")} [--n N] [--natives K] [--queries Q] [--corrupt F] [--baseline]`,
	);
	process.exit(2);
}
run();
process.exit(failed ? 1 : 0);
