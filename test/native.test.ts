import { describe, expect, test } from "bun:test";
import { ensureThemeSync, type NativeChild, type NativeNode, theme } from "@oh-my-pi/pi-tui";
import { describeSnapshot, describeTodoHud, describeTodoResult } from "../src/native.ts";
import { renderReminder } from "../src/reminders.ts";
import { detailsSchema } from "../src/render.ts";
import type { TodoMoreSnapshot, TodoStatus } from "../src/state.ts";
import type { TodoMoreDetails } from "../src/tool.ts";

const snapshot: TodoMoreSnapshot = {
	goal: {
		objective: "Ship the native todo replacement",
		measure: "Every task and explanation is visible",
		doneWhen: "The replacement preserves all rich todo fields",
	},
	phases: [
		{
			name: "Delivery",
			items: [
				{
					title: "Plan the replacement",
					explanation: "Keep the host projection",
					status: "pending",
					time: { kind: "missing" },
				},
				{
					title: "Implement the card",
					explanation: "Use the native checklist",
					status: "in_progress",
					time: { kind: "estimated", budgetId: "implement-budget", minutes: 25, elapsedMs: 60_000, runningSince: 120_000 },
				},
			],
		},
		{
			name: "Verification",
			items: [
				{
					title: "Inspect saved fields",
					explanation: "Read the historical result",
					status: "completed",
					time: { kind: "estimated", budgetId: "inspect-budget", minutes: 10, elapsedMs: 180_000, runningSince: null },
				},
				{
					title: "Old approach",
					explanation: "No longer needed",
					status: "abandoned",
					time: { kind: "missing" },
				},
				{
					title: "Check runtime",
					explanation: "Exercise the real native consumer",
					status: "pending",
					time: { kind: "estimated", budgetId: "runtime-budget", minutes: 12, elapsedMs: 120_000, runningSince: null },
				},
			],
		},
	],
};

function nativeNodes(children: readonly NativeChild[]): NativeNode[] {
	const nodes: NativeNode[] = [];
	for (const child of children) {
		if (!("k" in child)) throw new Error("Expected native descriptors, not an ANSI component");
		nodes.push(child, ...nativeNodes(child.c ?? []));
	}
	return nodes;
}

function only<T>(values: readonly T[]): T {
	expect(values).toHaveLength(1);
	const value = values[0];
	if (value === undefined) throw new Error("Expected one native descriptor");
	return value;
}

function checklist(children: readonly NativeChild[]) {
	const list = only(
		nativeNodes(children)
			.filter((entry) => entry.k === "checklist")
			.filter((entry) => entry.p?.mode === "full"),
	);
	if (list.p === undefined) throw new Error("Expected checklist properties");
	return list.p;
}

function goalItems(children: readonly NativeChild[]) {
	const goal = only(nativeNodes(children).filter((entry) => entry.k === "kv"));
	if (goal.p === undefined) throw new Error("Expected goal properties");
	return goal.p.items;
}

function resultFor(more: TodoMoreSnapshot): Parameters<typeof describeTodoResult>[0] & { details: TodoMoreDetails } {
	return {
		content: [{ type: "text", text: "This summary is not the native snapshot." }],
		details: {
			todoMore: true,
			storage: "session",
			phases: more.phases.map((phase) => ({
				name: phase.name,
				tasks: phase.items.map((item) => ({ content: item.title, status: item.status })),
			})),
			more,
		},
	};
}

function resultBody(result: Parameters<typeof describeTodoResult>[0], expanded = false): readonly NativeChild[] {
	const view = describeTodoResult(result, { expanded, isPartial: false });
	if (view?.body === undefined) throw new Error("Expected a native result body");
	return view.body;
}

function rows(children: readonly NativeChild[]) {
	return checklist(children).phases.flatMap((phase) => phase.items);
}

describe("native todo presentation", () => {
	test("expanded disclosure preserves all goal fields, all four statuses, and estimate and explanation notes", () => {
		const hud = describeTodoHud(snapshot, true);
		if (hud === null) throw new Error("Expected a native HUD");
		const body = [hud];

		expect(goalItems(body)).toEqual([
			{ k: "Objective", v: "Ship the native todo replacement" },
			{ k: "Measure", v: "Every task and explanation is visible" },
			{ k: "Done when", v: "The replacement preserves all rich todo fields" },
		]);
		expect(checklist(body)).toMatchObject({
			phases: [
				{
					title: "Delivery",
					items: [
						{
							text: "Plan the replacement",
							status: "pending",
							note: expect.stringContaining("Explanation: Keep the host projection"),
						},
						{
							text: "Implement the card",
							status: "active",
							note: "Estimate: 25 min\nExplanation: Use the native checklist",
						},
					],
				},
				{
					title: "Verification",
					items: [
						{
							text: "Inspect saved fields",
							status: "done",
							note: "Estimate: 10 min\nExplanation: Read the historical result",
						},
						{
							text: "Old approach",
							status: "dropped",
							note: expect.stringContaining("Explanation: No longer needed"),
						},
						{
							text: "Check runtime",
							status: "pending",
							note: "Estimate: 12 min\nExplanation: Exercise the real native consumer",
						},
					],
				},
			],
		});
	});

	test("keeps missing goal, estimate, and explanation visible without inventing goal tasks", () => {
		const body = describeSnapshot({
			goal: null,
			phases: [
				{
					name: "Imported",
					items: [{ title: "Imported task", status: "pending", explanation: null, time: { kind: "missing" } }],
				},
			],
		});

		expect(goalItems(body)).toEqual([
			{ k: "Objective", v: "[goal missing]" },
			{ k: "Measure", v: "[goal missing]" },
			{ k: "Done when", v: "[goal missing]" },
		]);
		expect(checklist(body).phases.flatMap((phase) => phase.items.map(({ text, status, note }) => ({ text, status, note })))).toEqual([
			{
				text: "Imported task",
				status: "pending",
				note: expect.stringContaining("Explanation: [explanation missing]"),
			},
		]);
		const note = only(checklist(body).phases.flatMap((phase) => phase.items)).note;
		expect(note).toMatch(/no time estimate/i);
		expect(note).not.toMatch(/Estimate:\s*\d/);
	});

	test("a committed completion shows its commit in the row and its expanded note", () => {
		const committed: TodoMoreSnapshot = {
			goal: snapshot.goal,
			phases: [
				{
					name: "Delivery",
					items: [
						{
							title: "Implement the card",
							explanation: "Use the native checklist",
							status: "completed",
							time: { kind: "estimated", budgetId: "implement-budget", minutes: 25, elapsedMs: 60_000, runningSince: null },
							commit: {
								sha: "0123456789abcdef0123456789abcdef01234567",
								message: "Implement the card",
								scope: { kind: "paths", files: ["src/native.ts"] },
							},
						},
					],
				},
			],
		};
		const expanded = only(rows(resultBody(resultFor(committed), true)));
		expect(expanded.text).toContain("0123456");
		expect(expanded.note).toContain('Commit: 0123456 "Implement the card"');
		const collapsed = only(rows(resultBody(resultFor(committed))));
		expect(collapsed.text).toContain("0123456");
		expect(collapsed.note).toBeUndefined();
	});
});

describe("native todo HUD", () => {
	test("empty lists have no HUD, including a phase with no tasks", () => {
		expect(describeTodoHud({ goal: null, phases: [] })).toBeNull();
		expect(describeTodoHud({ goal: snapshot.goal, phases: [{ name: "Empty phase", items: [] }] })).toBeNull();
	});

	test("rich goal, full checklist, and edit content appear only when expanded", () => {
		for (const expanded of [false, true]) {
			const hud = describeTodoHud(snapshot, expanded);
			if (hud === null) throw new Error("Expected a native HUD");
			const nodes = nativeNodes([hud]);

			expect(nodes.filter((entry) => entry.k === "kv")).toHaveLength(expanded ? 1 : 0);
			expect(nodes.filter((entry) => entry.k === "checklist" && entry.p?.mode === "full")).toHaveLength(expanded ? 1 : 0);
			const editControls = nodes.filter((entry) => entry.k === "text" && entry.p?.text === "Edit goal / explanations");
			expect(editControls).toHaveLength(expanded ? 1 : 0);
		}
	});

	test.each([
		{
			name: "first in_progress takes precedence over pending and later in_progress",
			statuses: ["pending", "in_progress", "in_progress", "completed", "abandoned", "pending"],
			label: "Task 2 2/6",
		},
		{
			name: "first pending takes precedence when no task is in_progress",
			statuses: ["pending", "pending", "completed"],
			label: "Task 1 1/3",
		},
		{
			name: "completed and abandoned tasks are both closed",
			statuses: ["abandoned", "completed"],
			label: "All done 2/2",
		},
	] satisfies { name: string; statuses: TodoStatus[]; label: string }[])("$name", ({ statuses, label }) => {
		const hud = describeTodoHud(
			{
				goal: null,
				phases: [
					{
						name: "Progress",
						items: statuses.map((status, index) => ({
							title: `Task ${index + 1}`,
							status,
							explanation: null,
							time: { kind: "missing" },
						})),
					},
				],
			},
			false,
		);
		if (hud === null) throw new Error("Expected a native HUD");
		const headings = nativeNodes([hud]).flatMap((entry) =>
			entry.p !== undefined && "head" in entry.p && typeof entry.p.head === "string" ? [entry.p.head] : [],
		);

		expect(headings).toContain(label);
	});
});

describe("native result card", () => {
	test("collapsed card shows only the objective, folds closed phases, and keeps estimates on each row", () => {
		const body = resultBody(
			resultFor({
				goal: { objective: "Ship", measure: "Measured", doneWhen: "Done" },
				phases: [
					{ name: "Closed", items: [{ title: "Old", explanation: "Done already", status: "completed", time: { kind: "missing" } }] },
					{
						name: "Open",
						items: [
							{
								title: "Waiting task",
								explanation: "Waits",
								status: "pending",
								time: { kind: "estimated", budgetId: "open-budget", minutes: 12, elapsedMs: 0, runningSince: null },
							},
						],
					},
				],
			}),
		);

		expect(nativeNodes(body).filter((entry) => entry.k === "kv")).toHaveLength(0);
		expect(
			nativeNodes(body)
				.filter((entry) => entry.k === "text")
				.map((entry) => entry.p?.text),
		).toContain("Objective: Ship");
		expect(checklist(body).phases.map((phase) => phase.collapsed)).toEqual([true, false]);
		expect(rows(body).map((item) => item.note)).toEqual([undefined, undefined]);
		expect(rows(body)[1]?.text).toBe("Waiting task · 12m");
	});

	test("expanded card restores every goal field and each row's explanation", () => {
		const body = resultBody(resultFor(snapshot), true);

		expect(goalItems(body)).toEqual([
			{ k: "Objective", v: "Ship the native todo replacement" },
			{ k: "Measure", v: "Every task and explanation is visible" },
			{ k: "Done when", v: "The replacement preserves all rich todo fields" },
		]);
		expect(rows(body).map((item) => item.note)).toContain("Explanation: Keep the host projection");
	});

	test("settled header shows closed/total progress, and an empty list shows only the title", () => {
		const progress = describeTodoResult(
			resultFor({
				goal: { objective: "Ship", measure: "Measured", doneWhen: "Done" },
				phases: [
					{
						name: "Open",
						items: [
							{ title: "Done", explanation: "Shipped", status: "completed", time: { kind: "missing" } },
							{ title: "Next", explanation: "Pending", status: "pending", time: { kind: "missing" } },
						],
					},
				],
			}),
			{ expanded: false, isPartial: false },
		);
		expect(progress?.tool).toEqual({ title: "Todo", target: "1/2", targetKind: "text" });

		const empty = describeTodoResult(resultFor({ goal: null, phases: [] }), { expanded: false, isPartial: false });
		expect(empty?.tool).toEqual({ title: "Todo" });
	});

	test("incremental CRUD shows only changed items while collapsed, and expanding restores the full snapshot", () => {
		const updated = structuredClone(snapshot);
		updated.phases[0]!.items[0]!.status = "completed";
		const crudResult = resultFor(updated);
		crudResult.details.op = "batch";
		crudResult.details.operations = ["done", "explain"];
		crudResult.details.changes = [
			{ op: "done", task: "Plan the replacement" },
			{ op: "explain", task: "Implement the card", explanation: "Use the native checklist" },
		];

		const collapsedBody = resultBody(crudResult, false);
		expect(nativeNodes(collapsedBody).filter((entry) => entry.k === "kv")).toHaveLength(0);
		expect(
			nativeNodes(collapsedBody)
				.filter((entry) => entry.k === "text")
				.map((entry) => entry.p?.text),
		).toEqual([]);
		expect(checklist(collapsedBody).phases.map((phase) => phase.title)).toEqual(["Delivery"]);
		expect(rows(collapsedBody).map((item) => ({ text: item.text, status: item.status, note: item.note }))).toEqual([
			{ text: "Plan the replacement · no estimate", status: "done", note: undefined },
			{ text: "Implement the card · 25m", status: "active", note: "Explanation: Use the native checklist" },
		]);

		const expandedBody = resultBody(crudResult, true);
		expect(goalItems(expandedBody)).toEqual([
			{ k: "Objective", v: "Ship the native todo replacement" },
			{ k: "Measure", v: "Every task and explanation is visible" },
			{ k: "Done when", v: "The replacement preserves all rich todo fields" },
		]);
		expect(checklist(expandedBody).phases.map((phase) => phase.title)).toEqual(["Delivery", "Verification"]);
		expect(rows(expandedBody)).toHaveLength(5);
	});

	test("RM delta shows only the removed task without listing surviving tasks", () => {
		const remaining = structuredClone(snapshot);
		remaining.phases[0]!.items = remaining.phases[0]!.items.slice(1);
		const rmResult = resultFor(remaining);
		rmResult.details.op = "rm";
		rmResult.details.operations = ["rm"];
		rmResult.details.changes = [{ op: "rm", task: "Plan the replacement" }];

		const body = resultBody(rmResult, false);
		expect(checklist(body).phases.map((phase) => phase.title)).toEqual(["Removed"]);
		expect(rows(body).map((item) => ({ text: item.text, status: item.status }))).toEqual([
			{ text: "Plan the replacement · removed", status: "dropped" },
		]);
	});

	test("active reminder renders only the reminder event and no todo items", () => {
		ensureThemeSync();
		const component = renderReminder(
			{
				role: "custom",
				customType: "mouriya.omp.todo-more.reminder",
				content: "unused",
				display: true,
				timestamp: Date.now(),
				details: {
					items: [
						{ phase: "Delivery", title: "Plan the replacement" },
						{ phase: "Delivery", title: "Implement the card" },
					],
					attempt: 1,
					max: 3,
					more: snapshot,
				},
			},
			{ expanded: false },
			theme,
		);
		if (component === undefined) throw new Error("Expected a reminder component");

		const ansi = component.render(100).join("\n");
		expect(ansi).toContain("2 incomplete todos - reminder 1/3");
		expect(ansi).not.toContain("Plan the replacement");
		expect(ansi).not.toContain("Implement the card");

		const described = component.describe?.({ supports: () => true } as never);
		if (described === undefined || described === null) throw new Error("Expected a native reminder node");
		const allNodes = nativeNodes([described]);
		expect(allNodes.filter((entry) => entry.k === "checklist")).toHaveLength(0);
		expect(allNodes.filter((entry) => entry.k === "kv")).toHaveLength(0);
		expect(JSON.stringify(described)).toContain("2 incomplete todos - reminder 1/3");
		expect(JSON.stringify(described)).not.toContain("Plan the replacement");
	});
});

describe("native historical todo results", () => {
	test("renders each result's own details.more and timing after a different, newer snapshot was rendered", () => {
		const historical = resultFor(snapshot);
		const newer = resultFor({
			goal: { objective: "A new objective", measure: "A new measure", doneWhen: "A new completion boundary" },
			phases: [
				{
					name: "New phase",
					items: [{ title: "A new task", explanation: "Only in the new result", status: "completed", time: { kind: "missing" } }],
				},
				{
					name: "Verification",
					items: [
						{
							title: "Check runtime",
							explanation: "A newer runtime check",
							status: "completed",
							time: { kind: "estimated", budgetId: "runtime-budget", minutes: 45, elapsedMs: 300_000, runningSince: null },
						},
					],
				},
			],
		});
		historical.details = { ...historical.details, phases: newer.details.phases };
		const newerBody = resultBody(newer, true);
		const historicalBody = resultBody(historical, true);

		expect(goalItems(newerBody)).toEqual([
			{ k: "Objective", v: "A new objective" },
			{ k: "Measure", v: "A new measure" },
			{ k: "Done when", v: "A new completion boundary" },
		]);
		expect(rows(newerBody).map((item) => item.text)).toEqual(["A new task · no estimate", "Check runtime · 45m"]);
		expect(rows(newerBody)[1]?.note).toBe("Explanation: A newer runtime check");
		expect(goalItems(historicalBody)).toEqual([
			{ k: "Objective", v: "Ship the native todo replacement" },
			{ k: "Measure", v: "Every task and explanation is visible" },
			{ k: "Done when", v: "The replacement preserves all rich todo fields" },
		]);
		expect(rows(historicalBody).map((item) => item.text)).toEqual([
			"Plan the replacement · no estimate",
			"Implement the card · 25m",
			"Inspect saved fields · 10m",
			"Old approach · no estimate",
			"Check runtime · 12m",
		]);
		expect(rows(historicalBody)[4]?.note).toBe("Explanation: Exercise the real native consumer");
	});
});

describe("legacy persisted todo results", () => {
	test("detailsSchema reads results written before block and unblock were removed", () => {
		const raw = {
			op: "batch",
			operations: ["done", "block", "unblock", "explain"],
			changes: [
				{ op: "done", task: "Keep" },
				{ op: "block", task: "Keep", reason: "Waiting for service" },
				{ op: "unblock", task: "Keep" },
				{ op: "explain", task: "Keep", explanation: "Updated" },
			],
			phases: [{ name: "Delivery", tasks: [{ content: "Keep", status: "blocked" }] }],
			storage: "session",
			todoMore: true,
			more: {
				goal: null,
				phases: [
					{
						name: "Delivery",
						items: [
							{
								title: "Keep",
								explanation: "Persisted",
								status: "blocked",
								blocker: "Waiting for service",
								time: { kind: "missing" },
							},
						],
					},
				],
			},
		};
		const parsed = detailsSchema.safeParse(raw);
		expect(parsed.success).toBe(true);
		if (!parsed.success) throw new Error("Expected legacy result details to parse");
		expect(parsed.data.operations).toEqual(["done", "explain"]);
		expect(parsed.data.changes).toEqual([
			{ op: "done", task: "Keep" },
			{ op: "explain", task: "Keep", explanation: "Updated" },
		]);
		expect(parsed.data.phases[0]?.tasks[0]?.status).toBe("pending");
		const item = parsed.data.more.phases[0]?.items[0];
		expect(item?.status).toBe("pending");
		expect(item !== undefined && "blocker" in item).toBe(false);
	});
});
