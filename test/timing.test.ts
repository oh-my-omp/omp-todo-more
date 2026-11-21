import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { foldBranch, readTodoMore } from "../src/branch.ts";
import {
	elapsedTime,
	estimatedMinutesSchema,
	type ItemTime,
	OVERTIME_TYPE,
	recordOf,
	stateOf,
	TODO_MORE_ENTRY_TYPE,
	type TodoItem,
	type TodoMoreState,
	type TodoStatus,
	toSnapshot,
	transitionTime,
} from "../src/state.ts";

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

type NativeTask = { content: string; status: TodoStatus };

function customEntry(
	id: string,
	at: number,
	customType: string,
	data: unknown,
	parentId: string | null = null,
): Extract<SessionEntry, { type: "custom" }> {
	return { type: "custom", id, parentId, timestamp: new Date(at).toISOString(), customType, data };
}

function nativeEdit(id: string, at: number, tasks: readonly NativeTask[], parentId: string): SessionEntry {
	return customEntry(
		id,
		at,
		USER_TODO_EDIT_CUSTOM_TYPE,
		{
			phases: [{ name: "Host edit", tasks }],
			timestamp: new Date(epoch + 900_000).toISOString(),
		},
		parentId,
	);
}

function messageEntry(
	id: string,
	at: number,
	message: Extract<SessionEntry, { type: "message" }>["message"],
	parentId: string | null = null,
): Extract<SessionEntry, { type: "message" }> {
	return { type: "message", id, parentId, timestamp: new Date(at).toISOString(), message };
}

function warningEntry(budgetId: string): Extract<SessionEntry, { type: "custom_message" }> {
	return {
		type: "custom_message",
		id: `warning-${budgetId}`,
		parentId: "snapshot",
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
	test("historical rich snapshots migrate absent time to missing without inventing a clock", () => {
		const historical = customEntry("historical", epoch, TODO_MORE_ENTRY_TYPE, {
			goal,
			phases: [
				{
					name: "Historical",
					items: [
						{ title, explanation: "Old explanation", status: "in_progress" },
						{ title: "Waiting", explanation: null, status: "pending" },
					],
				},
			],
		});
		const state = readTodoMore([historical]);
		expect(requireItem(state)).toEqual({
			title,
			explanation: { kind: "explained", text: "Old explanation" },
			status: "in_progress",
			time: { kind: "missing" },
		});
		expect(requireItem(state, "Waiting").time).toEqual({ kind: "missing" });
		const paused = nativeEdit("pause-historical", epoch + 5_000, [{ content: title, status: "pending" }], historical.id);
		expect(requireItem(readTodoMore([historical, paused])).time).toEqual({ kind: "missing" });
	});

	test("a rich snapshot item saved as blocked reads as pending without its blocker and keeps its time", () => {
		const time: Extract<ItemTime, { kind: "estimated" }> = {
			kind: "estimated",
			budgetId: "waiting-budget",
			minutes: 6,
			elapsedMs: 45_000,
			runningSince: null,
		};
		const historical = customEntry("historical-blocked", epoch, TODO_MORE_ENTRY_TYPE, {
			goal,
			phases: [
				{
					name: "Historical",
					items: [{ title: "Waiting", explanation: "Blocked earlier", status: "blocked", blocker: "External service", time }],
				},
			],
		});

		const record = recordOf(historical);
		if (record?.kind !== "rich" || record.state.kind !== "list") throw new Error("Expected the legacy snapshot to read as a list");
		const recorded = requireItem(record.state, "Waiting");
		expect(recorded).toEqual({
			title: "Waiting",
			explanation: { kind: "explained", text: "Blocked earlier" },
			status: "pending",
			time,
		});
		expect("blocker" in recorded).toBe(false);

		const item = requireItem(readTodoMore([historical]), "Waiting");
		expect(item.status).toBe("pending");
		expect("blocker" in item).toBe(false);
		expect(item.time).toEqual(time);
	});

	test("native entries saved with a blocked task read back as pending", () => {
		const snapshot = customEntry("snapshot", epoch, TODO_MORE_ENTRY_TYPE, toSnapshot(currentState()));
		const edit = customEntry(
			"blocked-edit",
			epoch + 5_000,
			USER_TODO_EDIT_CUSTOM_TYPE,
			{ phases: [{ name: "Host edit", tasks: [{ content: title, status: "blocked" }] }] },
			snapshot.id,
		);
		const editRecord = recordOf(edit);
		expect(editRecord?.kind).toBe("native");
		if (editRecord?.kind !== "native") throw new Error("Expected the native edit record");
		expect(editRecord.phases[0]?.tasks[0]?.status).toBe("pending");
		const afterEdit = requireItem(readTodoMore([snapshot, edit]));
		expect(afterEdit.status).toBe("pending");
		expect("blocker" in afterEdit).toBe(false);

		const result = messageEntry(
			"blocked-result",
			epoch + 10_000,
			{
				role: "toolResult",
				toolCallId: "todo-1",
				toolName: "todo",
				content: [{ type: "text", text: "Task updated" }],
				details: { op: "update", phases: [{ name: "Host edit", tasks: [{ content: title, status: "blocked" }] }] },
				isError: false,
				timestamp: epoch + 10_000,
			},
			edit.id,
		);
		const resultRecord = recordOf(result);
		expect(resultRecord?.kind).toBe("native");
		if (resultRecord?.kind !== "native") throw new Error("Expected the native result record");
		expect(resultRecord.phases[0]?.tasks[0]?.status).toBe("pending");
		const afterResult = requireItem(readTodoMore([snapshot, edit, result]));
		expect(afterResult.status).toBe("pending");
	});

	test("native edits use outer timestamps and retain budget identity through pause and resume", () => {
		const snapshot = customEntry("snapshot", epoch, TODO_MORE_ENTRY_TYPE, toSnapshot(currentState()));
		const repeated = nativeEdit("repeat", epoch + 2_000, [{ content: title, status: "in_progress" }], snapshot.id);
		const paused = nativeEdit("pause", epoch + 6_000, [{ content: title, status: "pending" }], repeated.id);
		const stillPaused = nativeEdit("still-paused", epoch + 20_000, [{ content: title, status: "pending" }], paused.id);
		const resumed = nativeEdit("resume", epoch + 30_000, [{ content: title, status: "in_progress" }], stillPaused.id);
		const completed = nativeEdit("complete", epoch + 35_000, [{ content: title, status: "completed" }], resumed.id);
		const branch: readonly SessionEntry[] = [snapshot, repeated, paused, stillPaused, resumed, completed];

		expect(requireItem(readTodoMore(branch.slice(0, 2))).time).toEqual({ ...budget, runningSince: epoch });
		const pausedItem = requireItem(readTodoMore(branch.slice(0, 3)));
		expect(pausedItem.time).toEqual({ ...budget, elapsedMs: 7_250 });
		const stillPausedItem = requireItem(readTodoMore(branch.slice(0, 4)));
		expect(stillPausedItem.time).toEqual({ ...budget, elapsedMs: 7_250 });
		const resumedItem = requireItem(readTodoMore(branch.slice(0, 5)));
		expect(resumedItem.time).toEqual({ ...budget, elapsedMs: 7_250, runningSince: epoch + 30_000 });
		expect(elapsedTime(requireEstimate(resumedItem.time), epoch + 34_000)).toBe(11_250);
		const completedItem = requireItem(readTodoMore(branch));
		expect(completedItem.time).toEqual({ ...budget, elapsedMs: 12_250 });
		expect(completedItem.explanation).toEqual({ kind: "explained", text: "Implement the runtime" });
	});

	for (const phases of [[], [{ name: "Cleared", tasks: [] }]]) {
		test(`native empty ${phases.length === 0 ? "phase list" : "phase"} ends inheritance before a same-title rebuild`, () => {
			const snapshot = customEntry("snapshot", epoch, TODO_MORE_ENTRY_TYPE, toSnapshot(currentState()));
			const cleared = customEntry("clear", epoch + 5_000, USER_TODO_EDIT_CUSTOM_TYPE, { phases }, snapshot.id);
			const rebuilt = nativeEdit("rebuild", epoch + 10_000, [{ content: title, status: "in_progress" }], cleared.id);
			expect(readTodoMore([snapshot, cleared])).toEqual({ kind: "empty" });
			expect(readTodoMore([snapshot, cleared, rebuilt])).toEqual({
				kind: "list",
				goal: { kind: "missing" },
				phases: [
					{
						name: "Host edit",
						items: [{ title, explanation: { kind: "missing" }, status: "in_progress", time: { kind: "missing" } }],
					},
				],
			});
		});
	}

	test("snapshot roundtrips and repeated replay retain each budget ID and running anchor", () => {
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
		const snapshot = toSnapshot(state);
		const entry = customEntry("snapshot", epoch + 10_000, TODO_MORE_ENTRY_TYPE, snapshot);
		const firstReplay = readTodoMore([entry]);
		expect(firstReplay).toEqual(state);
		expect(readTodoMore([entry])).toEqual(firstReplay);
		expect(toSnapshot(firstReplay)).toEqual(snapshot);
		const restored = readTodoMore([customEntry("roundtrip", epoch + 60_000, TODO_MORE_ENTRY_TYPE, toSnapshot(firstReplay))]);
		expect(restored).toEqual(state);
		expect(requireItem(restored).time).toEqual({ ...budget, runningSince: epoch });
		expect(requireItem(restored, "Verify results").time).toEqual({
			...budget,
			budgetId: "verification-budget",
			minutes: 4,
			elapsedMs: 30_000,
		});
		expect(elapsedTime(requireEstimate(requireItem(restored).time), epoch + 90_000)).toBe(91_250);
	});
});

describe("overtime warning facts", () => {
	test("warnings belong to a budget, not to an item's current title or replacement estimate", () => {
		const original = customEntry("snapshot", epoch, TODO_MORE_ENTRY_TYPE, toSnapshot(currentState()));
		const warning = warningEntry(budget.budgetId);
		const replacement = customEntry(
			"replacement",
			epoch + 110_000,
			TODO_MORE_ENTRY_TYPE,
			toSnapshot(currentState({ ...budget, budgetId: "replacement-budget", minutes: 3, runningSince: epoch })),
			warning.id,
		);
		const branch: readonly SessionEntry[] = [original, warning, replacement];
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
		const entry = customEntry("snapshot", epoch, TODO_MORE_ENTRY_TYPE, snapshot);
		const branch: readonly SessionEntry[] = [entry, warningEntry(budget.budgetId)];
		expect(readTodoMore(branch)).toEqual(state);
		expect(toSnapshot(readTodoMore(branch))).toEqual(snapshot);
		expect(snapshot.phases[0]?.items[0]?.time).toEqual({ ...budget, runningSince: epoch });
		expect(snapshot.phases[0]?.items[0]?.time).not.toHaveProperty("notifiedAt");
		expect(hasOvertimeWarning(branch, budget.budgetId)).toBe(true);
		const snapshotOnly: readonly SessionEntry[] = [
			customEntry("restored-snapshot", epoch + 120_000, TODO_MORE_ENTRY_TYPE, toSnapshot(readTodoMore(branch))),
		];
		expect(readTodoMore(snapshotOnly)).toEqual(state);
		expect(hasOvertimeWarning(snapshotOnly, budget.budgetId)).toBe(false);
		expect(hasOvertimeWarning([entry], budget.budgetId)).toBe(false);
	});
});
