import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getSharedCompactCoordinator } from "../omomp-shared/compact-handoff.ts";
import { saveTodoEdit } from "../src/edit.ts";
import { formatClock, formatDateTime } from "../src/format.ts";
import { PLANNING_SOURCE, registerPlanning } from "../src/planning.ts";
import { runTodo } from "../src/tool.ts";
import { hostSession, runPersisted } from "./host.ts";

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;
type PromptResult = { message: { customType: string; content: string; display: false; attribution: "agent" } } | undefined;
type ToolResult = { additionalContext?: string } | undefined;

const valid = {
	goal: { title: "g", summary: "m", acceptance: "d" },
	add: [{ phase: "P", title: "t", detail: "e", minutes: 5 }],
};
const multi = {
	goal: { title: "Ship compact planning", summary: "Context stays small", acceptance: "Verified end-to-end" },
	add: [
		{ phase: "Setup", title: "Done task", detail: "Detailed explanation of already finished setup task", minutes: 10 },
		{ phase: "Build", title: "Active task", detail: "Detailed explanation of current in-progress task", minutes: 30 },
		{ phase: "Build", title: "Pending task", detail: "Detailed explanation of upcoming pending task", minutes: 20 },
	],
	done_id: "t1",
};

const registered: { id: string; ref: ReturnType<AgentRegistry["register"]> }[] = [];

afterEach(() => {
	setSystemTime();
	for (const { id, ref } of registered.splice(0)) AgentRegistry.global().unregister(id, ref);
});

function gate() {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		logger: { warn: () => {} },
	} as unknown as ExtensionAPI;
	registerPlanning(pi);
	const manager = SessionManager.inMemory("/tmp/todo-more-planning-tests");
	const session = hostSession(manager);
	const agentId = `planning-gate-${crypto.randomUUID()}`;
	const ref = AgentRegistry.global().register({
		id: agentId,
		displayName: "Planning gate",
		kind: "main",
		session: Object.setPrototypeOf(session, AgentSession.prototype) as AgentSession,
	});
	registered.push({ id: agentId, ref });
	const ctx = {
		cwd: "/tmp/todo-more-planning-tests",
		sessionManager: manager,
		agent: { id: agentId, kind: "main" },
	} as unknown as ExtensionContext;
	const emit = async (name: string, event: Record<string, unknown>): Promise<unknown> => {
		let last: unknown;
		for (const handler of handlers.get(name) ?? []) last = (await handler(event, ctx)) ?? last;
		return last;
	};
	const call = (toolName: string, input: Record<string, unknown>) =>
		emit("tool_call", { type: "tool_call", toolName, toolCallId: crypto.randomUUID(), input }) as Promise<ToolCallEventResult | undefined>;
	const prompt = (reason?: string) =>
		emit("before_agent_start", { type: "before_agent_start", ...(reason ? { reason } : {}) }) as Promise<PromptResult>;
	const afterTool = (toolName: string, isError = false) =>
		emit("tool_result", { type: "tool_result", toolName, isError }) as Promise<ToolResult>;
	const persistPromptMessage = (res: PromptResult) => {
		if (res === undefined) return;
		manager.appendCustomMessageEntry(res.message.customType, res.message.content, res.message.display, undefined, res.message.attribution);
	};
	const persistAdditionalContext = (res: ToolResult) => {
		if (res?.additionalContext === undefined) return;
		manager.appendMessage({
			role: "developer",
			content: res.additionalContext,
			attribution: "agent",
			timestamp: Date.now(),
		});
	};
	return { call, emit, prompt, afterTool, persistPromptMessage, persistAdditionalContext, session, manager };
}

describe("planning gate", () => {
	test("blocks edit while the list is empty", async () => {
		const { call } = gate();
		const result = await call("edit", { input: "x" });
		expect(result?.block).toBe(true);
	});

	test("lets edit follow a valid INIT of the same message", async () => {
		const { call } = gate();
		expect(await call("todo", valid)).toBeUndefined();
		expect(await call("edit", { input: "x" })).toBeUndefined();
	});

	test.each([
		["unparsable", "not a todo object"],
		["ADD without minutes", { goal: { title: "g", summary: "m", acceptance: "d" }, add: [{ phase: "P", title: "t", detail: "e" }] }],
		[
			"ADD over the item limit",
			{ goal: { title: "g", summary: "m", acceptance: "d" }, add: [{ phase: "P", title: "t", detail: "e", minutes: 9999 }] },
		],
		["empty goal", { goal: { title: "", summary: "m", acceptance: "d" }, add: [{ phase: "P", title: "t", detail: "e", minutes: 5 }] }],
		["mutation of an empty list", { start_id: "t1" }],
	])("blocks edit after a rejected todo: %s", async (_name, input) => {
		const { call } = gate();
		await call("todo", input as Record<string, unknown>);
		expect((await call("edit", { input: "x" }))?.block).toBe(true);
	});

	test("blocks edit once every item is closed, until a todo in the same message starts a new round", async () => {
		const { call, session } = gate();
		await runPersisted(session, valid);
		await runPersisted(session, { drop_ids: ["t1"] });
		expect((await call("edit", { input: "x" }))?.reason).toContain("Every item of this todo round is completed or abandoned");
		await call("todo", { add: [{ phase: "Q", title: "u", detail: "e", minutes: 5 }] });
		expect((await call("edit", { input: "x" }))?.block).toBe(true);
		await call("todo", {
			goal: { title: "g2", summary: "m", acceptance: "d" },
			add: [{ phase: "Q", title: "u", detail: "e", minutes: 5 }],
		});
		expect(await call("edit", { input: "x" })).toBeUndefined();
		await call("todo", { drop_ids: ["t1"] });
		expect((await call("edit", { input: "x" }))?.block).toBe(true);
	});

	test("does not block other tools on an empty list", async () => {
		const { call } = gate();
		expect(await call("read", { path: "x" })).toBeUndefined();
	});

	test("lets edit through once the list has items, and forgets the preview when a turn ends", async () => {
		const { call, emit, session } = gate();
		await call("todo", valid);
		await emit("turn_end", { type: "turn_end" });
		expect((await call("edit", { input: "x" }))?.block).toBe(true);
		await runPersisted(session, valid);
		expect(await call("edit", { input: "x" })).toBeUndefined();
	});

	test("reads the host list, not the branch, once a todo call has executed but its result is not yet persisted", async () => {
		const { call, afterTool, session } = gate();
		expect(await call("todo", valid)).toBeUndefined();
		await runTodo(session, valid);
		await afterTool("todo");
		expect(await call("edit", { input: "x" })).toBeUndefined();
	});
});

describe("planning injection granularity, deduplication and recovery", () => {
	const t0 = Date.parse("2026-11-22T01:00:00.000Z");

	test("does not double-inject on todo tool_result or following non-todo tools in the same or next turn", async () => {
		setSystemTime(t0);
		const { call, afterTool, emit, prompt, persistPromptMessage, session } = gate();
		const initial = await prompt();
		expect(initial?.message.content).toContain(`Current time: ${formatDateTime(t0)}`);
		expect(initial?.message.content).toContain("Todo is empty");
		persistPromptMessage(initial);

		await call("todo", multi);
		await runTodo(session, multi);
		expect(await afterTool("todo")).toBeUndefined();
		expect(await afterTool("edit")).toBeUndefined();

		await emit("turn_start", { type: "turn_start" });
		await runPersisted(session, { explain: [{ id: "t2", note: "Refined active criteria" }] });
		expect(await afterTool("todo")).toBeUndefined();
		await emit("turn_start", { type: "turn_start" });
		expect(await afterTool("read")).toBeUndefined();
		expect(await afterTool("bash")).toBeUndefined();
	});

	test("tells the model at the next prompt that a finished round needs a new todo, once, and keeps the full list after compaction", async () => {
		setSystemTime(t0);
		const { prompt, persistPromptMessage, session, manager } = gate();
		await runPersisted(session, multi);
		persistPromptMessage(await prompt());
		await runPersisted(session, { done_id: "t2" });
		await runPersisted(session, { drop_ids: ["t3"] });
		const finished = await prompt();
		expect(finished?.message.content).toContain("Every item of this todo round is completed or abandoned");
		expect(finished?.message.content).not.toContain("Check that this todo matches");
		persistPromptMessage(finished);
		expect(await prompt()).toBeUndefined();

		const keptId = manager.appendMessage({ role: "user", content: "next turn", timestamp: t0 });
		manager.appendCompaction("Compacted history", "Compacted", keptId, 40_000);
		const recovered = (await prompt())?.message.content ?? "";
		expect(recovered).toContain("Detailed explanation of already finished setup task");
		expect(recovered).toContain("Every item of this todo round is completed or abandoned");
		expect(recovered).not.toContain("Check that this todo matches");
	});

	test("atPrompt delivers compact active view when state changed and stays silent when only wall-clock time advances", async () => {
		setSystemTime(t0);
		const { prompt, persistPromptMessage, session } = gate();
		await runPersisted(session, multi);

		const first = await prompt();
		expect(first).toBeDefined();
		const text = first?.message.content ?? "";
		expect(text).toContain(`<system-reminder source="${PLANNING_SOURCE}">`);
		expect(text).toContain(`Current time: ${formatDateTime(t0)}`);
		expect(text).toContain("Ship compact planning");
		expect(text).toContain('"Setup" (1/1)');
		expect(text).toContain('"Active task"');
		expect(text).toContain(`started ${formatClock(t0, t0)}, due by ${formatClock(t0 + 30 * 60_000, t0)}`);
		expect(text).toContain("Detailed explanation of current in-progress task");
		expect(text).toContain('"Pending task"');
		expect(text).not.toContain("Detailed explanation of upcoming pending task");
		expect(text).not.toContain("Detailed explanation of already finished setup task");
		persistPromptMessage(first);

		setSystemTime(t0 + 5 * 60_000);
		expect(await prompt()).toBeUndefined();
	});

	test("restores the full unabridged list (including completed/abandoned explanations) once after compaction at prompt or mid-run tool_result", async () => {
		setSystemTime(t0);
		const { prompt, afterTool, emit, persistPromptMessage, persistAdditionalContext, session, manager } = gate();
		await runPersisted(session, multi);
		const before = await prompt();
		persistPromptMessage(before);

		setSystemTime(t0 + 10 * 60_000);
		const keptUserId = manager.appendMessage({ role: "user", content: "keep going", timestamp: t0 + 10 * 60_000 });
		manager.appendCompaction("Compacted earlier work", "Compacted", keptUserId, 50_000);

		const recovery = await afterTool("read");
		const body = recovery?.additionalContext ?? "";
		expect(body).toContain(`Current time: ${formatDateTime(t0 + 10 * 60_000)}`);
		expect(body).toContain('"Done task"');
		expect(body).toContain("Detailed explanation of already finished setup task");
		expect(body).toContain('"Active task"');
		expect(body).toContain("Detailed explanation of current in-progress task");
		expect(body).toContain('"Pending task"');
		expect(body).toContain("Detailed explanation of upcoming pending task");

		expect(await afterTool("bash")).toBeUndefined();

		persistAdditionalContext(recovery);
		await emit("turn_start", { type: "turn_start" });
		setSystemTime(t0 + 12 * 60_000);
		expect(await afterTool("read")).toBeUndefined();
		expect(await prompt()).toBeUndefined();
	});

	test("detects out-of-band /todo-more edit on a pending item and surfaces its updated explanation immediately", async () => {
		setSystemTime(t0);
		const { afterTool, prompt, persistPromptMessage, session } = gate();
		await runPersisted(session, multi);
		const first = await prompt();
		persistPromptMessage(first);

		setSystemTime(t0 + 3 * 60_000);
		const edited = saveTodoEdit(session, {
			kind: "explain",
			id: "t3",
			explanation: "Human-updated acceptance criteria for pending task",
		});
		expect(edited.kind).toBe("saved");

		const delivered = await afterTool("read");
		expect(delivered?.additionalContext).toContain("Human-updated acceptance criteria for pending task");
	});

	test("restores the full list at before_agent_start after compaction and branch_summary, and stays silent on unreadable remote compaction", async () => {
		setSystemTime(t0);
		const { prompt, persistPromptMessage, session, manager } = gate();
		await runPersisted(session, multi);
		persistPromptMessage(await prompt());

		setSystemTime(t0 + 15 * 60_000);
		const keptId = manager.appendMessage({ role: "user", content: "next turn", timestamp: t0 + 15 * 60_000 });
		manager.appendCompaction("Compacted history", "Compacted", keptId, 40_000);
		const recovered = await prompt();
		expect(recovered?.message.content).toContain('"Done task"');
		expect(recovered?.message.content).toContain("Detailed explanation of already finished setup task");
		expect(recovered?.message.content).toContain("Detailed explanation of upcoming pending task");
		persistPromptMessage(recovered);
		expect(await prompt()).toBeUndefined();

		setSystemTime(t0 + 20 * 60_000);
		manager.branchWithSummary(keptId, "Switched branch summary");
		const branchRecovered = await prompt();
		expect(branchRecovered?.message.content).toContain("Detailed explanation of already finished setup task");
		persistPromptMessage(branchRecovered);
		expect(await prompt()).toBeUndefined();
	});

	test("registers omp-todo-more compact handoff with empty-list gating and active-list claim", async () => {
		const { emit, session, manager } = gate();
		const coordinator = getSharedCompactCoordinator();
		expect(coordinator.listPluginIds()).toContain("omp-todo-more");

		const emptyPruneReport = {
			totalInputPaths: 0,
			strippedQueryCount: 0,
			filteredNoiseCount: 0,
			keptUniqueCandidateCount: 0,
			selectedCount: 0,
			repoSourcePathsSelected: [],
			selectedPaths: [],
		};
		const emptySnapshot = coordinator.prepareSnapshot(
			{ cwd: "/tmp/todo-more-planning-tests", branchEntries: manager.getBranch(), messagesToSummarize: [] },
			emptyPruneReport,
		);
		expect(emptySnapshot.inactiveStatefulPluginIds).toContain("omp-todo-more");
		expect(emptySnapshot.compactingResult.context?.join("\n")).not.toContain("[omp-todo-more]");

		await runPersisted(session, multi);
		await emit("session_before_compact", {
			type: "session_before_compact",
			branchEntries: manager.getBranch(),
			preparation: {
				messagesToSummarize: [],
				turnPrefixMessages: [],
				fileOps: { read: new Set(), edited: new Set(), written: new Set() },
			},
		});
		const prepared = coordinator.getLastPrepared(manager);
		const handoff = prepared?.activeHandoffs.find((h) => h.pluginId === "omp-todo-more");
		expect(handoff).toBeDefined();
		expect(handoff?.injection).toEqual({ source: PLANNING_SOURCE, delivery: "plugin-managed" });
		expect(handoff?.claim).toContain("2 phases, 3 items");
		expect(handoff?.claim).toContain(`source="${PLANNING_SOURCE}"`);
		expect(prepared?.compactingResult.context?.join("\n")).toContain("[omp-todo-more]");

		const branchOnly = coordinator.prepareSnapshot(
			{ cwd: "/tmp/todo-more-planning-tests", branchEntries: manager.getBranch(), messagesToSummarize: [] },
			emptyPruneReport,
		);
		expect(branchOnly.activeHandoffs.find((h) => h.pluginId === "omp-todo-more")?.claim).toContain("2 phases, 3 items");
	});
});
