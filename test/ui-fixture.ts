import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { TodoPhase as HostTodoPhase } from "@oh-my-pi/pi-coding-agent/tools/details/todo";
import { foldBranch } from "../src/branch.ts";
import { FRESH, hostPhases, TODO_NG_NOTES_TYPE } from "../src/state.ts";
import { todoResultMessage } from "./host.ts";

export type UiFixture = {
	readonly manager: SessionManager;
	readonly raw: SessionManager;
	readonly session: AgentSession;
	readonly counters: { copies: number; views: number; reads: number };
	resetCounters(): void;
};

const isIndex = (prop: string | symbol): prop is string =>
	typeof prop === "string" && prop !== "" && String(Math.trunc(Number(prop))) === prop && Number(prop) >= 0;

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

	let cachedPhases: HostTodoPhase[] = [];
	let cachedAt: { readonly length: number; readonly leaf: string | null } | undefined;

	const hostPhasesNow = (): HostTodoPhase[] => {
		const view = proxied.getBranchView();
		const leaf = proxied.getLeafId();
		if (cachedAt !== undefined && cachedAt.length === view.length && cachedAt.leaf === leaf) return cachedPhases;
		cachedPhases = hostPhases(foldBranch(view).state);
		cachedAt = { length: view.length, leaf };
		return cachedPhases;
	};

	return {
		manager: proxied as unknown as SessionManager,
		raw: manager,
		session: {
			sessionManager: proxied,
			getTodoPhases: hostPhasesNow,
			setTodoPhases: (phases: HostTodoPhase[]) => {
				cachedPhases = structuredClone(phases);
				cachedAt = { length: proxied.getBranchView().length, leaf: proxied.getLeafId() };
			},
		} as unknown as AgentSession,
		counters,
		resetCounters: () => {
			counters.copies = 0;
			counters.views = 0;
			counters.reads = 0;
		},
	};
}

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

export function fillBranch(manager: SessionManager, count: number): void {
	const richUntil = count - Math.max(500, Math.floor(count * 0.08));
	for (let i = 0; i < count; i++) {
		if (i % 300 === 0 && i < richUntil) {
			manager.appendCustomEntry(TODO_NG_NOTES_TYPE, {
				goal: { objective: "Ship it", measure: "Done", doneWhen: "Merged" },
				items: [
					{
						id: `t${i + 1}`,
						phase: "Delivery",
						title: `Task ${i}`,
						explanation: `Work ${i}`,
						estimate: { kind: "missing" },
						progress: FRESH,
						commit: null,
					},
				],
			});
			manager.appendMessage(
				todoResultMessage(
					{ op: "batch", phases: [{ name: "Delivery", tasks: [{ content: `Task ${i}`, status: "in_progress" }] }] },
					1_700_000_000_000 + i,
				),
			);
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

export function appendTodoChange(manager: SessionManager, title: string): void {
	const phases = hostPhases(foldBranch(manager.getBranchView()).state);
	const first = phases[0] ?? { name: "Delivery", tasks: [] };
	const rest = phases.slice(1);
	const changed = [{ name: first.name, tasks: [...first.tasks, { content: title, status: "pending" as const }] }, ...rest];
	manager.appendMessage(todoResultMessage({ op: "batch", phases: changed }, Date.now()));
}
