import { describe, expect, test } from "bun:test";
import "@oh-my-pi/pi-coding-agent/ui/tools/index";
import { printRows } from "@oh-my-pi/pi-coding-agent/ui/print-rows";
import type { ToolResult, ToolView, ToolViewState } from "@oh-my-pi/pi-coding-agent/ui/tools/contract";
import { legacyPresenter } from "@oh-my-pi/pi-coding-agent/ui/tools/legacy";
import { toolPresenter } from "@oh-my-pi/pi-coding-agent/ui/tools/registry";
import { resolveChildren, type UiKind, type UiNode } from "@oh-my-pi/pi-tui";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { TODO_TOOL_DEFINITION } from "../index.ts";
import type { TodoNgSnapshot } from "../src/state.ts";
import type { TodoNgDetails } from "../src/tool.ts";

const PREVIEW_MARKER = "Preview only — not committed.";

const initArgs = {
	goal: {
		title: "Stop the double render",
		summary: "One card per call",
		acceptance: "Native and ANSI verified",
	},
	add: [
		{ phase: "Implementation", title: "Read the merge path", detail: "Follow the host view merge", minutes: 25 },
		{ phase: "Implementation", title: "Set the flag", detail: "Declare mergeCallAndResult on the tool", minutes: 10 },
	],
};

const snapshot: TodoNgSnapshot = {
	goal: { objective: "Stop the double render", measure: "One card per call", doneWhen: "Native and ANSI verified" },
	phases: [
		{
			name: "Implementation",
			items: [
				{
					id: "t1",
					title: "Read the merge path",
					explanation: "Follow the host view merge",
					status: "in_progress",
					estimate: { kind: "estimated", budgetId: "b1", minutes: 25 },
					commit: null,
				},
				{
					id: "t2",
					title: "Set the flag",
					explanation: "Declare mergeCallAndResult on the tool",
					status: "pending",
					estimate: { kind: "estimated", budgetId: "b2", minutes: 10 },
					commit: null,
				},
			],
		},
	],
};

const result: ToolResult<TodoNgDetails> = {
	content: [{ type: "text", text: "Todo list initialized." }],
	details: {
		op: "init",
		operations: ["init"],
		phases: [
			{
				name: "Implementation",
				tasks: [
					{ content: "Read the merge path", status: "in_progress" },
					{ content: "Set the flag", status: "pending" },
				],
			},
		],
		storage: "session",
		todoMore: true,
		more: snapshot,
	},
};

const streaming: ToolViewState = { expanded: false, isPartial: true, argsComplete: false, executionStarted: false };
const settled: ToolViewState = { expanded: false, isPartial: false, argsComplete: true, executionStarted: true };

const hostTodo = toolPresenter("todo");
if (hostTodo === undefined) throw new Error("Expected the host todo presenter to be registered");
const presenter = legacyPresenter(TODO_TOOL_DEFINITION, hostTodo);

function nodesIn(value: unknown): UiNode[] {
	return resolveChildren(value)().flatMap((node) => [node, ...nodesIn(node.children())]);
}

function isKind<K extends UiKind>(node: UiNode, kind: K): node is UiNode<K> {
	return node.kind === kind;
}

function ofKind<K extends UiKind>(value: unknown, kind: K): UiNode<K>[] {
	return nodesIn(value).filter((node): node is UiNode<K> => isKind(node, kind));
}

function withRole(view: ToolView | undefined, role: string): UiNode[] {
	return nodesIn(view?.body).filter((node) => node.props().role === role);
}

function itemTexts(view: ToolView | undefined): unknown[] {
	return ofKind(view?.body, "checklist").flatMap((node) => node.props().phases.flatMap((phase) => phase.items.map((item) => item.text)));
}

function painted(view: ToolView | undefined): string[] {
	return printRows(() => view?.body, 100);
}

const count = (values: readonly string[], needle: string): number => values.filter((value) => value.includes(needle)).length;

describe("one card per todo call", () => {
	test("streaming arguments draw the uncommitted preview", () => {
		const view = presenter.call?.(initArgs, streaming);

		const previews = withRole(view, "todo-ng.preview");
		expect(previews).toHaveLength(1);
		expect(ofKind(previews, "text").map((node) => node.props().text)).toContain(PREVIEW_MARKER);
		expect(withRole(view, "todo-ng.panel")).toHaveLength(0);

		const lines = painted(view);
		expect(count(lines, PREVIEW_MARKER)).toBe(1);
		expect(count(lines, "· 25m")).toBe(0);
	});

	test("once a result exists it replaces the call view with our panel under the host's progress head", () => {
		expect(presenter.merge).toBe(true);
		const view = presenter.result?.(result, settled, initArgs);

		expect(withRole(view, "todo-ng.preview")).toHaveLength(0);
		expect(withRole(view, "todo-ng.panel")).toHaveLength(1);
		expect(ofKind(view?.body, "checklist")).toHaveLength(1);
		expect(withRole(view, "todo-ng.list")).toHaveLength(1);
		expect(view?.head?.target).toBe("0/2");

		const lines = painted(view);
		expect(count(lines, PREVIEW_MARKER)).toBe(0);
		expect(count(lines, "Read the merge path · 25m")).toBe(1);
		expect(count(lines, "Objective: Stop the double render")).toBe(1);
	});

	test("an incremental update shows only the delta until expanded", () => {
		const deltaArgs = { done_id: "t1" };
		const [first, second] = snapshot.phases[0]?.items ?? [];
		if (first === undefined || second === undefined) throw new Error("Expected two snapshot items");
		const deltaResult: ToolResult<TodoNgDetails> = {
			content: [{ type: "text", text: "Updated." }],
			details: {
				op: "done",
				operations: ["done"],
				changes: [{ op: "done", id: "t1", title: "Read the merge path", commit: null }],
				completedTasks: [{ phase: "Implementation", content: "Read the merge path" }],
				phases: [
					{
						name: "Implementation",
						tasks: [
							{ content: "Read the merge path", status: "completed" },
							{ content: "Set the flag", status: "in_progress" },
						],
					},
				],
				storage: "session",
				todoMore: true,
				more: {
					goal: snapshot.goal,
					phases: [
						{
							name: "Implementation",
							items: [
								{ ...first, status: "completed" },
								{ ...second, status: "in_progress" },
							],
						},
					],
				},
			},
		};

		const collapsed = presenter.result?.(deltaResult, settled, deltaArgs);
		expect(collapsed?.head?.target).toBe("1/2");
		expect(itemTexts(collapsed)).toEqual(["Read the merge path · 25m"]);
		expect(ofKind(collapsed?.body, "kv")).toHaveLength(0);
		const collapsedLines = painted(collapsed);
		expect(count(collapsedLines, "Read the merge path · 25m")).toBe(1);
		expect(count(collapsedLines, "Set the flag · 10m")).toBe(0);
		expect(count(collapsedLines, "Objective: Stop the double render")).toBe(0);

		const expanded = presenter.result?.(deltaResult, { ...settled, expanded: true }, deltaArgs);
		expect(expanded?.head?.target).toBe("1/2");
		expect(itemTexts(expanded)).toEqual(["Read the merge path · 25m", "Set the flag · 10m"]);
		expect(ofKind(expanded?.body, "kv")).toHaveLength(1);
		const expandedLines = painted(expanded);
		expect(count(expandedLines, "Read the merge path · 25m")).toBe(1);
		expect(count(expandedLines, "Set the flag · 10m")).toBe(1);
		expect(expandedLines.map(stripEscapes).filter((line) => /^Objective\s+Stop the double render$/.test(line.trim()))).toHaveLength(1);
	});
});
