/**
 * Branch-reader regression (oh-my-omp/omp-todo-more#25): the single-pass
 * readers must equal the plain reads they replace, at every position, and the
 * reads must stay cheap — non-todo messages never reach the schema parser, and
 * one `readTodoMore` walks the whole branch at most once however many native
 * records join.
 */

import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { askWaits, readTodoMore, readTodoMoreWithWaits, TODO_MORE_ENTRY_TYPE, todoMoreHistory } from "../src/state.ts";
import { at, branch, counted, nativeEntry, snapshotData } from "./bench/branch.ts";

const iso = (index: number): string => new Date(at(index)).toISOString();
const meta = (index: number) => ({ id: `x${index}`, parentId: index === 0 ? null : `x${index - 1}`, timestamp: iso(index) });

/** Hand-built edge cases, in branch order; indices are positions. */
function edgeBranch(): SessionEntry[] {
	const entries: SessionEntry[] = [];
	const push = (make: (index: number) => SessionEntry): void => {
		entries.push(make(entries.length));
	};
	const askStart = (id: string) => (index: number) =>
		({
			type: "custom",
			customType: "tool_execution_start",
			data: { toolCallId: id, toolName: "ask", startedAt: iso(index) },
			...meta(index),
		}) as SessionEntry;
	const askResult = (id: string) => (index: number) =>
		({
			type: "message",
			message: { role: "toolResult", toolCallId: id, toolName: "ask", content: [], isError: false, timestamp: at(index) },
			...meta(index),
		}) as SessionEntry;
	const user = (index: number) =>
		({ type: "message", message: { role: "user", content: "same", timestamp: 5 }, ...meta(index) }) as SessionEntry;
	push(user);
	push((index) => ({ type: "custom", customType: TODO_MORE_ENTRY_TYPE, data: snapshotData(index, 4, 2), ...meta(index) }));
	push(askStart("a1"));
	push((index) => nativeEntry(index, 1));
	push(user);
	push(askResult("a1"));
	push(askStart("a2"));
	push((index) => ({ type: "custom", customType: "session_exit", data: {}, ...meta(index) }));
	push(askResult("a2"));
	// A marked todo-more result whose details would fail the schema, and an unmarked broken one.
	push(
		(index) =>
			({
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "t",
					toolName: "todo",
					content: [],
					details: { todoMore: true },
					isError: false,
					timestamp: at(index),
				},
				...meta(index),
			}) as SessionEntry,
	);
	push(
		(index) =>
			({
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "t2",
					toolName: "todo",
					content: [],
					details: { op: "add" },
					isError: false,
					timestamp: at(index),
				},
				...meta(index),
			}) as SessionEntry,
	);
	push(askStart("a3"));
	push((index) => nativeEntry(index, 2));
	// An empty native record ends the join; a later native starts from empty.
	push((index) => ({ type: "custom", customType: "user_todo_edit", data: { phases: [{ name: "Work", tasks: [] }] }, ...meta(index) }));
	push((index) => nativeEntry(index, 3));
	push((index) => ({ type: "custom", customType: TODO_MORE_ENTRY_TYPE, data: { goal: 1 }, ...meta(index) }));
	push((index) => ({ type: "custom", customType: TODO_MORE_ENTRY_TYPE, data: snapshotData(index, 3, 1), ...meta(index) }));
	push((index) => nativeEntry(index, 4));
	// An ask recorded after that native record but stamped before it (clock skew): only
	// prefixes that include it may count it, so prefix waits must stop at the position.
	push(
		(index) =>
			({
				type: "custom",
				customType: "tool_execution_start",
				data: { toolCallId: "a4", toolName: "ask", startedAt: iso(-20) },
				...meta(index),
			}) as SessionEntry,
	);
	push(askResult("a4"));
	push((index) => nativeEntry(index, 5));
	return entries;
}

const loads: [string, () => SessionEntry[]][] = [
	["edge", edgeBranch],
	["empty", () => []],
	["no snapshot", () => branch({ n: 800, snapshotEvery: 0 })],
	["natives and corrupt", () => branch({ n: 1_200, snapshotEvery: 150, tail: 500, natives: 25, corrupt: 0.08, inProgress: 2 })],
];

describe("todoMoreHistory", () => {
	for (const [name, load] of loads) {
		test(`every position equals readTodoMore(prefix): ${name}`, () => {
			const entries = load();
			const history = todoMoreHistory(entries);
			for (let index = -1; index <= entries.length; index++) {
				expect(history.at(index)).toEqual(readTodoMore(entries.slice(0, Math.max(0, index + 1))));
			}
		});
	}

	test("positions with the same records share one state object", () => {
		const entries = branch({ n: 900, snapshotEvery: 300, tail: 200 });
		const history = todoMoreHistory(entries);
		expect(history.at(500)).toBe(history.at(520));
	});

	test("the build is one forward pass and visits every entry once", () => {
		const entries = branch({ n: 2_000, natives: 10 });
		const reads = counted(entries);
		const visited: number[] = [];
		const history = todoMoreHistory(reads.entries, (_entry, index) => visited.push(index));
		expect(reads.counters.passes).toBe(1);
		expect(visited).toEqual(entries.map((_entry, index) => index));
		for (const index of [100, 1_000, 1_999]) history.at(index);
		expect(reads.counters.passes).toBe(1);
	});
});

describe("readTodoMoreWithWaits", () => {
	for (const [name, load] of loads) {
		test(`equals readTodoMore + askWaits in one pass: ${name}`, () => {
			const entries = load();
			const reads = counted(entries);
			const read = readTodoMoreWithWaits(reads.entries);
			expect(read.state).toEqual(readTodoMore(entries));
			expect(read.waits).toEqual(askWaits(entries));
			expect(reads.counters.passes).toBe(entries.length === 0 ? 0 : 1);
		});
	}
});

describe("readTodoMore", () => {
	test("non-todo messages never reach the schema parser", () => {
		const parsed = new Set<string>();
		const entries = branch({ n: 3_000, snapshotEvery: 0 }).map((entry): SessionEntry => {
			if (entry.type !== "message") return entry;
			const message = new Proxy(entry.message, {
				ownKeys(target) {
					parsed.add(entry.id);
					return Reflect.ownKeys(target);
				},
			});
			return { ...entry, message };
		});
		readTodoMore(entries);
		expect([...parsed]).toEqual([]);
	});

	test("joined native records read the ask waits once", () => {
		const entries = branch({ n: 3_000, natives: 40 });
		const reads = counted(entries);
		const state = readTodoMore(reads.entries);
		expect(state.kind).toBe("list");
		expect(reads.counters.passes).toBe(1);
	});
});
