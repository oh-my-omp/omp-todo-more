/**
 * Turns one recording directory (run.ts output) into comparable text files:
 * run-specific values (uuids, timestamps, durations, temp paths, session ids)
 * become stable placeholders, numbered in order of first appearance, so two
 * recordings of the same scenario diff only where behavior differs.
 *
 * Bucketing rule (keep signal, drop jitter): wall-clock instants (ISO strings,
 * epoch numbers, local date/time text) collapse to an opaque placeholder —
 * the fact that an instant existed is the behavior, not its value. Measured
 * durations are quantized to a coarse bucket instead of deleted: a run one
 * bucket longer or shorter still diffs, jitter inside a bucket does not.
 * Bucketing rounds to NEAREST (not floor) because scripted timers fire at
 * round values (10 s grace, 60 s estimate, hint+60 s quota); rounding puts
 * the expected value mid-bucket. Buckets: millisecond durations → nearest
 * 10 s (`<key~10s>`), `elapsed … min` texts → nearest 0.5 min. Provider
 * latency (`duration`, `ttft`) and millisecond figures inside text (task
 * results, JSON embedded in strings) carry scheduler noise only and become
 * opaque. A scenario needing a tighter bound must script a wait wider than a
 * bucket.
 *
 * Commit ids are never guessed from a regex: run.ts records `git rev-list
 * --all` into git-shas.txt and each listed sha (plus its 7-char prefix, the
 * short form the extension prints) becomes a `<sha#N>` placeholder numbered
 * like ids, since commit timestamps make every run's shas differ. Local clock text is
 * anchored: `YYYY-MM-DD`, `HH:MM:SS`, and `HH:MM` only after a clock-word
 * prefix ("scheduled for", "resets", "at"), so scripted content is untouched.
 *
 * Each scenario's `expect` strings must appear in the normalized output; a
 * missing marker fails normalization (exit 1) rather than silently recording
 * a scenario that never reached the behavior it claims to cover.
 *
 * Usage: bun test/parity/normalize.ts <recording dir> <out dir>
 * Writes per scenario: requests.txt, events.txt, session.txt, git.txt.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SCENARIOS } from "./scenarios.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const TMP_ROOT = /\/(?:private\/)?(?:var\/folders\/[^"\s]+?|tmp)\/todo-more-parity-(?:baseline|candidate)-[A-Za-z0-9]+/g;
/** `YYYY-MM-DD` (after ISO runs, only non-ISO dates remain). */
const LOCAL_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
/** `HH:MM:SS` is precise enough to replace globally (ctx rows, task log). */
const LOCAL_TIME_FULL = /\b\d{2}:\d{2}:\d{2}\b/g;
/** `HH:MM` only right after a clock word — a bare HH:MM is too common in scripted text. */
const LOCAL_TIME_SHORT = /(scheduled for|resets|reset estimated|重置|预计于|发送) (\d{2}:\d{2})/g;
/** `elapsed X.XX min` durations inside reminder/overtime texts → nearest 0.5 min. */
const ELAPSED_MIN = /elapsed (\d+\.\d+) min/g;
/** Keys whose numeric values are wall-clock instants → opaque `<key>` placeholder. */
const TIME_KEYS = new Set(["timestamp", "at", "startedAt", "runningSince", "created", "recordedAt", "since", "until", "end", "start"]);
/** Keys whose numeric values are measured durations in milliseconds → nearest 10 s buckets. */
const DURATION_MS_KEYS = new Set(["elapsedMs", "ms", "durationMs", "totalDurationMs", "timeUsedSeconds", "elapsedSeconds"]);
/** Host tool timings (bash wall time, shell trace nanoseconds): scheduler noise → opaque `<key>`. */
const TIMING_KEYS = new Set(["wallTimeMs", "ns", "t_ns", "dur_ns", "end_ns"]);
/** Provider latency figures: scheduler noise, not behavior → opaque `<key>`. */
const LATENCY_KEYS = new Set(["duration", "ttft"]);
/**
 * The host decides where an extension tool that shadows a built-in sits in the
 * tool list (declared deviation: under native todo, `todo` takes the built-in
 * slot). Every rendering of that position — the `toolOrder` line, the system
 * prompt's tool list and eval's tool-name list — drops `todo`, in both variants.
 */
const TODO_TOOL_LINE = /\n- [^\n`]+: `todo`/g;
const TODO_TOOL_NAME = /`todo`, /g;
/** Timings inside text: JSON embedded in strings, task-result durations, bash wall time. */
const EMBEDDED_ELAPSED = /(\\?"elapsedMs\\?": )\d+/g;
const TASK_DURATION = /duration=(\\?")\d+(?:\.\d+)?m?s/g;
/** The bash tool's elapsed-time footer. */
const BASH_WALL_TIME = /Wall time: \d+(?:\.\d+)? seconds/g;
/** The host's dump file for a failed provider request: epoch plus a random suffix. */
const RAW_HTTP_LOG = /(http-\d+-requests\/)<epoch>-[a-z0-9]+\.json/g;
/** Host-owned widgets whose timing relative to the run end is scheduler noise. */
const HOST_WIDGETS = new Set(["autoresearch"]);
/** Epoch milliseconds embedded in strings (2001–2286). */
const EPOCH_MS = /\b1\d{12}\b/g;
/** Keys whose string values are per-run identifiers; they share one namespace, so a parentId matches its entry id. */
const ID_KEYS = new Set([
	"id",
	"parentId",
	"sessionId",
	"toolCallId",
	"leafId",
	"budgetId",
	"deliveryId",
	"firstKeptEntryId",
	"parentSession",
	"entryId",
	"compactionId",
]);

class Placeholders {
	readonly #seen = new Map<string, string>();
	get(kind: string, value: string): string {
		const key = `${kind}\0${value}`;
		let placeholder = this.#seen.get(key);
		if (placeholder === undefined) {
			placeholder = `<${kind}#${[...this.#seen.keys()].filter((k) => k.startsWith(`${kind}\0`)).length + 1}>`;
			this.#seen.set(key, placeholder);
		}
		return placeholder;
	}
}

/** Commit ids from the run's own `git rev-list --all`, full sha first so the 7-char prefix never leaks. */
function readShas(dir: string): { full: string; short: string }[] {
	const file = path.join(dir, "git-shas.txt");
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => /^[0-9a-f]{40}$/.test(line))
		.map((full) => ({ full, short: full.slice(0, 7) }));
}

function normalizeString(value: string, names: Placeholders, shas: readonly { full: string; short: string }[]): string {
	let text = value
		.replace(TMP_ROOT, "<root>")
		.replace(UUID, (match) => names.get("uuid", match.toLowerCase()))
		.replace(ISO, "<iso>")
		.replace(EPOCH_MS, "<epoch>")
		.replace(ELAPSED_MIN, (_match, minutes: string) => `<elapsed·min~${(Math.round(Number(minutes) * 2) / 2).toFixed(1)}>`);
	for (const sha of shas) {
		const placeholder = names.get("sha", sha.full);
		text = text.split(sha.full).join(placeholder).split(sha.short).join(placeholder);
	}
	return text
		.replace(LOCAL_DATE, "<date>")
		.replace(LOCAL_TIME_FULL, "<time>")
		.replace(LOCAL_TIME_SHORT, (_match, prefix: string) => `${prefix} <clock>`)
		.replace(RAW_HTTP_LOG, "$1<dump>.json")
		.replace(TODO_TOOL_LINE, "")
		.replace(EMBEDDED_ELAPSED, "$1<ms>")
		.replace(TASK_DURATION, "duration=$1<ms>")
		.replace(BASH_WALL_TIME, "Wall time: <seconds>")
		.replace(TODO_TOOL_NAME, "");
}

function normalize(value: Json, names: Placeholders, shas: readonly { full: string; short: string }[], key?: string): Json {
	if (typeof value === "number") {
		if (key === undefined) return value;
		if (TIME_KEYS.has(key) || key.endsWith("At")) return `<${key}>`;
		if (DURATION_MS_KEYS.has(key)) return `<${key}~${Math.max(0, Math.round(value / 10_000) * 10)}s>`;
		if (LATENCY_KEYS.has(key) || TIMING_KEYS.has(key)) return `<${key}>`;
		return value;
	}
	if (typeof value === "string") {
		if (key !== undefined && ID_KEYS.has(key)) return names.get("id", value);
		// A digest of the system prompt, which the requests channel compares in full.
		if (key === "data" && /^[0-9a-f]{12,16}$/.test(value)) return "<digest>";
		return normalizeString(value, names, shas);
	}
	if (Array.isArray(value)) return value.map((item) => normalize(item, names, shas));
	if (value === null || typeof value !== "object") return value;
	const out: { [key: string]: Json } = {};
	for (const [k, v] of Object.entries(value)) out[k] = normalize(v, names, shas, k);
	return out;
}

function readJsonl(file: string): Json[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as Json);
}

function field(value: Json, key: string): Json | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value[key] : undefined;
}

/**
 * Provider requests: messages in full, tool definitions sorted by name; the
 * original tool order on its own line. Requests are grouped by model (stable,
 * in arrival order within a model): a subagent's model runs concurrently with
 * the main session's, so the global arrival order is scheduler noise.
 */
function requestsText(records: Json[], names: Placeholders, shas: readonly { full: string; short: string }[]): string {
	const perModel = new Map<string, number>();
	return [...records]
		.sort((a, b) => String(field(a, "model")).localeCompare(String(field(b, "model"))))
		.map((record) => {
			const model = String(field(record, "model"));
			const n = (perModel.get(model) ?? 0) + 1;
			perModel.set(model, n);
			const body = field(record, "body");
			const tools = field(body ?? null, "tools");
			const toolList = Array.isArray(tools) ? tools : [];
			const toolNames = toolList.map((tool) => field(field(tool, "function") ?? null, "name"));
			const sorted = [...toolList].sort((a, b) =>
				String(field(field(a, "function") ?? null, "name")).localeCompare(String(field(field(b, "function") ?? null, "name"))),
			);
			const shown = {
				model: field(record, "model") ?? null,
				scripted: field(record, "scripted") ?? null,
				status: field(record, "status") ?? null,
				toolOrder: toolNames.filter((name) => name !== "todo") as Json,
				toolChoice: field(body ?? null, "tool_choice") ?? null,
				messages: field(body ?? null, "messages") ?? null,
				tools: sorted,
			};
			return `### request ${model} ${n}\n${JSON.stringify(normalize(shown, names, shas), null, 2)}`;
		})
		.join("\n\n");
}

/** RPC frames that carry behavior; streaming deltas and cost telemetry are dropped. */
const EVENT_TYPES = new Set([
	"message_end",
	"tool_execution_start",
	"tool_execution_end",
	"extension_ui_request",
	"extension_error",
	"command_output",
	"stdout",
	"prompt_result",
	"agent_end",
]);

const PARALLEL_TOOL_FRAMES = new Set(["tool_execution_start", "tool_execution_end"]);
const byCallId = new Intl.Collator("en", { numeric: true });

/**
 * Tool calls of one assistant message run concurrently, so a run of adjacent
 * `tool_execution_start` (or `_end`) frames arrives in scheduler order. Each
 * such run is put in tool-call-id order (the mock's ids are deterministic)
 * before placeholders are numbered.
 */
function canonicalToolOrder(frames: Json[]): Json[] {
	const out: Json[] = [];
	let run: Json[] = [];
	const flush = (): void => {
		run.sort((a, b) => byCallId.compare(String(field(a, "toolCallId")), String(field(b, "toolCallId"))));
		out.push(...run);
		run = [];
	};
	for (const frame of frames) {
		const type = String(field(frame, "type"));
		if (run.length > 0 && (!PARALLEL_TOOL_FRAMES.has(type) || type !== String(field(run[0] ?? null, "type")))) flush();
		if (PARALLEL_TOOL_FRAMES.has(type)) run.push(frame);
		else out.push(frame);
	}
	flush();
	return out;
}

function eventsText(frames: Json[], names: Placeholders, shas: readonly { full: string; short: string }[]): string {
	return canonicalToolOrder(
		frames.filter((frame) => EVENT_TYPES.has(String(field(frame, "type"))) && !HOST_WIDGETS.has(String(field(frame, "widgetKey")))),
	)
		.map((frame) => JSON.stringify(normalize(frame, names, shas), null, 2))
		.join("\n");
}

function sessionText(dir: string, names: Placeholders, shas: readonly { full: string; short: string }[]): string {
	const parts: string[] = [];
	const visit = (file: string, label: string): void => {
		parts.push(`### ${label}`);
		for (const entry of readJsonl(file)) parts.push(JSON.stringify(normalize(entry, names, shas), null, 2));
	};
	const main = path.join(dir, "session", "main.jsonl");
	if (existsSync(main)) visit(main, "main");
	const children = path.join(dir, "session", "children");
	if (existsSync(children)) {
		for (const name of readdirSync(children, { recursive: true, encoding: "utf8" }).sort()) {
			const file = path.join(children, name);
			if (name.endsWith(".jsonl")) visit(file, `child ${name}`);
			else if (name.endsWith(".md")) parts.push(`### file ${name}\n${normalizeString(readFileSync(file, "utf8"), names, shas)}`);
		}
	}
	return parts.join("\n");
}

const [recording, out] = process.argv.slice(2);
if (recording === undefined || out === undefined) {
	console.error("usage: bun test/parity/normalize.ts <recording dir> <out dir>");
	process.exit(2);
}
let failed = false;
for (const scenario of readdirSync(recording).sort()) {
	const dir = path.join(recording, scenario);
	if (!existsSync(path.join(dir, "result.json"))) continue;
	const target = path.join(out, scenario);
	mkdirSync(target, { recursive: true });
	const shas = readShas(dir);
	// One placeholder space per channel file: numbering then depends only on that channel's own content.
	const files: [string, string][] = [
		["requests.txt", `${requestsText(readJsonl(path.join(dir, "requests.jsonl")), new Placeholders(), shas)}\n`],
		["events.txt", `${eventsText(readJsonl(path.join(dir, "events.jsonl")), new Placeholders(), shas)}\n`],
		["session.txt", `${sessionText(dir, new Placeholders(), shas)}\n`],
	];
	const git = path.join(dir, "git.txt");
	if (existsSync(git)) files.push(["git.txt", normalizeString(readFileSync(git, "utf8"), new Placeholders(), shas)]);
	let corpus = "";
	for (const [name, text] of files) {
		writeFileSync(path.join(target, name), text);
		corpus += text;
	}
	const wants = SCENARIOS.find((entry) => entry.name === scenario)?.expect ?? [];
	for (const needle of wants) {
		if (!corpus.includes(needle)) {
			console.error(`${scenario}: expected marker missing from normalized output: ${JSON.stringify(needle)}`);
			failed = true;
		}
	}
}
process.exit(failed ? 1 : 0);
