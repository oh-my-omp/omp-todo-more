/**
 * Combined bench for the #24 tree (oh-my-omp/omp-todo-more#32, row 1): the
 * four per-trigger paths on the same §4 load, for any checkout.
 *
 * Load: `fillBranch` (§4: mostly user/assistant/toolResult, sparse
 * `tool_execution_start`/`session_exit`, a rich snapshot about every 300
 * entries, a plain tail of max(500, 8%·n)) on a real in-memory
 * `SessionManager`, built once per path and size from this checkout's fixture
 * so every checkout reads identical entries.
 *
 * Paths, each driven through the checkout's own entry point; a round appends
 * one entry and fires one trigger, timed together (the steady state of a live
 * session; a checkout may react inside the append itself):
 *   context  — `registerPlanning` `context` handler over the branch's last 20
 *              human messages;
 *   todo     — `runTodo` with an `EXPLAIN` that rewrites the current item;
 *   hud      — `TodoHud.describe()`;
 *   overtime — `registerOvertime` reschedule woken by a todo write: the
 *              round appends a rich snapshot with a running estimate instead
 *              of a plain entry and emits the `todo` tool result, measured to
 *              the drained microtask.
 *
 * Metrics per path and size: the cold first round's time and allocator growth
 * (`bun:jsc` `memoryUsage().current` after a full GC right before it), the
 * median steady-state round time, and the allocator growth of a further batch
 * of steady rounds divided by its size (no GC inside the batch).
 *
 *   bun test/bench/tree.ts [--src <checkout>] [--n 5000,10000] [--rounds 200]
 */
import { fullGC, memoryUsage } from "bun:jsc";
import path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { fillBranch, messageEntry, RICH_SNAPSHOT_TYPE } from "../ui-fixture.ts";

const args = new Map<string, string>();
for (let i = 2; i < Bun.argv.length; i += 2) args.set(Bun.argv[i] ?? "", Bun.argv[i + 1] ?? "");
const src = path.resolve(args.get("--src") ?? path.join(import.meta.dir, "../.."));
const sizes = (args.get("--n") ?? "5000,10000").split(",").map(Number);
const rounds = Number(args.get("--rounds") ?? "200");

type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;
type Hud = { describe(): unknown };
type Modules = {
	runTodo: (session: unknown, raw: unknown) => Promise<unknown>;
	registerPlanning: (pi: ExtensionAPI) => void;
	registerOvertime: (pi: ExtensionAPI) => void;
	TodoHud: new (pi: ExtensionAPI, readSession: () => unknown, open: () => Promise<void>, tui: unknown, onDispose: () => void) => Hud;
};

// Runtime-selected checkout (`--src`), so the same bench measures every version.
const modules: Modules = {
	...((await import(`${src}/src/tool.ts`)) as Pick<Modules, "runTodo">),
	...((await import(`${src}/src/planning.ts`)) as Pick<Modules, "registerPlanning">),
	...((await import(`${src}/src/overtime.ts`)) as Pick<Modules, "registerOvertime">),
	...((await import(`${src}/src/ui.ts`)) as Pick<Modules, "TodoHud">),
};

function stubPi(handlers: Map<string, Handler[]>, manager: SessionManager): ExtensionAPI {
	return {
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		sendMessage: () => {},
		appendEntry: (customType: string, data: unknown) => manager.appendCustomEntry(customType, data),
		logger: { warn: (message: string, data: unknown) => console.error("warn", message, data) },
	} as unknown as ExtensionAPI;
}

/** An in-process session over `manager`; the extension serves only `AgentSession` instances. */
function sessionOver(manager: SessionManager): AgentSession {
	const session = {
		sessionManager: manager,
		model: undefined,
		setTodoPhases: () => {},
		commitTodoPhases: () => {},
	};
	return Object.setPrototypeOf(session, AgentSession.prototype) as AgentSession;
}

function freshBranch(n: number): SessionManager {
	const manager = SessionManager.inMemory("/tmp/todo-more-tree-bench");
	fillBranch(manager, n);
	return manager;
}

let appended = 1_000_000;
const grow = (manager: SessionManager): void => {
	messageEntry(manager, appended++);
};

type Sample = { coldNs: number; coldHeap: number; steadyNs: number; steadyHeap: number };

const median = (values: number[]): number => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

/** One appended entry and the trigger it wakes, timed together: some checkouts react inside the append itself. */
async function round(manager: SessionManager, trigger: () => unknown | Promise<unknown>): Promise<number> {
	const t = Bun.nanoseconds();
	grow(manager);
	await trigger();
	return Bun.nanoseconds() - t;
}

async function measure(manager: SessionManager, trigger: () => unknown | Promise<unknown>): Promise<Sample> {
	fullGC();
	let heap = memoryUsage().current;
	const coldNs = await round(manager, trigger);
	const coldHeap = memoryUsage().current - heap;
	const times: number[] = [];
	for (let i = 0; i < rounds; i++) times.push(await round(manager, trigger));
	fullGC();
	heap = memoryUsage().current;
	for (let i = 0; i < rounds; i++) await round(manager, trigger);
	const steadyHeap = (memoryUsage().current - heap) / rounds;
	return { coldNs, coldHeap, steadyNs: median(times), steadyHeap };
}

const humans = (manager: SessionManager): AgentMessage[] =>
	manager
		.getBranchView()
		.filter((entry: SessionEntry) => entry.type === "message" && entry.message.role === "user")
		.slice(-20)
		.map((entry) => (entry as Extract<SessionEntry, { type: "message" }>).message as AgentMessage);

async function contextPath(n: number): Promise<Sample> {
	const manager = freshBranch(n);
	const handlers = new Map<string, Handler[]>();
	modules.registerPlanning(stubPi(handlers, manager));
	const handler = handlers.get("context")?.[0];
	if (handler === undefined) throw new Error("no context handler");
	const ctx = { sessionManager: manager, agent: { id: "bench", kind: "main" } };
	return measure(manager, () => handler({ type: "context", messages: humans(manager) }, ctx));
}

async function todoPath(n: number): Promise<Sample> {
	const manager = freshBranch(n);
	const session = sessionOver(manager);
	let k = 0;
	const title = `Task ${Math.floor((n - Math.max(500, Math.floor(n * 0.08)) - 1) / 300) * 300}`;
	return measure(manager, async () => {
		const result = (await modules.runTodo(session, {
			input: `*** Begin Todo\nEXPLAIN "${title}" "explanation ${k++}"\n*** End Todo`,
		})) as { isError?: boolean; content: { text: string }[] };
		if (result.isError === true) throw new Error(`todo failed: ${result.content[0]?.text}`);
	});
}

async function hudPath(n: number): Promise<Sample> {
	const manager = freshBranch(n);
	const session = sessionOver(manager);
	const handlers = new Map<string, Handler[]>();
	const hud = new modules.TodoHud(
		stubPi(handlers, manager),
		() => session,
		async () => {},
		{ requestRender() {}, requestComponentRender() {} },
		() => {},
	);
	return measure(manager, () => hud.describe());
}

async function overtimePath(n: number): Promise<Sample> {
	const manager = freshBranch(n);
	const session = sessionOver(manager);
	const agentId = `tree-bench-${crypto.randomUUID()}`;
	const ref = AgentRegistry.global().register({ id: agentId, displayName: "bench", kind: "main", session });
	const handlers = new Map<string, Handler[]>();
	modules.registerOvertime(stubPi(handlers, manager));
	const ctx = {
		agent: { id: agentId, kind: "main" },
		sessionManager: manager,
		isIdle: () => true,
		setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
		clearTimer: (handle: Timer) => clearTimeout(handle),
	};
	const emit = async (event: Record<string, unknown>): Promise<void> => {
		for (const handler of handlers.get(String(event.type)) ?? []) await handler(event, ctx);
	};
	let k = 0;
	const write = (): void => {
		manager.appendCustomEntry(RICH_SNAPSHOT_TYPE, {
			goal: { objective: "Ship it", measure: "Done", doneWhen: "Merged" },
			phases: [
				{
					name: "Delivery",
					items: [
						{
							title: "Running task",
							explanation: `Work ${k++}`,
							status: "in_progress",
							time: { kind: "estimated", budgetId: "bench-budget", minutes: 60, elapsedMs: 0, runningSince: Date.now() },
						},
					],
				},
			],
		});
	};
	try {
		await emit({ type: "session_start" });
		return await measure(manager, async () => {
			write();
			await emit({ type: "tool_result", toolName: "todo", isError: false });
			await Promise.resolve();
		});
	} finally {
		await emit({ type: "session_shutdown" });
		AgentRegistry.global().unregister(agentId, ref);
	}
}

const paths: Record<string, (n: number) => Promise<Sample>> = {
	context: contextPath,
	todo: todoPath,
	hud: hudPath,
	overtime: overtimePath,
};

const us = (ns: number): string => (ns / 1000).toFixed(1);
const kib = (bytes: number): string => (bytes / 1024).toFixed(1);
console.log(`checkout ${src}, rounds ${rounds}`);
console.log("| path | n | cold µs | cold KiB | steady µs | steady KiB/round |");
console.log("|---|---|---|---|---|---|");
for (const [name, run] of Object.entries(paths)) {
	for (const n of sizes) {
		const sample = await run(n);
		console.log(`| ${name} | ${n} | ${us(sample.coldNs)} | ${kib(sample.coldHeap)} | ${us(sample.steadyNs)} | ${kib(sample.steadyHeap)} |`);
	}
}
