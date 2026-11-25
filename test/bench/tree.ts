import { fullGC, memoryUsage } from "bun:jsc";
import path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { foldBranch } from "../../src/branch.ts";
import { hostPhases, TODO_NG_NOTES_TYPE } from "../../src/state.ts";
import { todoResultMessage } from "../host.ts";
import { appendTodoChange, fillBranch, messageEntry } from "../ui-fixture.ts";

const args = new Map<string, string>();
for (let i = 2; i < Bun.argv.length; i += 2) args.set(Bun.argv[i] ?? "", Bun.argv[i + 1] ?? "");
const src = path.resolve(args.get("--src") ?? path.join(import.meta.dir, "../.."));
const sizes = (args.get("--n") ?? "5000,10000").split(",").map(Number);
const rounds = Number(args.get("--rounds") ?? "200");
const reminderCounts = (args.get("--reminders") ?? "0,119,704").split(",").map(Number);
const selected = args.get("--paths")?.split(",");

type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;
type Hud = { node(): unknown; refresh(): void };
type Modules = {
	runTodo: (session: unknown, raw: unknown) => Promise<unknown>;
	registerPlanning: (pi: ExtensionAPI) => void;
	registerOvertime: (pi: ExtensionAPI) => void;
	hudController: (snapshotOf: () => unknown, open: () => void) => Hud;
	toSnapshot: (state: unknown) => unknown;
	liveState: (session: unknown) => unknown;
	contextMessages: (messages: AgentMessage[], session: AgentSession) => AgentMessage[] | undefined;
};

const modules: Modules = {
	...((await import(`${src}/src/tool.ts`)) as Pick<Modules, "runTodo">),
	...((await import(`${src}/src/planning.ts`)) as Pick<Modules, "registerPlanning">),
	...((await import(`${src}/src/overtime.ts`)) as Pick<Modules, "registerOvertime">),
	...((await import(`${src}/src/ui.tsx`)) as Pick<Modules, "hudController">),
	...((await import(`${src}/src/state.ts`)) as Pick<Modules, "toSnapshot">),
	...((await import(`${src}/src/commit.ts`)) as Pick<Modules, "liveState">),
	...((await import(`${src}/src/reminders.tsx`)) as Pick<Modules, "contextMessages">),
};

function stubPi(handlers: Map<string, Handler[]>, manager: SessionManager): ExtensionAPI {
	return {
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		sendMessage: () => {},
		appendEntry: (customType: string, data: unknown) => manager.appendCustomEntry(customType, data),
		logger: { warn: (message: string, data: unknown) => console.error("warn", message, data) },
	} as unknown as ExtensionAPI;
}

function sessionOver(manager: SessionManager): AgentSession {
	const session = {
		sessionManager: manager,
		model: undefined,
		getTodoPhases: () => hostPhases(foldBranch(manager.getBranchView()).state),
		setTodoPhases: () => {},
	};
	return Object.setPrototypeOf(session, AgentSession.prototype) as AgentSession;
}

function freshBranch(n: number): SessionManager {
	const manager = SessionManager.inMemory("/tmp/todo-ng-tree-bench");
	fillBranch(manager, n);
	return manager;
}

let appended = 1_000_000;
const grow = (manager: SessionManager): void => {
	messageEntry(manager, appended++);
};

type Sample = { coldNs: number; coldHeap: number; steadyNs: number; steadyHeap: number };

const median = (values: number[]): number => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

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

async function planningPath(n: number): Promise<Sample> {
	const manager = freshBranch(n);
	const { state, notes } = foldBranch(manager.getBranchView());
	const phases = hostPhases(state);
	const session = Object.setPrototypeOf(
		{ sessionManager: manager, model: undefined, getTodoPhases: () => phases, setTodoPhases: () => {} },
		AgentSession.prototype,
	) as AgentSession;
	const agentId = `tree-bench-${crypto.randomUUID()}`;
	const ref = AgentRegistry.global().register({ id: agentId, displayName: "bench", kind: "main", session });
	const handlers = new Map<string, Handler[]>();
	modules.registerPlanning(stubPi(handlers, manager));
	const ctx = { sessionManager: manager, agent: { id: agentId, kind: "main" } };
	const afterTools = handlers.get("tool_result")?.[0];
	if (afterTools === undefined) throw new Error("no planning tool_result handler");
	let k = 0;
	const editAndDeliver = (): unknown => {
		const edit = k++;
		manager.appendCustomEntry(TODO_NG_NOTES_TYPE, {
			...notes,
			items: notes.items.map((item) => ({ ...item, explanation: `Edited ${edit}` })),
		});
		const delivered = afterTools({ type: "tool_result", toolName: "read", isError: false }, ctx);
		const text =
			typeof delivered === "object" && delivered !== null && "additionalContext" in delivered ? delivered.additionalContext : undefined;
		if (typeof text !== "string" || !text.includes(`Edited ${edit}`)) throw new Error("planning reminder was not delivered");
		return delivered;
	};
	try {
		return await measure(manager, editAndDeliver);
	} finally {
		AgentRegistry.global().unregister(agentId, ref);
	}
}

async function todoPath(n: number): Promise<Sample> {
	const manager = freshBranch(n);
	const session = sessionOver(manager);
	let k = 0;
	const id = `t${Math.floor((n - Math.max(500, Math.floor(n * 0.08)) - 1) / 300) * 300 + 1}`;
	return measure(manager, async () => {
		const result = (await modules.runTodo(session, {
			explain: [{ id, note: `explanation ${k++}` }],
		})) as { isError?: boolean; content: { text: string }[] };
		if (result.isError === true) throw new Error(`todo failed: ${result.content[0]?.text}`);
	});
}

async function hudPath(n: number): Promise<Sample> {
	const manager = freshBranch(n);
	const session = sessionOver(manager);
	const hud = modules.hudController(
		() => modules.toSnapshot(modules.liveState(session)),
		() => {},
	);
	return measure(manager, () => {
		hud.refresh();
		hud.node();
	});
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
		const runningSince = Date.now();
		manager.appendCustomEntry(TODO_NG_NOTES_TYPE, {
			goal: { objective: "Ship it", measure: "Done", doneWhen: "Merged" },
			items: [
				{
					id: "t1",
					phase: "Delivery",
					title: "Running task",
					explanation: `Work ${k++}`,
					estimate: { kind: "estimated", budgetId: "bench-budget", minutes: 60 },
					progress: { status: "in_progress", startedAt: runningSince, elapsedMs: 0, runningSince },
					commit: null,
				},
			],
		});
		manager.appendMessage(
			todoResultMessage(
				{ op: "batch", phases: [{ name: "Delivery", tasks: [{ content: "Running task", status: "in_progress" }] }] },
				runningSince,
			),
		);
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

const stopReminder = (index: number): Parameters<SessionManager["appendMessage"]>[0] => ({
	role: "developer",
	content: [
		{
			type: "text",
			text: `<system-reminder>\nYou stopped with 1 incomplete todo item(s):\n- Open item\n\nPlease continue working on these tasks or mark them complete if finished.\n(Reminder ${(index % 3) + 1}/3)\n</system-reminder>`,
		},
	],
	timestamp: 1_800_000_000_000 + index,
});

const reminderDigests: string[] = [];

async function remindersPath(n: number, reminders: number): Promise<Sample> {
	const manager = SessionManager.inMemory("/tmp/todo-ng-tree-bench");
	const chunks = Math.max(1, reminders);
	for (let chunk = 0; chunk < chunks; chunk++) {
		fillBranch(manager, Math.floor(n / chunks));
		if (chunk === 0) appendTodoChange(manager, "Open item");
		if (chunk < reminders) manager.appendMessage(stopReminder(chunk));
	}
	const view = manager.getBranchView();
	const messages = view.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
	const foldStart = Bun.nanoseconds();
	foldBranch(view);
	const foldNs = Bun.nanoseconds() - foldStart;
	const session = sessionOver(manager);
	let first: AgentMessage[] | undefined;
	let calls = 0;
	const sample = await measure(manager, () => {
		const rewritten = modules.contextMessages(messages, session);
		if (calls++ === 0) first = rewritten;
	});
	const texts = (first ?? []).filter((message, index) => message !== messages[index]).map((message) => JSON.stringify(message));
	const digest = new Bun.CryptoHasher("sha256").update(texts.join("\n")).digest("hex");
	reminderDigests.push(
		`reminders/${reminders} n=${n} messages=${messages.length} one-forward-fold-µs=${us(foldNs)} rewritten=${texts.length} sha256=${digest}`,
	);
	return sample;
}

const paths: Record<string, (n: number) => Promise<Sample>> = {
	planning: planningPath,
	todo: todoPath,
	hud: hudPath,
	overtime: overtimePath,
	...Object.fromEntries(reminderCounts.map((count) => [`reminders/${count}`, (n: number) => remindersPath(n, count)])),
};

const us = (ns: number): string => (ns / 1000).toFixed(1);
const kib = (bytes: number): string => (bytes / 1024).toFixed(1);
console.log(`checkout ${src}, rounds ${rounds}`);
console.log("| path | n | cold µs | cold KiB | steady µs | steady KiB/round |");
console.log("|---|---|---|---|---|---|");
for (const [name, run] of Object.entries(paths).filter(([name]) => selected?.some((prefix) => name.startsWith(prefix)) ?? true)) {
	for (const n of sizes) {
		const sample = await run(n);
		console.log(`| ${name} | ${n} | ${us(sample.coldNs)} | ${kib(sample.coldHeap)} | ${us(sample.steadyNs)} | ${kib(sample.steadyHeap)} |`);
	}
}
for (const line of reminderDigests) console.log(line);
