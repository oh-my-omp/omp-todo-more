import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { registerPlanning } from "../src/planning.ts";
import { runTodo } from "../src/tool.ts";

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;

const valid = '*** Begin Todo\nINIT "g" "m" "d"\nPHASE "P"\nADD "t" "e" 5\n*** End Todo';
const document = (...lines: string[]): string => ["*** Begin Todo", ...lines, "*** End Todo"].join("\n");

function gate() {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		logger: { warn: () => {} },
	} as unknown as ExtensionAPI;
	registerPlanning(pi);
	const manager = SessionManager.inMemory("/tmp/todo-more-planning-tests");
	const ctx = {
		cwd: "/tmp/todo-more-planning-tests",
		sessionManager: manager,
		agent: { id: "a", kind: "main" },
	} as unknown as ExtensionContext;
	const emit = async (name: string, event: Record<string, unknown>): Promise<unknown> => {
		let last: unknown;
		for (const handler of handlers.get(name) ?? []) last = (await handler(event, ctx)) ?? last;
		return last;
	};
	const call = (toolName: string, input: Record<string, unknown>) =>
		emit("tool_call", { type: "tool_call", toolName, toolCallId: crypto.randomUUID(), input }) as Promise<ToolCallEventResult | undefined>;
	const session = { sessionManager: manager, model: undefined, setTodoPhases: () => {} };
	return { call, emit, session };
}

describe("planning gate", () => {
	test("blocks edit while the list is empty", async () => {
		const { call } = gate();
		const result = await call("edit", { input: "x" });
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("Todo is empty");
	});

	test("lets edit follow a valid INIT of the same message", async () => {
		const { call } = gate();
		expect(await call("todo", { input: valid })).toBeUndefined();
		expect(await call("edit", { input: "x" })).toBeUndefined();
	});

	test.each([
		["unparsable", "not a todo document"],
		["ADD without minutes", document('INIT "g" "m" "d"', 'PHASE "P"', 'ADD "t" "e"')],
		["ADD over the item limit", document('INIT "g" "m" "d"', 'PHASE "P"', 'ADD "t" "e" 9999')],
		["empty goal", document('INIT "" "m" "d"', 'PHASE "P"', 'ADD "t" "e" 5')],
		["mutation of an empty list", document('START "t"')],
	])("blocks edit after a rejected todo: %s", async (_name, input) => {
		const { call } = gate();
		expect(await call("todo", { input })).toBeUndefined();
		expect((await call("edit", { input: "x" }))?.block).toBe(true);
	});

	test("blocks edit after a todo that empties the list", async () => {
		const { call, session } = gate();
		await runTodo(session, { input: valid });
		expect(await call("edit", { input: "x" })).toBeUndefined();
		expect(await call("todo", { input: document("RM ALL") })).toBeUndefined();
		expect((await call("edit", { input: "x" }))?.block).toBe(true);
	});

	test("lets edit through once the list has items, and forgets the preview when a turn ends", async () => {
		const { call, emit, session } = gate();
		await call("todo", { input: valid });
		await emit("turn_end", { type: "turn_end" });
		expect((await call("edit", { input: "x" }))?.block).toBe(true);
		await runTodo(session, { input: valid });
		expect(await call("edit", { input: "x" })).toBeUndefined();
	});

	test("ignores other tools", async () => {
		const { call } = gate();
		expect(await call("read", { path: "x" })).toBeUndefined();
	});
});
