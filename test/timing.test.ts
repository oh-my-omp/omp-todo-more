import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { foldBranch } from "../src/branch.ts";
import {
	dueAt,
	type Estimate,
	elapsedOf,
	estimatedMinutesSchema,
	FRESH,
	OVERTIME_TYPE,
	type Progress,
	stateOf,
	type TodoItem,
	type TodoNgState,
	toSnapshot,
	transition,
} from "../src/state.ts";
import { stateEntries, todoResultMessage } from "./host.ts";

const stateOfBranch = (branch: readonly SessionEntry[]): TodoNgState => foldBranch(branch).state;

const hasOvertimeWarning = (branch: readonly SessionEntry[], budgetId: string): boolean => foldBranch(branch).overtimeWarned.has(budgetId);

const epoch = Date.parse("2026-10-15T12:00:00.000Z");
const title = "Build runtime";
const goal = { objective: "Ship timing", measure: "Active time survives replay", doneWhen: "Timing is verified" };
const budgetId = "runtime-budget";
const estimate: Estimate = { kind: "estimated", budgetId, minutes: 1 };
const idle: Progress = { status: "pending", startedAt: null, elapsedMs: 1_250, pausedAt: null };
const running: Progress = { status: "in_progress", startedAt: epoch, elapsedMs: 1_250, runningSince: epoch };

function customEntry(
	id: string,
	at: number,
	customType: string,
	data: unknown,
	parentId: string | null = null,
): Extract<SessionEntry, { type: "custom" }> {
	return { type: "custom", id, parentId, timestamp: new Date(at).toISOString(), customType, data };
}

function warningEntry(warnedBudget: string): Extract<SessionEntry, { type: "custom_message" }> {
	return {
		type: "custom_message",
		id: `warning-${warnedBudget}`,
		parentId: "snapshot-result",
		timestamp: new Date(epoch + 100_000).toISOString(),
		customType: OVERTIME_TYPE,
		content: "This budget has exceeded its estimate.",
		display: true,
		details: { budgetId: warnedBudget, title, estimatedMinutes: 1, elapsedMs: 100_000 },
	};
}

function itemOf(progress: Progress, value: Estimate = estimate): TodoItem {
	return { id: "t1", title, explanation: { kind: "missing" }, estimate: value, progress, commit: null, tailRule: null };
}

function currentState(progress: Progress = running, value: Estimate = estimate): TodoNgState {
	return stateOf({ kind: "set", goal }, [{ name: "Delivery", items: [itemOf(progress, value)] }]);
}

function requireItem(state: TodoNgState, itemTitle: string = title): TodoItem {
	if (state.kind === "empty") throw new Error("Expected a nonempty list");
	const item = state.phases.flatMap((phase) => phase.items).find((candidate) => candidate.title === itemTitle);
	if (item === undefined) throw new Error(`Expected item ${itemTitle}`);
	return item;
}

describe("estimatedMinutesSchema", () => {
	const maximumMinutes = Math.floor(Number.MAX_SAFE_INTEGER / 60_000);

	test("accepts the largest minute count that still converts to exact milliseconds", () => {
		expect(estimatedMinutesSchema.safeParse(maximumMinutes).success).toBe(true);
	});

	test("rejects one minute more than milliseconds can represent exactly", () => {
		expect(estimatedMinutesSchema.safeParse(maximumMinutes + 1).success).toBe(false);
	});
});

describe("active wall-time transitions", () => {
	test("pending pauses accumulated time until the item resumes", () => {
		const active = transition(idle, "in_progress", epoch);
		expect(active).toEqual({ status: "in_progress", startedAt: epoch, elapsedMs: 1_250, runningSince: epoch });
		expect(elapsedOf(active, epoch + 4_000)).toBe(5_250);

		const paused = transition(active, "pending", epoch + 6_000);
		expect(paused).toEqual({ status: "pending", startedAt: epoch, elapsedMs: 7_250, pausedAt: epoch + 6_000 });
		expect(elapsedOf(paused, epoch + 25_000)).toBe(7_250);

		const resumed = transition(paused, "in_progress", epoch + 30_000);
		expect(resumed).toEqual({ status: "in_progress", startedAt: epoch, elapsedMs: 7_250, runningSince: epoch + 30_000 });
		expect(elapsedOf(resumed, epoch + 35_000)).toBe(12_250);
		expect(transition(resumed, "completed", epoch + 35_000)).toEqual({
			status: "completed",
			startedAt: epoch,
			elapsedMs: 12_250,
			closedAt: epoch + 35_000,
		});
		expect(idle).toEqual({ status: "pending", startedAt: null, elapsedMs: 1_250, pausedAt: null });
	});

	test("a pause folds running time only up to the waits already spent", () => {
		const active = transition(FRESH, "in_progress", epoch);
		const paused = transition(active, "pending", epoch + 10_000, [{ start: epoch + 2_000, end: epoch + 5_000 }]);
		expect(paused).toEqual({ status: "pending", startedAt: epoch, elapsedMs: 7_000, pausedAt: epoch + 10_000 });
	});

	test("repeated active transitions preserve the original running interval", () => {
		const active = transition(idle, "in_progress", epoch);
		const repeated = transition(active, "in_progress", epoch + 2_000);
		expect(repeated).toBe(active);
		expect(elapsedOf(repeated, epoch + 3_000)).toBe(4_250);
		expect(transition(repeated, "pending", epoch + 4_000)).toEqual({
			status: "pending",
			startedAt: epoch,
			elapsedMs: 5_250,
			pausedAt: epoch + 4_000,
		});
	});

	test("transitions anchor only the state they enter", () => {
		expect(transition(FRESH, "pending", epoch)).toBe(FRESH);
		expect(transition(FRESH, "in_progress", epoch)).toEqual({
			status: "in_progress",
			startedAt: epoch,
			elapsedMs: 0,
			runningSince: epoch,
		});
		expect(transition(FRESH, "completed", epoch)).toEqual({ status: "completed", startedAt: null, elapsedMs: 0, closedAt: epoch });
		expect(transition(FRESH, "abandoned", epoch + 1)).toEqual({
			status: "abandoned",
			startedAt: null,
			elapsedMs: 0,
			closedAt: epoch + 1,
		});
		const closed: Progress = { status: "completed", startedAt: epoch, elapsedMs: 5_000, closedAt: epoch + 9_000 };
		expect(transition(closed, "pending", epoch + 10_000)).toEqual({
			status: "pending",
			startedAt: epoch,
			elapsedMs: 5_000,
			pausedAt: null,
		});
	});

	test("time spent waiting on the user is excluded from elapsed work", () => {
		const active = transition(FRESH, "in_progress", epoch);
		expect(elapsedOf(active, epoch + 10_000, [{ start: epoch + 2_000, end: epoch + 5_000 }])).toBe(7_000);
		expect(elapsedOf(active, epoch + 10_000, [{ start: epoch + 2_000, end: null }])).toBe(2_000);
		expect(elapsedOf(active, epoch + 10_000, [{ start: epoch - 5_000, end: epoch + 2_000 }])).toBe(8_000);
		expect(elapsedOf(active, epoch + 10_000, [{ start: epoch - 20_000, end: epoch - 10_000 }])).toBe(10_000);
		expect(elapsedOf(active, epoch + 10_000, [])).toBe(10_000);
	});

	test("the deadline is the remaining budget at the current time, shifted by waits", () => {
		const active = transition(FRESH, "in_progress", epoch);
		expect(dueAt(itemOf(active), epoch + 20_000)).toBe(epoch + 60_000);
		expect(dueAt(itemOf(active), epoch + 50_000, [{ start: epoch + 10_000, end: epoch + 40_000 }])).toBe(epoch + 90_000);

		const paused = transition(active, "pending", epoch + 10_000);
		expect(dueAt(itemOf(paused), epoch + 20_000)).toBeUndefined();
		const unanchored: Progress = { status: "in_progress", startedAt: epoch, elapsedMs: 0, runningSince: null };
		expect(dueAt(itemOf(unanchored), epoch + 20_000)).toBeUndefined();
		expect(dueAt(itemOf(active, { kind: "missing" }), epoch + 20_000)).toBeUndefined();
	});
});

describe("branch timing replay", () => {
	test("a host result saved with a blocked task reads back as pending and keeps the item's notes", () => {
		const progress: Progress = { status: "pending", startedAt: epoch, elapsedMs: 45_000, pausedAt: epoch };
		const state = stateOf({ kind: "set", goal }, [
			{
				name: "Delivery",
				items: [
					{
						id: "t1",
						title: "Waiting",
						explanation: { kind: "explained", text: "Blocked earlier" },
						estimate: { kind: "estimated", budgetId: "waiting-budget", minutes: 6 },
						progress,
						commit: null,
						tailRule: null,
					},
				],
			},
		]);
		const [notes] = stateEntries("blocked", epoch, state);
		if (notes === undefined) throw new Error("Expected the notes entry");
		const result: SessionEntry = {
			type: "message",
			id: "blocked-result",
			parentId: null,
			timestamp: new Date(epoch).toISOString(),
			message: todoResultMessage({ phases: [{ name: "Delivery", tasks: [{ content: "Waiting", status: "blocked" }] }] }, epoch),
		};
		const item = requireItem(stateOfBranch([notes, result]), "Waiting");
		expect(item.progress).toEqual(progress);
		expect(item.explanation).toEqual({ kind: "explained", text: "Blocked earlier" });
		expect(item.estimate).toEqual({ kind: "estimated", budgetId: "waiting-budget", minutes: 6 });
	});

	test("an item the host list holds without notes reads as lacking an explanation and an estimate", () => {
		const result = stateEntries("host-only", epoch, currentState())[1];
		if (result === undefined) throw new Error("Expected the host result entry");
		expect(stateOfBranch([result])).toEqual({
			kind: "list",
			goal: { kind: "missing" },
			phases: [
				{
					name: "Delivery",
					items: [
						{
							id: "t1",
							title,
							explanation: { kind: "missing" },
							estimate: { kind: "missing" },
							progress: { status: "in_progress", startedAt: null, elapsedMs: 0, runningSince: null },
							commit: null,
							tailRule: null,
						},
					],
				},
			],
		});
	});

	test("notes never contribute structure: an item absent from the host list stays absent", () => {
		const [notes, result] = stateEntries("with-extra", epoch, currentState());
		if (notes === undefined || result === undefined) throw new Error("Expected both entries");
		const removed = stateEntries("removed", epoch + 5_000, stateOf({ kind: "set", goal }, [{ name: "Delivery", items: [] }]))[1];
		if (removed === undefined) throw new Error("Expected the host result entry");
		expect(stateOfBranch([notes, result, removed])).toEqual({ kind: "empty" });
	});

	test("notes follow the item they are keyed to when the host list reorders and statuses change", () => {
		const first: TodoItem = {
			id: "t1",
			title,
			explanation: { kind: "explained", text: "First" },
			estimate,
			progress: idle,
			commit: null,
			tailRule: null,
		};
		const second: TodoItem = {
			id: "t2",
			title: "Verify results",
			explanation: { kind: "explained", text: "Second" },
			estimate: { ...estimate, budgetId: "verification-budget" },
			progress: { status: "completed", startedAt: epoch, elapsedMs: 0, closedAt: epoch },
			commit: null,
			tailRule: null,
		};
		const notes = stateEntries("two", epoch, stateOf({ kind: "set", goal }, [{ name: "Delivery", items: [first, second] }]))[0];
		const reordered: SessionEntry = {
			type: "message",
			id: "reordered",
			parentId: null,
			timestamp: new Date(epoch + 1_000).toISOString(),
			message: todoResultMessage(
				{
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
		const state = stateOfBranch([notes, reordered]);
		expect(
			state.kind === "list" &&
				state.phases[0]?.items.map((item) => [
					item.id,
					item.title,
					item.progress.status,
					item.estimate.kind === "estimated" && item.estimate.budgetId,
				]),
		).toEqual([
			["t2", "Verify results", "in_progress", "verification-budget"],
			["t1", title, "pending", "runtime-budget"],
		]);
	});

	test("clearing the host list ends the list and the goal before a same-title rebuild", () => {
		const entries = stateEntries("before", epoch, currentState());
		const clearedNotes = stateEntries("clear", epoch + 5_000, { kind: "empty" })[0];
		if (clearedNotes === undefined) throw new Error("Expected the cleared notes entry");
		const clearedResults: SessionEntry[] = [[], [{ name: "Cleared", tasks: [] }]].map((phases, index) => ({
			type: "message",
			id: `clear-result-${index}`,
			parentId: null,
			timestamp: new Date(epoch + 5_000).toISOString(),
			message: todoResultMessage({ phases }, epoch + 5_000),
		}));
		const rebuilt = stateOf({ kind: "missing" }, [
			{
				name: "Rebuilt",
				items: [
					{
						id: "t1",
						title,
						explanation: { kind: "missing" },
						estimate: { kind: "missing" },
						progress: FRESH,
						commit: null,
						tailRule: null,
					},
				],
			},
		]);
		for (const clearedResult of clearedResults) {
			expect(stateOfBranch([...entries, clearedNotes, clearedResult])).toEqual({ kind: "empty" });
			expect(stateOfBranch([...entries, clearedNotes, clearedResult, ...stateEntries("rebuild", epoch + 10_000, rebuilt)])).toEqual(
				rebuilt,
			);
		}
	});

	test("notes roundtrip and repeated replay retain each ID, estimate and running anchor", () => {
		const state = stateOf({ kind: "set", goal }, [
			{
				name: "Delivery",
				items: [
					{
						id: "t1",
						title,
						explanation: { kind: "explained", text: "Implement the runtime" },
						estimate,
						progress: running,
						commit: null,
						tailRule: null,
					},
					{
						id: "t2",
						title: "Verify results",
						explanation: { kind: "missing" },
						estimate: { kind: "estimated", budgetId: "verification-budget", minutes: 4 },
						progress: { status: "pending", startedAt: null, elapsedMs: 30_000, pausedAt: null },
						commit: null,
						tailRule: null,
					},
				],
			},
		]);
		const entries = stateEntries("roundtrip", epoch + 10_000, state);
		const firstReplay = stateOfBranch(entries);
		expect(firstReplay).toEqual(state);
		expect(stateOfBranch(stateEntries("again", epoch + 60_000, firstReplay))).toEqual(state);
		expect(elapsedOf(requireItem(firstReplay).progress, epoch + 90_000)).toBe(91_250);
	});
});

describe("overtime warning facts", () => {
	test("warnings belong to a budget, not to an item's current title or replacement estimate", () => {
		const original = stateEntries("snapshot", epoch, currentState());
		const warning = warningEntry(budgetId);
		const replacement = stateEntries(
			"replacement",
			epoch + 110_000,
			currentState(running, { kind: "estimated", budgetId: "replacement-budget", minutes: 3 }),
		);
		const branch: readonly SessionEntry[] = [...original, warning, ...replacement];
		expect(requireItem(stateOfBranch(branch)).title).toBe(title);
		expect(hasOvertimeWarning(branch, budgetId)).toBe(true);
		expect(hasOvertimeWarning(branch, "replacement-budget")).toBe(false);
		expect(hasOvertimeWarning(branch, `${budgetId}-other`)).toBe(false);
		expect(
			hasOvertimeWarning(
				[{ ...warning, details: { budgetId, title: "Previous title", estimatedMinutes: 1, elapsedMs: 100_000 } }],
				budgetId,
			),
		).toBe(true);
	});

	test("only a matching delivered custom message with complete warning details is a fact", () => {
		const warning = warningEntry(budgetId);
		const nonFacts: readonly SessionEntry[] = [
			customEntry("intent", epoch, OVERTIME_TYPE, warning.details),
			{ ...warning, id: "other-type", customType: `${OVERTIME_TYPE}.intent` },
			{ ...warning, id: "incomplete", details: { budgetId, title, estimatedMinutes: 1 } },
			{ ...warning, id: "invalid", details: { budgetId, title, estimatedMinutes: "1", elapsedMs: 100_000 } },
		];
		expect(hasOvertimeWarning(nonFacts, budgetId)).toBe(false);
		expect(hasOvertimeWarning([...nonFacts, warning], budgetId)).toBe(true);
	});

	test("warning messages neither alter clock snapshots nor survive as copied snapshot facts", () => {
		const state = currentState();
		const snapshot = toSnapshot(state);
		const entries = stateEntries("snapshot", epoch, state);
		const branch: readonly SessionEntry[] = [...entries, warningEntry(budgetId)];
		expect(stateOfBranch(branch)).toEqual(state);
		expect(toSnapshot(stateOfBranch(branch))).toEqual(snapshot);
		expect(hasOvertimeWarning(branch, budgetId)).toBe(true);
		const snapshotOnly = stateEntries("restored-snapshot", epoch + 120_000, stateOfBranch(branch));
		expect(stateOfBranch(snapshotOnly)).toEqual(state);
		expect(hasOvertimeWarning(snapshotOnly, budgetId)).toBe(false);
		expect(hasOvertimeWarning(entries, budgetId)).toBe(false);
	});
});
