import { describe, expect, test } from "bun:test";
import { ensureThemeSync, type NativeChild, type NativeNode, theme } from "@oh-my-pi/pi-tui";
import { describeSnapshot, describeTodoHud, describeTodoResult } from "../src/native.ts";
import { renderReminder } from "../src/reminders.tsx";
import type { TodoNgSnapshot, TodoStatus } from "../src/state.ts";
import type { TodoNgDetails } from "../src/tool.ts";

const snapshot: TodoNgSnapshot = {
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
					id: "t1",
					title: "Plan the replacement",
					explanation: "Keep the host projection",
					status: "pending",
					estimate: { kind: "missing" },
					commit: null,
				},
				{
					id: "t2",
					title: "Implement the card",
					explanation: "Use the native checklist",
					status: "in_progress",
					estimate: { kind: "estimated", budgetId: "implement-budget", minutes: 25 },
					commit: null,
				},
			],
		},
		{
			name: "Verification",
			items: [
				{
					id: "t3",
					title: "Inspect saved fields",
					explanation: "Read the historical result",
					status: "completed",
					estimate: { kind: "estimated", budgetId: "inspect-budget", minutes: 10 },
					commit: null,
				},
				{
					id: "t4",
					title: "Old approach",
					explanation: "No longer needed",
					status: "abandoned",
					estimate: { kind: "missing" },
					commit: null,
				},
				{
					id: "t5",
					title: "Check runtime",
					explanation: "Exercise the real native consumer",
					status: "pending",
					estimate: { kind: "estimated", budgetId: "runtime-budget", minutes: 12 },
					commit: null,
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

function resultFor(more: TodoNgSnapshot): Parameters<typeof describeTodoResult>[0] & { details: TodoNgDetails } {
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
		expect(checklist(body).phases.map((phase) => phase.title)).toEqual(["Delivery", "Verification"]);
		const items = rows(body);
		expect(items.map(({ text, status }) => ({ text, status }))).toEqual([
			{ text: "Plan the replacement", status: "pending" },
			{ text: "Implement the card", status: "active" },
			{ text: "Inspect saved fields", status: "done" },
			{ text: "Old approach", status: "dropped" },
			{ text: "Check runtime", status: "pending" },
		]);
		const notes = items.map((item) => (typeof item.note === "string" ? item.note : ""));
		expect(notes.map((note) => note.match(/(\d+) min/)?.[1] ?? null)).toEqual([null, "25", "10", null, "12"]);
		expect(notes).toEqual([
			expect.stringContaining("Keep the host projection"),
			expect.stringContaining("Use the native checklist"),
			expect.stringContaining("Read the historical result"),
			expect.stringContaining("No longer needed"),
			expect.stringContaining("Exercise the real native consumer"),
		]);
	});

	test("keeps missing goal, estimate, and explanation visible without inventing goal tasks", () => {
		const body = describeSnapshot({
			goal: null,
			phases: [
				{
					name: "Imported",
					items: [
						{
							id: "t1",
							title: "Imported task",
							status: "pending",
							explanation: null,
							estimate: { kind: "missing" },
							commit: null,
						},
					],
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
				note: expect.stringContaining("[explanation missing]"),
			},
		]);
		const note = only(checklist(body).phases.flatMap((phase) => phase.items)).note;
		expect(note).toContain("no time estimate");
		expect(note).not.toMatch(/Estimate:\s*\d/);
	});

	test("a committed completion shows its commit in the row and its expanded note", () => {
		const committed: TodoNgSnapshot = {
			goal: snapshot.goal,
			phases: [
				{
					name: "Delivery",
					items: [
						{
							id: "t1",
							title: "Implement the card",
							explanation: "Use the native checklist",
							status: "completed",
							estimate: { kind: "estimated", budgetId: "implement-budget", minutes: 25 },
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
		expect(expanded.note).toContain("0123456");
		expect(expanded.note).toContain("Implement the card");
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
			const editControls = nodes.filter((entry) => entry.k === "row" && entry.p?.actions?.click === "todo-ng.open");
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
							id: `t${index + 1}`,
							title: `Task ${index + 1}`,
							status,
							explanation: null,
							estimate: { kind: "missing" } as const,
							commit: null,
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
					{
						name: "Closed",
						items: [
							{
								id: "t1",
								title: "Old",
								explanation: "Done already",
								status: "completed",
								estimate: { kind: "missing" },
								commit: null,
							},
						],
					},
					{
						name: "Open",
						items: [
							{
								id: "t2",
								title: "Waiting task",
								explanation: "Waits",
								status: "pending",
								estimate: { kind: "estimated", budgetId: "open-budget", minutes: 12 },
								commit: null,
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
		expect(
			rows(body)
				.map((item) => (typeof item.note === "string" ? item.note : ""))
				.join("\n"),
		).toContain("Keep the host projection");
	});

	test("settled header shows closed/total progress, and an empty list shows only the title", () => {
		const progress = describeTodoResult(
			resultFor({
				goal: { objective: "Ship", measure: "Measured", doneWhen: "Done" },
				phases: [
					{
						name: "Open",
						items: [
							{
								id: "t1",
								title: "Done",
								explanation: "Shipped",
								status: "completed",
								estimate: { kind: "missing" },
								commit: null,
							},
							{
								id: "t2",
								title: "Next",
								explanation: "Pending",
								status: "pending",
								estimate: { kind: "missing" },
								commit: null,
							},
						],
					},
				],
			}),
			{ expanded: false, isPartial: false },
		);
		expect(progress?.tool?.target).toBe("1/2");

		const empty = describeTodoResult(resultFor({ goal: null, phases: [] }), { expanded: false, isPartial: false });
		expect(empty?.tool?.target).toBeUndefined();
	});

	test("incremental CRUD shows only changed items while collapsed, and expanding restores the full snapshot", () => {
		const updated = structuredClone(snapshot);
		if (updated.phases[0] === undefined) throw new Error("Expected the Delivery phase");
		updated.phases[0].items = updated.phases[0].items.map((item) => (item.id === "t1" ? { ...item, status: "completed" } : item));
		const crudResult = resultFor(updated);
		crudResult.details.op = "batch";
		crudResult.details.operations = ["done", "explain"];
		crudResult.details.changes = [
			{ op: "done", id: "t1", title: "Plan the replacement", commit: null },
			{ op: "explain", id: "t2", title: "Implement the card", explanation: "Use the native checklist" },
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
			{ text: "Implement the card · 25m", status: "active", note: expect.stringContaining("Use the native checklist") },
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

	test("a drop delta shows only the dropped task without listing surviving tasks", () => {
		const dropped = structuredClone(snapshot);
		const delivery = dropped.phases[0];
		if (delivery === undefined) throw new Error("Expected the Delivery phase");
		delivery.items = delivery.items.map((item) => (item.id === "t1" ? { ...item, status: "abandoned" } : item));
		const dropResult = resultFor(dropped);
		dropResult.details.op = "drop";
		dropResult.details.operations = ["drop"];
		dropResult.details.changes = [{ op: "drop", id: "t1", title: "Plan the replacement" }];

		const body = resultBody(dropResult, false);
		expect(checklist(body).phases.map((phase) => phase.title)).toEqual(["Delivery"]);
		expect(rows(body).map((item) => ({ text: item.text, status: item.status }))).toEqual([
			{ text: "Plan the replacement · no estimate", status: "dropped" },
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
		expect(ansi).toContain("2 incomplete");
		expect(ansi).toContain("1/3");
		expect(ansi).not.toContain("Plan the replacement");
		expect(ansi).not.toContain("Implement the card");

		const described = component.describe?.({ supports: () => true } as never);
		if (described === undefined || described === null) throw new Error("Expected a native reminder node");
		const allNodes = nativeNodes([described]);
		expect(allNodes.filter((entry) => entry.k === "checklist")).toHaveLength(0);
		expect(allNodes.filter((entry) => entry.k === "kv")).toHaveLength(0);
		expect(JSON.stringify(described)).toContain("2 incomplete");
		expect(JSON.stringify(described)).not.toContain("Plan the replacement");
	});
});

describe("native historical todo results", () => {
	test("renders each result's own details.more after a different, newer snapshot was rendered", () => {
		const historical = resultFor(snapshot);
		const newer = resultFor({
			goal: { objective: "A new objective", measure: "A new measure", doneWhen: "A new completion boundary" },
			phases: [
				{
					name: "New phase",
					items: [
						{
							id: "t1",
							title: "A new task",
							explanation: "Only in the new result",
							status: "completed",
							estimate: { kind: "missing" },
							commit: null,
						},
					],
				},
				{
					name: "Verification",
					items: [
						{
							id: "t2",
							title: "Check runtime",
							explanation: "A newer runtime check",
							status: "completed",
							estimate: { kind: "estimated", budgetId: "runtime-budget", minutes: 45 },
							commit: null,
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
		expect(rows(newerBody)[1]?.note).toContain("A newer runtime check");
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
		expect(rows(historicalBody)[4]?.note).toContain("Exercise the real native consumer");
	});
});
