import { describe, expect, test } from "bun:test";
import type { ExtensionRunner, RegisteredTool } from "@oh-my-pi/pi-coding-agent";
import { ExtensionToolWrapper, RegisteredToolAdapter } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import type { DescribeContext, TUI } from "@oh-my-pi/pi-tui";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { TODO_TOOL_DEFINITION } from "../index.ts";
import type { TodoMoreSnapshot } from "../src/state.ts";
import type { TodoMoreDetails } from "../src/tool.ts";

const PREVIEW_MARKER = "Preview only — not committed.";
const PREVIEW_ROLE = "todo-more.preview";
const PANEL_ROLE = "todo-more.panel";
const CHECKLIST_ROLE = "todo-more.list";
const CARD_TOP = "╭";

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

const snapshot: TodoMoreSnapshot = {
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
					time: { kind: "estimated", budgetId: "b1", minutes: 25, elapsedMs: 0, runningSince: null },
				},
				{
					id: "t2",
					title: "Set the flag",
					explanation: "Declare mergeCallAndResult on the tool",
					status: "pending",
					time: { kind: "estimated", budgetId: "b2", minutes: 10, elapsedMs: 0, runningSince: null },
				},
			],
		},
	],
};

const result: { content: { type: "text"; text: string }[]; details: TodoMoreDetails } = {
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

const headlessUi: TUI = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
const unusedRunner = undefined as unknown as ExtensionRunner;

const registered = {
	definition: TODO_TOOL_DEFINITION,
	extensionPath: "test/card.test.ts",
	sourceInfo: { path: "test/card.test.ts", source: "extension", scope: "project", origin: "package" },
} as RegisteredTool;
const renderedTool = new ExtensionToolWrapper(new RegisteredToolAdapter(registered, unusedRunner), unusedRunner);

function component(): ToolExecutionComponent {
	return new ToolExecutionComponent(
		"todo",
		{ goal: { title: "Stop the double render" } },
		{ showImages: false, useBuiltInRenderer: false },
		renderedTool,
		headlessUi,
		process.cwd(),
		"todo-call",
	);
}

function settle(target: ToolExecutionComponent): void {
	target.updateArgs(initArgs);
	target.setArgsComplete();
	target.setExecutionStarted();
	target.updateResult({ content: result.content, details: result.details }, false, "todo-call");
}

function nativeStrings(target: ToolExecutionComponent): string[] {
	const found: string[] = [];
	const walk = (value: unknown): void => {
		if (typeof value === "string") found.push(value);
		else if (Array.isArray(value)) for (const item of value) walk(item);
		else if (value && typeof value === "object") for (const item of Object.values(value)) walk(item);
	};
	const context: DescribeContext = {
		cols: 80,
		reduceMotion: false,
		dark: true,
		supports: (kind) => kind === "tool",
		feature: () => false,
	};
	walk(target.describe(context));
	return found;
}

const count = (values: readonly string[], needle: string): number => values.filter((value) => value.includes(needle)).length;

describe("one card per todo call", () => {
	test("streaming arguments paint the uncommitted preview", () => {
		const pending = component();
		const lines = pending.render(100);
		const nodes = nativeStrings(pending);

		expect(count(lines, PREVIEW_MARKER)).toBe(1);
		expect(count(lines, "· 25m")).toBe(0);
		expect(count(nodes, PREVIEW_MARKER)).toBe(1);
		expect(count(nodes, PANEL_ROLE)).toBe(0);
		pending.stopAnimation();
	});

	test("the result replaces the call view in the ANSI transcript", () => {
		const settled = component();
		settle(settled);
		const lines = settled.render(100);

		expect(count(lines, PREVIEW_MARKER)).toBe(0);
		expect(count(lines, CARD_TOP)).toBe(1);
		expect(count(lines, "Read the merge path · 25m")).toBe(1);
		expect(count(lines, "Objective: Stop the double render")).toBe(1);
		settled.stopAnimation();
	});

	test("the result replaces the call view in the native card", () => {
		const settled = component();
		settle(settled);
		const nodes = nativeStrings(settled);

		expect(count(nodes, PREVIEW_MARKER)).toBe(0);
		expect(count(nodes, PREVIEW_ROLE)).toBe(0);
		expect(count(nodes, PANEL_ROLE)).toBe(1);
		expect(count(nodes, CHECKLIST_ROLE)).toBe(1);
		settled.stopAnimation();
	});

	test("an incremental update renders only the delta in ANSI and native cards until expanded", () => {
		const deltaArgs = { done_id: "t1" };
		const deltaSnapshot: TodoMoreSnapshot = {
			goal: snapshot.goal,
			phases: [
				{
					name: "Implementation",
					items: [
						{ ...snapshot.phases[0]!.items[0]!, status: "completed" },
						{ ...snapshot.phases[0]!.items[1]!, status: "in_progress" },
					],
				},
			],
		};
		const target = component();
		target.updateArgs(deltaArgs);
		target.setArgsComplete();
		target.setExecutionStarted();
		target.updateResult(
			{
				content: [{ type: "text", text: "Updated." }],
				details: {
					op: "done",
					operations: ["done"],
					changes: [{ op: "done", id: "t1", title: "Read the merge path" }],
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
					more: deltaSnapshot,
				},
			},
			false,
			"todo-call",
		);

		const collapsedLines = target.render(100);
		const collapsedNodes = nativeStrings(target);
		expect(count(collapsedLines, "Read the merge path · 25m")).toBe(1);
		expect(count(collapsedLines, "Set the flag · 10m")).toBe(0);
		expect(count(collapsedLines, "Objective: Stop the double render")).toBe(0);
		expect(count(collapsedNodes, "Read the merge path · 25m")).toBe(1);
		expect(count(collapsedNodes, "Set the flag · 10m")).toBe(0);
		expect(count(collapsedNodes, "Objective: Stop the double render")).toBe(0);

		target.setExpanded(true);
		const expandedLines = target.render(100);
		const expandedNodes = nativeStrings(target);
		expect(count(expandedLines, "Read the merge path · 25m")).toBe(1);
		expect(count(expandedLines, "Set the flag · 10m")).toBe(1);
		expect(count(expandedLines, "Objective: Stop the double render")).toBe(1);
		expect(count(expandedNodes, "Read the merge path · 25m")).toBe(1);
		expect(count(expandedNodes, "Set the flag · 10m")).toBe(1);
		target.stopAnimation();
	});
});
