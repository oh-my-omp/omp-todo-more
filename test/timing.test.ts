import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { foldBranch, readTodoMore } from "../src/branch.ts";
import {
	elapsedTime,
	estimatedMinutesSchema,
	type ItemTime,
	OVERTIME_TYPE,
	stateOf,
	TODO_MORE_NOTES_TYPE,
	type TodoItem,
	type TodoMoreState,
	toNotes,
	toSnapshot,
	transitionTime,
} from "../src/state.ts";
import { stateEntries, todoResultMessage } from "./host.ts";

const hasOvertimeWarning = (branch: readonly SessionEntry[], budgetId: string): boolean => foldBranch(branch).overtimeWarned.has(budgetId);

const epoch = Date.parse("2026-10-15T12:00:00.000Z");
const title = "Build runtime";
const goal = { objective: "Ship timing", measure: "Active time survives replay", doneWhen: "Timing is verified" };
const budget: Extract<ItemTime, { kind: "estimated" }> = {
	kind: "estimated",
	budgetId: "runtime-budget",
	minutes: 1,
	elapsedMs: 1_250,
	runningSince: null,
};

function customEntry(
	id: string,
	at: number,
	customType: string,
	data: unknown,
	parentId: string | null = null,
): Extract<SessionEntry, { type: "custom" }> {
	return { type: "custom", id, parentId, timestamp: new Date(at).toISOString(), customType, data };
}

function warningEntry(budgetId: string): Extract<SessionEntry, { type: "custom_message" }> {
	return {
		type: "custom_message",
		id: `warning-${budgetId}`,
		parentId: "snapshot-result",
		timestamp: new Date(epoch + 100_000).toISOString(),
		customType: OVERTIME_TYPE,
		content: "This budget has exceeded its estimate.",
		display: true,
		details: { budgetId, title, estimatedMinutes: 1, elapsedMs: 100_000 },
	};
}

function currentState(time: ItemTime = { ...budget, runningSince: epoch }): TodoMoreState {
	return stateOf({ kind: "set", goal }, [
		{
			name: "Delivery",
			items: [{ title, explanation: { kind: "explained", text: "Implement the runtime" }, status: "in_progress", time }],
		},
	]);
}

function requireItem(state: TodoMoreState, itemTitle: string = title): TodoItem {
	if (state.kind === "empty") throw new Error("Expected a nonempty list");
	const item = state.phases.flatMap((phase) => phase.items).find((candidate) => candidate.title === itemTitle);
	if (item === undefined) throw new Error(`Expected item ${itemTitle}`);
	return item;
}

function requireEstimate(time: ItemTime): Extract<ItemTime, { kind: "estimated" }> {
	if (time.kind !== "estimated") throw new Error("Expected an estimated item");
	return time;
}

describe("estimatedMinutesSchema", () => {
	const maximumMinutes = Math.floor(Number.MAX_SAFE_INTEGER / 60_000);

	for (const minutes of [1, 2, maximumMinutes]) {
		test(`accepts positive integer ${minutes} without changing its value`, () => {
			const parsed = estimatedMinutesSchema.safeParse(minutes);
			expect(parsed.success).toBe(true);
			if (!parsed.success) throw new Error("Expected a valid integer minute estimate");
			expect(parsed.data).toBe(minutes);
		});
	}

	for (const minutes of [
		0.01,
		0.5,
		1.5,
		0,
		-1,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
		maximumMinutes + 1,
		Number.MAX_SAFE_INTEGER / 60_000,
	]) {
		test(`rejects invalid minute estimate ${minutes}`, () => {
			expect(estimatedMinutesSchema.safeParse(minutes).success).toBe(false);
		});
	}
});

describe("active wall-time transitions", () => {
	test("pending pauses accumulated time until the item resumes", () => {
		const active = transitionTime(budget, "in_progress", epoch);
		expect(active).toEqual({ ...budget, runningSince: epoch });
		expect(elapsedTime(requireEstimate(active), epoch + 4_000)).toBe(5_250);

		const paused = transitionTime(active, "pending", epoch + 6_000);
		expect(paused).toEqual({ ...budget, elapsedMs: 7_250 });
		expect(elapsedTime(requireEstimate(paused), epoch + 25_000)).toBe(7_250);

		const resumed = transitionTime(paused, "in_progress", epoch + 30_000);
		expect(resumed).toEqual({ ...budget, elapsedMs: 7_250, runningSince: epoch + 30_000 });
		expect(elapsedTime(requireEstimate(resumed), epoch + 35_000)).toBe(12_250);
		expect(transitionTime(resumed, "completed", epoch + 35_000)).toEqual({ ...budget, elapsedMs: 12_250 });
		expect(budget).toEqual({ kind: "estimated", budgetId: "runtime-budget", minutes: 1, elapsedMs: 1_250, runningSince: null });
	});

	test("repeated active transitions preserve the original running interval", () => {
		const active = transitionTime(budget, "in_progress", epoch);
		const repeated = transitionTime(active, "in_progress", epoch + 2_000);
		expect(repeated).toEqual({ ...budget, runningSince: epoch });
		expect(elapsedTime(requireEstimate(repeated), epoch + 3_000)).toBe(4_250);
		expect(transitionTime(repeated, "pending", epoch + 4_000)).toEqual({ ...budget, elapsedMs: 5_250 });
	});

	test("status transitions never invent an estimate for imported items", () => {
		for (const status of ["in_progress", "pending", "completed", "abandoned"] as const) {
			expect(transitionTime({ kind: "missing" }, status, epoch)).toEqual({ kind: "missing" });
		}
	});
});

describe("branch timing replay", () => {
	test("a host result saved with a blocked task reads back as pending and keeps the item's notes", () => {
		const time: Extract<ItemTime, { kind: "estimated" }> = {
			kind: "estimated",
			budgetId: "waiting-budget",
			minutes: 6,
			elapsedMs: 45_000,
			runningSince: null,
		};
		const state = stateOf({ kind: "set", goal }, [
			{
				name: "Delivery",
				items: [{ title: "Waiting", explanation: { kind: "explained", text: "Blocked earlier" }, status: "pending", time }],
			},
		]);
		const [notes] = stateEntries("blocked", epoch, state);
		if (notes === undefined) throw new Error("Expected the notes entry");
		const result: SessionEntry = {
			type: "message",
			id: "blocked-result",
			parentId: null,
			timestamp: new Date(epoch).toISOString(),
			message: todoResultMessage(
				{ op: "update", phases: [{ name: "Delivery", tasks: [{ content: "Waiting", status: "blocked" }] }] },
				epoch,
			),
		};
		const item = requireItem(readTodoMore([notes, result]), "Waiting");
		expect(item.status).toBe("pending");
		expect("blocker" in item).toBe(false);
		expect(item.explanation).toEqual({ kind: "explained", text: "Blocked earlier" });
		expect(item.time).toEqual(time);
	});

	test("an item the host list holds without notes reads as lacking an explanation and a clock", () => {
		const result = stateEntries("host-only", epoch, currentState())[1];
		if (result === undefined) throw new Error("Expected the host result entry");
		const state = readTodoMore([result]);
		expect(state).toEqual({
			kind: "list",
			goal: { kind: "missing" },
			phases: [
				{ name: "Delivery", items: [{ title, explanation: { kind: "missing" }, status: "in_progress", time: { kind: "missing" } }] },
			],
		});
	});

	test("notes never contribute structure: an item absent from the host list stays absent", () => {
		const [notes, result] = stateEntries("with-extra", epoch, currentState());
		if (notes === undefined || result === undefined) throw new Error("Expected both entries");
		const removed = stateEntries("removed", epoch + 5_000, stateOf({ kind: "set", goal }, [{ name: "Delivery", items: [] }]))[1];
		if (removed === undefined) throw new Error("Expected the host result entry");
		expect(readTodoMore([notes, result, removed])).toEqual({ kind: "empty" });
	});

	test("notes follow the item they are keyed to when the host list reorders and statuses change", () => {
		const first: TodoItem = { title, explanation: { kind: "explained", text: "First" }, status: "pending", time: { ...budget } };
		const second: TodoItem = {
			title: "Verify results",
			explanation: { kind: "explained", text: "Second" },
			status: "completed",
			time: { ...budget, budgetId: "verification-budget" },
		};
		const notes = stateEntries("two", epoch, stateOf({ kind: "set", goal }, [{ name: "Delivery", items: [first, second] }]))[0];
		const reordered: SessionEntry = {
			type: "message",
			id: "reordered",
			parentId: null,
			timestamp: new Date(epoch + 1_000).toISOString(),
			message: todoResultMessage(
				{
					op: "update",
					phases: [
						{
							name: "Delivery",
							tasks: [
								{ content: "Verify results", status: "in_progress" },
								{ content: title, status: "pending" },
							],
						},
					],
				},
				epoch + 1_000,
			),
		};
		if (notes === undefined) throw new Error("Expected the notes entry");
		const state = readTodoMore([notes, reordered]);
		expect(
			state.kind === "list" &&
				state.phases[0]?.items.map((item) => [item.title, item.status, item.time.kind === "estimated" && item.time.budgetId]),
		).toEqual([
			["Verify results", "in_progress", "verification-budget"],
			[title, "pending", "runtime-budget"],
		]);
	});

	for (const phases of [[], [{ name: "Cleared", tasks: [] }]]) {
		test(`an empty ${phases.length === 0 ? "phase list" : "phase"} ends the list and the goal before a same-title rebuild`, () => {
			const entries = stateEntries("before", epoch, currentState());
			const cleared = stateEntries("clear", epoch + 5_000, { kind: "empty" });
			const clearedResult: SessionEntry = {
				type: "message",
				id: "clear-result",
				parentId: null,
				timestamp: new Date(epoch + 5_000).toISOString(),
				message: todoResultMessage({ op: "rm", phases }, epoch + 5_000),
			};
			const rebuilt = stateEntries(
				"rebuild",
				epoch + 10_000,
				stateOf({ kind: "missing" }, [
					{ name: "Rebuilt", items: [{ title, explanation: { kind: "missing" }, status: "in_progress", time: { kind: "missing" } }] },
				]),
			).slice(1);
			expect(readTodoMore([...entries, cleared[0]!, clearedResult])).toEqual({ kind: "empty" });
			expect(readTodoMore([...entries, cleared[0]!, clearedResult, ...rebuilt])).toEqual({
				kind: "list",
				goal: { kind: "missing" },
				phases: [
					{ name: "Rebuilt", items: [{ title, explanation: { kind: "missing" }, status: "in_progress", time: { kind: "missing" } }] },
				],
			});
		});
	}

	test("notes roundtrip and repeated replay retain each budget ID and running anchor", () => {
		const state = stateOf({ kind: "set", goal }, [
			{
				name: "Delivery",
				items: [
					{
						title,
						explanation: { kind: "explained", text: "Implement the runtime" },
						status: "in_progress",
						time: { ...budget, runningSince: epoch },
					},
					{
						title: "Verify results",
						explanation: { kind: "missing" },
						status: "pending",
						time: { ...budget, budgetId: "verification-budget", minutes: 4, elapsedMs: 30_000 },
					},
				],
			},
		]);
		const entries = stateEntries("roundtrip", epoch + 10_000, state);
		const firstReplay = readTodoMore(entries);
		expect(firstReplay).toEqual(state);
		expect(readTodoMore(entries)).toEqual(firstReplay);
		expect(readTodoMore(stateEntries("again", epoch + 60_000, firstReplay))).toEqual(state);
		expect(requireItem(firstReplay).time).toEqual({ ...budget, runningSince: epoch });
		expect(requireItem(firstReplay, "Verify results").time).toEqual({
			...budget,
			budgetId: "verification-budget",
			minutes: 4,
			elapsedMs: 30_000,
		});
		expect(elapsedTime(requireEstimate(requireItem(firstReplay).time), epoch + 90_000)).toBe(91_250);
	});

	test("a notes entry carries no status or order of its own", () => {
		const [notes] = stateEntries("shape", epoch, currentState());
		expect(notes?.type === "custom" && notes.customType).toBe(TODO_MORE_NOTES_TYPE);
		const data = toNotes(currentState());
		expect(Object.keys(data).sort()).toEqual(["goal", "items"]);
		expect(Object.keys(data.items[0] ?? {}).sort()).toEqual(["explanation", "phase", "time", "title"]);
	});
});

describe("overtime warning facts", () => {
	test("warnings belong to a budget, not to an item's current title or replacement estimate", () => {
		const original = stateEntries("snapshot", epoch, currentState());
		const warning = warningEntry(budget.budgetId);
		const replacement = stateEntries(
			"replacement",
			epoch + 110_000,
			currentState({ ...budget, budgetId: "replacement-budget", minutes: 3, runningSince: epoch }),
		);
		const branch: readonly SessionEntry[] = [...original, warning, ...replacement];
		expect(requireItem(readTodoMore(branch)).title).toBe(title);
		expect(hasOvertimeWarning(branch, budget.budgetId)).toBe(true);
		expect(hasOvertimeWarning(branch, "replacement-budget")).toBe(false);
		expect(hasOvertimeWarning(branch, `${budget.budgetId}-other`)).toBe(false);
		expect(
			hasOvertimeWarning(
				[{ ...warning, details: { budgetId: budget.budgetId, title: "Previous title", estimatedMinutes: 1, elapsedMs: 100_000 } }],
				budget.budgetId,
			),
		).toBe(true);
	});

	test("only a matching delivered custom message with complete warning details is a fact", () => {
		const warning = warningEntry(budget.budgetId);
		const nonFacts: readonly SessionEntry[] = [
			customEntry("intent", epoch, OVERTIME_TYPE, warning.details),
			{ ...warning, id: "other-type", customType: `${OVERTIME_TYPE}.intent` },
			{ ...warning, id: "incomplete", details: { budgetId: budget.budgetId, title, estimatedMinutes: 1 } },
			{ ...warning, id: "invalid", details: { budgetId: budget.budgetId, title, estimatedMinutes: "1", elapsedMs: 100_000 } },
		];
		expect(hasOvertimeWarning(nonFacts, budget.budgetId)).toBe(false);
		expect(hasOvertimeWarning([...nonFacts, warning], budget.budgetId)).toBe(true);
	});

	test("warning messages neither alter clock snapshots nor survive as copied snapshot facts", () => {
		const state = currentState();
		const snapshot = toSnapshot(state);
		const entries = stateEntries("snapshot", epoch, state);
		const branch: readonly SessionEntry[] = [...entries, warningEntry(budget.budgetId)];
		expect(readTodoMore(branch)).toEqual(state);
		expect(toSnapshot(readTodoMore(branch))).toEqual(snapshot);
		expect(snapshot.phases[0]?.items[0]?.time).toEqual({ ...budget, runningSince: epoch });
		expect(snapshot.phases[0]?.items[0]?.time).not.toHaveProperty("notifiedAt");
		expect(hasOvertimeWarning(branch, budget.budgetId)).toBe(true);
		const snapshotOnly = stateEntries("restored-snapshot", epoch + 120_000, readTodoMore(branch));
		expect(readTodoMore(snapshotOnly)).toEqual(state);
		expect(hasOvertimeWarning(snapshotOnly, budget.budgetId)).toBe(false);
		expect(hasOvertimeWarning(entries, budget.budgetId)).toBe(false);
	});
});
