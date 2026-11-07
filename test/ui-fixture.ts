/**
 * Shared harness for `test/bench/ui.ts` and `test/ui-offset.test.ts`.
 *
 * `TodoHud`/`TodoPanel` run against a real `SessionManager.inMemory`, so
 * leaf ids, `getBranchView` liveness and navigation keep host semantics.
 * Read accounting is a Proxy over the manager: counters on `getBranch()`
 * copies and `getBranchView()` calls, plus a counting proxy over the view
 * array for integer-index entry reads.
 *
 * Behavior equivalence is checked against a freshly constructed component
 * on the same branch, and against the base checkout: run the same bench
 * scenario with `--base <dir>` pointing at an `origin/main` checkout (see
 * `test/bench/ui.ts`), which loads that checkout's `src/ui.ts` for the
 * baseline side of the comparison.
 */
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { Theme, TUI } from "@oh-my-pi/pi-tui";
import { readTodoMore, toSnapshot } from "../src/state.ts";

export const RICH_SNAPSHOT_TYPE = "mouriya.omp.todo-more";

export type UiFixture = {
	readonly manager: SessionManager;
	readonly raw: SessionManager;
	readonly session: AgentSession;
	readonly counters: { copies: number; views: number; reads: number };
	resetCounters(): void;
	theme(): Theme;
	tui(): TUI;
};

const isIndex = (prop: string | symbol): prop is string =>
	typeof prop === "string" && prop !== "" && String(Math.trunc(Number(prop))) === prop && Number(prop) >= 0;

/** Counting-proxy fixture: `session` sees instrumented reads; `raw` appends. */
export function fixture(dir: string): UiFixture {
	const manager = SessionManager.inMemory(dir);
	const counters = { copies: 0, views: 0, reads: 0 };
	let rawView: readonly unknown[] | undefined;
	let counted: readonly unknown[] | undefined;

	const countedView = (): readonly unknown[] => {
		const view = manager.getBranchView();
		if (view !== (rawView as unknown)) {
			rawView = view as unknown as readonly unknown[];
			counted = new Proxy(view, {
				get(target, prop, receiver) {
					if (isIndex(prop)) counters.reads += 1;
					return Reflect.get(target, prop, receiver);
				},
			}) as unknown as readonly unknown[];
		}
		return counted ?? (view as unknown as readonly unknown[]);
	};

	const proxied = new Proxy(manager, {
		get(target, prop, receiver) {
			if (prop === "getBranch")
				return () => {
					counters.copies += 1;
					return target.getBranch();
				};
			if (prop === "getBranchView") {
				counters.views += 1;
				return countedView;
			}
			const value = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});

	return {
		manager: proxied as unknown as SessionManager,
		raw: manager,
		session: { sessionManager: proxied } as unknown as AgentSession,
		counters,
		resetCounters: () => {
			counters.copies = 0;
			counters.views = 0;
			counters.reads = 0;
		},
		theme: () =>
			({
				bold: (value: string) => value,
				fg: (_color: string, value: string) => value,
			}) as unknown as Theme,
		tui: () => ({ requestRender() {}, requestComponentRender() {} }) as unknown as TUI,
	};
}

/** One plain message entry; `toolName` picks user/assistant/toolResult shape. */
export function messageEntry(manager: SessionManager, index: number): string {
	const timestamp = 1_700_000_000_000 + index;
	if (index % 17 === 0) {
		return manager.appendMessage({
			role: "toolResult",
			toolName: index % 85 === 0 ? "todo" : "read",
			toolCallId: `call-${index}`,
			content: [{ type: "text", text: `result ${index}` }],
			details: {},
			isError: false,
			timestamp,
		});
	}
	if (index % 2 === 0) return manager.appendMessage({ role: "user", content: [{ type: "text", text: `prompt ${index}` }], timestamp });
	return manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: `reply ${index}` }],
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	});
}

/**
 * §4 branch: N entries, mostly user/assistant/toolResult (todo toolName rare),
 * `tool_execution_start`/`session_exit` customs and a rich todo-more snapshot
 * about every 300 entries; the tail after the last rich snapshot stays plain.
 */
export function fillBranch(manager: SessionManager, count: number): void {
	const richUntil = count - Math.max(500, Math.floor(count * 0.08));
	for (let i = 0; i < count; i++) {
		if (i % 300 === 0 && i < richUntil) {
			manager.appendCustomEntry(RICH_SNAPSHOT_TYPE, {
				goal: { objective: "Ship it", measure: "Done", doneWhen: "Merged" },
				phases: [
					{
						name: "Delivery",
						items: [{ title: `Task ${i}`, explanation: `Work ${i}`, status: "in_progress", time: { kind: "missing" } }],
					},
				],
			});
		} else if (i % 311 === 0) {
			manager.appendCustomEntry("tool_execution_start", {
				toolCallId: `t-${i}`,
				toolName: i % 2 ? "read" : "ask",
				startedAt: new Date(1_700_000_000_000 + i).toISOString(),
			});
		} else if (i % 911 === 0) {
			manager.appendCustomEntry("session_exit", {});
		} else {
			messageEntry(manager, i);
		}
	}
}

/**
 * A genuine todo change: appends a new rich snapshot entry (what the tool
 * writes on every mutation). Plain message entries do not move the todo
 * state — the HUD/panel must still re-derive (offset miss), but their
 * output only changes when the snapshot does.
 */
export function appendTodoChange(manager: SessionManager, title: string): void {
	const snapshot = toSnapshot(readTodoMore(manager.getBranchView()));
	const phases =
		snapshot.phases.length === 0
			? [{ name: "Delivery", items: [] }]
			: snapshot.phases.map((phase) => ({ name: phase.name, items: [...phase.items] }));
	const first = phases[0];
	if (first === undefined) throw new Error("Expected at least one phase");
	first.items.push({ title, explanation: "appended", status: "pending", time: { kind: "missing" } });
	manager.appendCustomEntry(RICH_SNAPSHOT_TYPE, { goal: snapshot.goal, phases });
}
