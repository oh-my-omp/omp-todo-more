/**
 * The #24 §4 benchmark load, shared by the `test/bench/*` scripts of the
 * oh-my-omp/omp-todo-more#24 tree: a synthetic session branch handed to the
 * code under test as a plain `SessionEntry[]` (no SessionManager).
 *
 * Shape: mostly message entries (user / assistant / toolResult; tool results
 * are mostly non-`todo` tools, with marked todo-more `todo` results after each
 * snapshot and `ask` results paired with a host `tool_execution_start`), sparse
 * `tool_execution_start` / `session_exit` customs, a `mouriya.omp.todo-more`
 * rich snapshot about every `snapshotEvery` entries, and a tail of `tail`
 * non-snapshot entries after the newest snapshot. Options add native records
 * (`user_todo_edit`) to the tail, a compaction with its post-compact-ctx entry,
 * or replace a fraction of entries with corrupt and unrelated shapes.
 *
 * Everything is deterministic: the same options give the same entries.
 */

import { mkdirSync, symlinkSync } from "node:fs";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";

export const RICH_TYPE = "mouriya.omp.todo-more";
export const USER_EDIT_TYPE = "user_todo_edit";
export const POST_COMPACT_TYPE = "todo-more.post-compact-ctx";
export const OVERTIME_TYPE = `${RICH_TYPE}.overtime`;
const T0 = 1_700_000_000_000;
const STEP_MS = 1_000;

export type BranchOptions = {
	/** Total entries. */
	readonly n: number;
	/** A rich snapshot about every this many entries; 0 writes none. */
	readonly snapshotEvery?: number;
	/** Non-snapshot entries after the newest snapshot. */
	readonly tail?: number;
	/** Native `user_todo_edit` records spread over the tail. */
	readonly natives?: number;
	/** Append a compaction entry and its post-compact-ctx snapshot entry. */
	readonly compaction?: boolean;
	/** Fraction of entries replaced by corrupt or unrelated shapes. */
	readonly corrupt?: number;
	/** In-progress items in each snapshot (they carry a running budget). */
	readonly inProgress?: number;
};

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** A deterministic PRNG (mulberry32): the same seed gives the same branch. */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

export const at = (index: number): number => T0 + index * STEP_MS;
const iso = (index: number): string => new Date(at(index)).toISOString();

const TOOLS = ["read", "bash", "grep", "edit", "find", "write", "task", "eval"];

function base(index: number): { id: string; parentId: string | null; timestamp: string } {
	return { id: `e${index}`, parentId: index === 0 ? null : `e${index - 1}`, timestamp: iso(index) };
}

/** Snapshot phases: `items` items, the first `inProgress` of them running since a minute before `index`. */
export function snapshotData(index: number, items = 6, inProgress = 1): unknown {
	return {
		goal: { objective: "Ship the feature", measure: "Tests pass", doneWhen: "Merged" },
		phases: [
			{
				name: "Work",
				items: Array.from({ length: items }, (_, item) => ({
					title: `Task ${item}`,
					explanation: item % 3 === 2 ? null : `Explain task ${item}`,
					status: item < inProgress ? "in_progress" : item % 4 === 3 ? "completed" : "pending",
					time:
						item % 5 === 4
							? { kind: "missing" }
							: {
									kind: "estimated",
									budgetId: `b${index}-${item}`,
									minutes: 5 + item,
									elapsedMs: item * 1_000,
									runningSince: item < inProgress ? at(index) - 60_000 : null,
								},
				})),
			},
		],
	};
}

function richEntry(index: number, inProgress: number): SessionEntry {
	return { type: "custom", customType: RICH_TYPE, data: snapshotData(index, 6, inProgress), ...base(index) };
}

/** The marked tool result todo-more writes after its snapshot (the reader skips it). */
function markedTodoResult(index: number): SessionEntry {
	return {
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: `call-${index}`,
			toolName: "todo",
			content: [{ type: "text", text: "Todo updated" }],
			details: { op: "add", phases: [{ name: "Work", tasks: [{ content: "Task 0", status: "in_progress" }] }], todoMore: true },
			isError: false,
			timestamp: at(index),
		},
		...base(index),
	};
}

/** A host `/todo` edit: the native record the reader joins onto the newest rich snapshot. */
export function nativeEntry(index: number, extra = 0): SessionEntry {
	return {
		type: "custom",
		customType: USER_EDIT_TYPE,
		data: {
			phases: [
				{
					name: "Work",
					tasks: [
						{ content: "Task 0", status: index % 2 === 0 ? "in_progress" : "completed" },
						{ content: "Task 1", status: "pending" },
						{ content: `Native ${index}-${extra}`, status: "pending" },
					],
				},
			],
		},
		...base(index),
	};
}

function userEntry(index: number): SessionEntry {
	return {
		type: "message",
		message: { role: "user", content: [{ type: "text", text: `user message ${index}` }], timestamp: at(index) },
		...base(index),
	};
}

function assistantEntry(index: number): SessionEntry {
	return {
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: `assistant reply ${index} `.repeat(4) }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "bench",
			usage: {
				input: 10,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 20,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: at(index),
		},
		...base(index),
	} as SessionEntry;
}

function toolResultEntry(index: number, toolName: string, callId = `call-${index}`): SessionEntry {
	return {
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: callId,
			toolName,
			content: [{ type: "text", text: `${toolName} output ${index}`.repeat(3) }],
			details: { exitCode: 0 },
			isError: false,
			timestamp: at(index),
		},
		...base(index),
	};
}

function toolStartEntry(index: number, toolName: string, callId: string): SessionEntry {
	return {
		type: "custom",
		customType: "tool_execution_start",
		data: { toolCallId: callId, toolName, startedAt: iso(index) },
		...base(index),
	};
}

function sessionExitEntry(index: number): SessionEntry {
	return { type: "custom", customType: "session_exit", data: { reason: "exit" }, ...base(index) };
}

/** Shapes the reader must skip: broken records and unrelated entries. */
function corruptEntry(index: number, pick: number): SessionEntry {
	switch (pick % 7) {
		case 0:
			return { type: "custom", customType: RICH_TYPE, data: { goal: 5, phases: "broken" }, ...base(index) };
		case 1:
			return { type: "custom", customType: USER_EDIT_TYPE, data: { phases: [{ name: 3 }] }, ...base(index) };
		case 2: {
			const entry = toolResultEntry(index, "todo") as Mutable<SessionEntry> & { message: { details: unknown } };
			entry.message.details = { op: "add" };
			return entry;
		}
		case 3: {
			const entry = toolResultEntry(index, "todo") as Mutable<SessionEntry> & { message: { isError: boolean; details: unknown } };
			entry.message.details = { op: "add", phases: [{ name: "Work", tasks: [{ content: "Err", status: "pending" }] }] };
			entry.message.isError = true;
			return entry;
		}
		case 4:
			return { type: "custom", customType: "tool_execution_start", data: { toolName: "ask" }, ...base(index) };
		case 5:
			return { type: "label", targetId: "e0", label: "mark", ...base(index) };
		default: {
			const entry = toolResultEntry(index, "todo") as Mutable<SessionEntry> & { message: { details: unknown } };
			entry.message.details = { op: "view", phases: [{ name: "Work", tasks: [{ content: "Viewed", status: "pending" }] }] };
			return entry;
		}
	}
}

/** One ordinary entry at `index`: the rotating message mix plus sparse customs and ask pairs. */
function ordinaryEntry(index: number, out: SessionEntry[]): void {
	const slot = index % 40;
	if (slot === 0) out.push(userEntry(index));
	else if (slot === 17) out.push(toolStartEntry(index, "ask", `ask-${index}`));
	else if (slot === 19) out.push(toolResultEntry(index, "ask", `ask-${index - 2}`));
	else if (slot === 29) out.push(toolStartEntry(index, TOOLS[index % TOOLS.length] ?? "read", `call-${index + 1}`));
	else if (index % 997 === 0) out.push(sessionExitEntry(index));
	else if (slot % 2 === 1) out.push(assistantEntry(index));
	else out.push(toolResultEntry(index, TOOLS[index % TOOLS.length] ?? "read"));
}

/** The §4 branch for `options`, oldest first. */
export function branch(options: BranchOptions): SessionEntry[] {
	const { n, snapshotEvery = 300, tail = 1_000, natives = 0, compaction = false, corrupt = 0, inProgress = 1 } = options;
	const lastSnapshot = snapshotEvery > 0 ? Math.max(0, n - tail - 1) : -1;
	const nativeEvery = natives > 0 ? Math.max(1, Math.floor(tail / (natives + 1))) : 0;
	const rand = random(n * 31 + Math.round(corrupt * 1_000));
	const out: SessionEntry[] = [];
	let nativesLeft = natives;
	for (let index = 0; out.length < n; index = out.length) {
		const inTail = index > lastSnapshot && lastSnapshot >= 0;
		const isSnapshot = snapshotEvery > 0 && index > 0 && (index === lastSnapshot || (index < lastSnapshot && index % snapshotEvery === 0));
		if (isSnapshot) {
			out.push(richEntry(index, inProgress));
			if (out.length < n) out.push(markedTodoResult(out.length));
		} else if (inTail && nativesLeft > 0 && nativeEvery > 0 && (index - lastSnapshot) % nativeEvery === 0) {
			out.push(nativeEntry(index, nativesLeft));
			nativesLeft--;
		} else if (corrupt > 0 && rand() < corrupt) {
			out.push(corruptEntry(index, Math.floor(rand() * 1_000)));
		} else {
			ordinaryEntry(index, out);
		}
	}
	if (compaction) {
		const index = out.length;
		out.push({
			type: "compaction",
			summary: "compacted",
			firstKeptEntryId: `e${Math.max(0, index - 50)}`,
			tokensBefore: 100_000,
			...base(index),
		} as SessionEntry);
		out.push({ type: "custom", customType: POST_COMPACT_TYPE, data: { compactionId: `e${index}`, text: "ctx" }, ...base(index + 1) });
	}
	return out;
}

/** Element-read accounting over a branch: `reads` integer-index reads, `passes` reads of index 0 (one per whole-branch walk). */
export type ReadCounters = { reads: number; passes: number };

/** `entries` behind a Proxy that counts element reads; iteration reads through the same trap. */
export function counted(entries: readonly SessionEntry[]): { readonly entries: readonly SessionEntry[]; readonly counters: ReadCounters } {
	const counters: ReadCounters = { reads: 0, passes: 0 };
	const proxy = new Proxy(entries, {
		get(target, key, receiver) {
			if (typeof key === "string" && key.length > 0 && key.charCodeAt(0) >= 48 && key.charCodeAt(0) <= 57) {
				counters.reads++;
				if (key === "0") counters.passes++;
			}
			return Reflect.get(target, key, receiver);
		},
	});
	return { entries: proxy, counters };
}

/** The audit anchor (oh-my-omp/omp-todo-more#24, `origin/main` when the tree was written): the pre-change baseline. */
export const ANCHOR = "4520843c5c1599801d37cba099c3d53dbdd87239";

/**
 * A module of the anchor commit, imported from a clean extraction of its
 * `src/` (git archive, no worktree) next to this checkout's `node_modules`.
 */
export async function anchorModule<T>(path: string): Promise<T> {
	const repo = new URL("../..", import.meta.url).pathname;
	const dir = `/tmp/omp-todo-more-anchor-${ANCHOR.slice(0, 12)}`;
	if (!(await Bun.file(`${dir}/.extracted`).exists())) {
		mkdirSync(dir, { recursive: true });
		const archive = Bun.spawnSync(["git", "-C", repo, "archive", ANCHOR, "src", "index.ts", "package.json"], { stdout: "pipe" });
		if (archive.exitCode !== 0) throw new Error(`git archive ${ANCHOR} failed: ${archive.stderr.toString()}`);
		const untar = Bun.spawnSync(["tar", "-x", "-C", dir], { stdin: archive.stdout });
		if (untar.exitCode !== 0) throw new Error(`tar -x failed: ${untar.stderr.toString()}`);
		symlinkSync(`${repo}node_modules`, `${dir}/node_modules`);
		await Bun.write(`${dir}/.extracted`, ANCHOR);
	}
	// The extraction directory is chosen at run time; no static specifier can name it.
	return (await import(`${dir}/${path}`)) as T;
}

export function median(values: readonly number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Command-line flags as `--name value` pairs; a flag without a value reads as "true". */
export function flags(argv: readonly string[]): Map<string, string> {
	const parsed = new Map<string, string>();
	for (let index = 2; index < argv.length; index++) {
		const name = argv[index] ?? "";
		if (!name.startsWith("--")) continue;
		const value = argv[index + 1];
		if (value === undefined || value.startsWith("--")) parsed.set(name, "true");
		else {
			parsed.set(name, value);
			index++;
		}
	}
	return parsed;
}
