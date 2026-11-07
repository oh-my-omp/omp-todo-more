/**
 * Shared harness for `test/bench/post-compact-hint.ts` and
 * `test/post-compact-hint.test.ts`.
 *
 * The `context` handler runs through `registerPostCompactHint` against a real
 * `SessionManager.inMemory`, so leaf ids, `getBranchView` liveness and
 * `pi.appendEntry` → `appendCustomEntry` keep host semantics. Read accounting
 * is a Proxy over the view counting integer-index reads, plus a counter on
 * `getBranch()` copies.
 *
 * `referenceCall` is a verbatim copy of the pre-fix handler path (full
 * `getBranch()` copy + `boundaryState` over the whole branch). It is the
 * in-run baseline: same inputs, same outputs, so behavior equivalence and the
 * ≥10× cost drop do not depend on a separately measured baseline run.
 */

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { z } from "@oh-my-pi/pi-coding-agent";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { registerPostCompactHint } from "../src/ctx/post-compact-hint.ts";

export const SNAPSHOT_ENTRY_TYPE = "todo-more.post-compact-ctx";
export const CONTEXT_MESSAGE_TYPE = "todo-more.post-compact-ctx";
export const RICH_SNAPSHOT_TYPE = "mouriya.omp.todo-more";

const snapshotSchema = z.object({ compactionId: z.string(), text: z.string() });

type BoundaryState =
	| { readonly kind: "none" }
	| { readonly kind: "unrendered"; readonly compactionId: string }
	| { readonly kind: "rendered"; readonly compactionId: string; readonly text: string };

/** Verbatim pre-fix scan: walks the whole branch copy backwards. */
function referenceBoundaryState(branch: readonly SessionEntry[]): BoundaryState {
	let snapshot: { compactionId: string; text: string } | undefined;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry === undefined) continue;
		if (entry.type === "compaction") {
			if (snapshot?.compactionId === entry.id) return { kind: "rendered", compactionId: entry.id, text: snapshot.text };
			return { kind: "unrendered", compactionId: entry.id };
		}
		if (snapshot === undefined && entry.type === "custom" && entry.customType === SNAPSHOT_ENTRY_TYPE) {
			const parsed = snapshotSchema.safeParse(entry.data);
			if (parsed.success) snapshot = parsed.data;
		}
	}
	return { kind: "none" };
}

/** Verbatim pre-fix `withPayload`. */
function referenceWithPayload(messages: AgentMessage[], text: string): AgentMessage[] {
	const payload: AgentMessage = {
		role: "custom",
		customType: CONTEXT_MESSAGE_TYPE,
		content: text,
		display: false,
		attribution: "agent",
		timestamp: 0,
	};
	const at = messages.findLastIndex((message) => message.role === "compactionSummary") + 1;
	return [...messages.slice(0, at), payload, ...messages.slice(at)];
}

export type ContextResult = { readonly messages?: AgentMessage[] } | undefined;

/**
 * The pre-fix handler: `getBranch()` copy, full scan, then the same switch.
 * The `unrendered` arm cannot re-render without the real inventory; it
 * returns `undefined`, matching the observable outcome of a render failure.
 */
export function referenceCall(fixture: Fixture, event: { type: "context"; messages: AgentMessage[] }): ContextResult {
	const state = referenceBoundaryState(fixture.session.getBranch());
	switch (state.kind) {
		case "none":
			return undefined;
		case "rendered":
			return { messages: referenceWithPayload(event.messages, state.text) };
		case "unrendered":
			return undefined;
	}
}

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

export type Fixture = {
	readonly pi: ExtensionAPI;
	readonly ctx: ExtensionContext;
	/** Counting proxy over the real manager — what `ctx.sessionManager` sees; `referenceCall` uses it so the copy is counted. */
	readonly session: SessionManager;
	/** The unproxied manager for appends and branch construction. */
	readonly raw: SessionManager;
	readonly counters: { reads: number; copies: number };
	/** Handler warnings recorded from `pi.logger.warn`; empty means no caught error. */
	readonly warnings: string[];
	countedView(): readonly SessionEntry[];
	call(messages?: AgentMessage[]): Promise<ContextResult>;
	append(data: { compactionId: string; text: string }): string;
	resetCounters(): void;
};

const isIndex = (prop: string | symbol): prop is string =>
	typeof prop === "string" && prop !== "" && String(Math.trunc(Number(prop))) === prop && Number(prop) >= 0;

export function fixture(dir: string): Fixture {
	const manager = SessionManager.inMemory(dir);
	const handlers = new Map<string, Handler[]>();
	const counters = { reads: 0, copies: 0 };
	const warnings: string[] = [];
	let rawView: readonly SessionEntry[] | undefined;
	let counted: readonly SessionEntry[] | undefined;

	const countedView = (): readonly SessionEntry[] => {
		const raw = manager.getBranchView();
		if (raw !== rawView) {
			rawView = raw;
			counted = new Proxy(raw, {
				get(target, prop, receiver) {
					if (isIndex(prop)) counters.reads += 1;
					return Reflect.get(target, prop, receiver);
				},
			});
		}
		return counted ?? raw;
	};

	const session = new Proxy(manager, {
		get(target, prop, receiver) {
			if (prop === "getBranch")
				return () => {
					counters.copies += 1;
					return target.getBranch();
				};
			if (prop === "getBranchView") return countedView;
			const value = Reflect.get(target, prop, receiver);
			// Methods touch private fields: bind to the real manager or the
			// proxy `this` throws inside the handler's catch.
			return typeof value === "function" ? value.bind(target) : value;
		},
	});

	const pi = {
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		appendEntry: (customType: string, data?: unknown) => {
			manager.appendCustomEntry(customType, data);
		},
		logger: {
			info: () => {},
			// A caught handler error must surface to the scenario instead of
			// passing silently as an undefined result.
			warn: (...args: unknown[]) => warnings.push(args.map(String).join(" ")),
		},
	} as unknown as ExtensionAPI;

	registerPostCompactHint(pi);

	const ctx = {
		agent: { kind: "main", id: "bench-main", name: "main", depth: 0 },
		sessionManager: session,
	} as unknown as ExtensionContext;

	return {
		pi,
		ctx,
		session,
		raw: manager,
		counters,
		warnings,
		countedView,
		async call(messages = defaultMessages(manager)) {
			const event = { type: "context", messages };
			let result: ContextResult;
			for (const handler of handlers.get("context") ?? []) result = (await handler(event, ctx)) as ContextResult;
			return result;
		},
		append: (data) => manager.appendCustomEntry(SNAPSHOT_ENTRY_TYPE, data),
		resetCounters: () => {
			counters.reads = 0;
			counters.copies = 0;
		},
	};
}

const text = (body: string): { type: "text"; text: string } => ({ type: "text", text: body });

function defaultMessages(manager: SessionManager): AgentMessage[] {
	const messages: AgentMessage[] = [];
	if (manager.getBranchView().some((entry) => entry.type === "compaction")) {
		messages.push({ role: "compactionSummary", summary: "compacted", tokensBefore: 100_000, timestamp: 0 } as AgentMessage);
	}
	messages.push({ role: "user", content: [text("prompt")], timestamp: 0 } as AgentMessage);
	return messages;
}

/** One plain message entry; `toolName` picks user/assistant/toolResult shape. */
export function messageEntry(manager: SessionManager, index: number): string {
	const timestamp = 1_700_000_000_000 + index;
	if (index % 17 === 0) {
		return manager.appendMessage({
			role: "toolResult",
			toolName: index % 85 === 0 ? "todo" : "read",
			toolCallId: `call-${index}`,
			content: [text(`result ${index}`)],
			details: {},
			isError: false,
			timestamp,
		});
	}
	if (index % 2 === 0) return manager.appendMessage({ role: "user", content: [text(`prompt ${index}`)], timestamp });
	return manager.appendMessage({
		role: "assistant",
		content: [text(`reply ${index}`)],
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
			manager.appendCustomEntry(RICH_SNAPSHOT_TYPE, { phases: [] });
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

/** §4 compaction variant: one compaction plus its rendered snapshot entry. */
export function appendCompactionWithSnapshot(
	manager: SessionManager,
	text = "<post-compact-ctx>\nrendered snapshot\n</post-compact-ctx>",
): void {
	const compactionId = manager.appendCompaction("summary", undefined, manager.getLeafId() ?? "", 100_000);
	manager.appendCustomEntry(SNAPSHOT_ENTRY_TYPE, { compactionId, text });
}
