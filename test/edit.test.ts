import { describe, expect, test } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { branchFacts, readTodoMore } from "../src/branch.ts";
import { applyTodoEdit, saveTodoEdit, type TodoEdit } from "../src/edit.ts";
import {
	EMPTY,
	hostPhases,
	stateOf,
	TODO_MORE_NOTES_TYPE,
	type TodoGoal,
	type TodoItem,
	type TodoMoreState,
	type TodoPhase,
	toNotes,
	toSnapshot,
} from "../src/state.ts";
import { appendStateResult, hostSession } from "./host.ts";

const goal: TodoGoal = {
	objective: "Ship editable todos",
	measure: "Edits retain current task state",
	doneWhen: "User-visible boundaries are covered",
};

function currentPhases(): readonly TodoPhase[] {
	return [
		{
			name: "Delivery",
			items: [
				{
					title: "Edit goal",
					explanation: { kind: "explained", text: "Replace the objective" },
					status: "in_progress",
					time: { kind: "estimated", budgetId: "edit-goal-budget", minutes: 3, elapsedMs: 12_000, runningSince: 1_800_000_000_000 },
				},
				{
					title: "Verify resume",
					explanation: { kind: "explained", text: "Inspect saved fields" },
					status: "pending",
					time: { kind: "estimated", budgetId: "verify-resume-budget", minutes: 4, elapsedMs: 0, runningSince: null },
				},
			],
		},
		{
			name: "Verification",
			items: [
				{
					title: "Check runtime",
					explanation: { kind: "explained", text: "Wait for the environment" },
					status: "pending",
					time: { kind: "estimated", budgetId: "check-runtime-budget", minutes: 6, elapsedMs: 35_000, runningSince: null },
				},
				{
					title: "Review results",
					explanation: { kind: "missing" },
					status: "completed",
					time: { kind: "estimated", budgetId: "review-results-budget", minutes: 3, elapsedMs: 90_000, runningSince: null },
				},
				{
					title: "Old approach",
					explanation: { kind: "explained", text: "No longer needed" },
					status: "abandoned",
					time: { kind: "missing" },
				},
			],
		},
	];
}

function applySuccessfully(state: TodoMoreState, edit: TodoEdit): TodoMoreState {
	const result = applyTodoEdit(state, edit);
	expect(result.kind).toBe("ok");
	if (result.kind !== "ok") throw new Error(result.message);
	return result.state;
}

function expectRejected(state: TodoMoreState, edit: TodoEdit, message: string): void {
	const before = toSnapshot(state);
	expect(applyTodoEdit(state, edit)).toEqual({ kind: "rejected", message });
	expect(toSnapshot(state)).toEqual(before);
}

describe("applyTodoEdit", () => {
	const latestItems: readonly TodoItem[] = [
		{
			title: "Verify resume",
			explanation: { kind: "explained", text: "Earlier draft" },
			status: "completed",
			time: { kind: "missing" },
		},
		{
			title: "Verify resume",
			explanation: { kind: "explained", text: "Earlier draft" },
			status: "completed",
			time: { kind: "estimated", budgetId: "completed-resume-budget", minutes: 2, elapsedMs: 105_000, runningSince: null },
		},
		{
			title: "Verify resume",
			explanation: { kind: "explained", text: "Earlier draft" },
			status: "pending",
			time: { kind: "estimated", budgetId: "pending-resume-budget", minutes: 5, elapsedMs: 45_000, runningSince: null },
		},
		{
			title: "Verify resume",
			explanation: { kind: "explained", text: "Earlier draft" },
			status: "in_progress",
			time: { kind: "estimated", budgetId: "running-resume-budget", minutes: 2, elapsedMs: 20_000, runningSince: 1_800_000_060_000 },
		},
	];

	for (const latestItem of latestItems) {
		test(`explanation edit preserves latest ${latestItem.status} status`, () => {
			const phases = currentPhases();
			const state = stateOf({ kind: "set", goal }, [
				...phases,
				{ name: "Latest branch", items: [{ ...latestItem, title: "Edited task" }] },
			]);
			const before = toSnapshot(state);
			const edited = applySuccessfully(state, { kind: "explain", title: "Edited task", explanation: "Verified after resume" });

			expect(toSnapshot(edited)).toEqual({
				goal,
				phases: [
					...before.phases.slice(0, -1),
					{
						name: "Latest branch",
						items: [
							{
								title: "Edited task",
								explanation: "Verified after resume",
								status: latestItem.status,
								time: latestItem.time,
							},
						],
					},
				],
			});
			expect(toSnapshot(state)).toEqual(before);
		});
	}

	test("goal replacement preserves every phase and item field", () => {
		const state = stateOf({ kind: "set", goal }, currentPhases());
		const before = toSnapshot(state);
		const replacement: TodoGoal = {
			objective: "Ship editable todos in Tern",
			measure: "Goal and explanations survive resume",
			doneWhen: "Runtime verification succeeds",
		};
		const edited = applySuccessfully(state, { kind: "set_goal", goal: replacement });

		expect(toSnapshot(edited)).toEqual({ goal: replacement, phases: before.phases });
		expect(toSnapshot(state)).toEqual(before);
	});

	test("an explanation draft for a deleted title is rejected without restoring the item", () => {
		const phases = currentPhases();
		const latest = stateOf(
			{ kind: "set", goal },
			phases.map((phase) => ({ ...phase, items: phase.items.filter((item) => item.title !== "Verify resume") })),
		);

		expectRejected(latest, { kind: "explain", title: "Verify resume", explanation: "Stale draft" }, 'Task "Verify resume" not found');
	});

	test("an explanation draft for a renamed title is rejected without changing its replacement", () => {
		const phases = currentPhases();
		const latest = stateOf(
			{ kind: "set", goal },
			phases.map((phase) => ({
				...phase,
				items: phase.items.map((item) => (item.title === "Verify resume" ? { ...item, title: "Verify reopened session" } : item)),
			})),
		);

		expectRejected(latest, { kind: "explain", title: "Verify resume", explanation: "Stale draft" }, 'Task "Verify resume" not found');
	});

	test("reordered phases and tasks are edited by the complete title, not the old position", () => {
		const phases = currentPhases();
		const latest = stateOf(
			{ kind: "set", goal },
			[...phases].reverse().map((phase) => ({ ...phase, items: [...phase.items].reverse() })),
		);
		const before = toSnapshot(latest);
		const preservedPhase = before.phases[0];
		if (preservedPhase === undefined) throw new Error("Expected the reordered Verification phase in the fixture");
		const edited = applySuccessfully(latest, { kind: "explain", title: "Verify resume", explanation: "Saved in the current order" });

		expect(toSnapshot(edited)).toEqual({
			goal,
			phases: [
				preservedPhase,
				{
					name: "Delivery",
					items: [
						{
							title: "Verify resume",
							explanation: "Saved in the current order",
							status: "pending",
							time: { kind: "estimated", budgetId: "verify-resume-budget", minutes: 4, elapsedMs: 0, runningSince: null },
						},
						{
							title: "Edit goal",
							explanation: "Replace the objective",
							status: "in_progress",
							time: { kind: "estimated", budgetId: "edit-goal-budget", minutes: 3, elapsedMs: 12_000, runningSince: 1_800_000_000_000 },
						},
					],
				},
			],
		});
		expect(toSnapshot(latest)).toEqual(before);
	});

	test("missing goal rejects explanation edits until a goal is set", () => {
		const state = stateOf({ kind: "missing" }, currentPhases());
		const edit: TodoEdit = { kind: "explain", title: "Review results", explanation: "Reviewed the saved values" };
		expectRejected(state, edit, "The list has no goal: set goal before editing explanations.");

		const withGoal = applySuccessfully(state, { kind: "set_goal", goal });
		expect(toSnapshot(withGoal)).toEqual({ goal, phases: toSnapshot(state).phases });
		const edited = applySuccessfully(withGoal, edit);
		const expected = toSnapshot(withGoal);
		expected.phases[1]!.items[1]!.explanation = "Reviewed the saved values";
		expect(toSnapshot(edited)).toEqual(expected);
		expect(toSnapshot(withGoal).phases[1]!.items[1]!.explanation).toBeNull();
	});

	for (const { label, state } of [
		{ label: "canonical empty", state: EMPTY },
		{ label: "normalized empty phase", state: stateOf({ kind: "set", goal }, [{ name: "Empty phase", items: [] }]) },
	]) {
		test(`empty list rejects both edit kinds (${label})`, () => {
			expectRejected(state, { kind: "set_goal", goal }, "Todo list is empty.");
			expectRejected(state, { kind: "explain", title: "Verify resume", explanation: "Cannot create a task" }, "Todo list is empty.");
		});
	}

	const goalFields: readonly (keyof TodoGoal)[] = ["objective", "measure", "doneWhen"];
	for (const field of goalFields) {
		for (const value of ["", " \t\n "]) {
			test(`rejects ${value === "" ? "empty" : "whitespace-only"} goal ${field}`, () => {
				const state = stateOf({ kind: "set", goal }, currentPhases());
				expectRejected(
					state,
					{ kind: "set_goal", goal: { ...goal, [field]: value } },
					"Goal fields, task title and explanation must not be empty.",
				);
			});
		}
	}

	for (const explanation of ["", " \t\n "]) {
		test(`rejects ${explanation === "" ? "empty" : "whitespace-only"} explanations`, () => {
			const state = stateOf({ kind: "set", goal }, currentPhases());
			expectRejected(
				state,
				{ kind: "explain", title: "Verify resume", explanation },
				"Goal fields, task title and explanation must not be empty.",
			);
		});
	}

	test("unchanged goal returns the same state with no meaningful change", () => {
		const state = stateOf({ kind: "set", goal }, currentPhases());
		const before = toSnapshot(state);
		const edited = applySuccessfully(state, { kind: "set_goal", goal: { ...goal } });

		expect(edited).toBe(state);
		expect(toSnapshot(edited)).toEqual(before);
	});

	test("unchanged explanation returns the same state with no meaningful change", () => {
		const state = stateOf({ kind: "set", goal }, currentPhases());
		const before = toSnapshot(state);
		const edited = applySuccessfully(state, { kind: "explain", title: "Verify resume", explanation: "Inspect saved fields" });

		expect(edited).toBe(state);
		expect(toSnapshot(edited)).toEqual(before);
	});
});

describe("saveTodoEdit", () => {
	function seeded() {
		const manager = SessionManager.inMemory("/tmp/todo-more-edit-tests");
		const session = hostSession(manager);
		const state = stateOf({ kind: "set", goal }, currentPhases());
		session.setTodoPhases(hostPhases(state));
		manager.appendCustomEntry(TODO_MORE_NOTES_TYPE, toNotes(state));
		appendStateResult(manager, state, 1_800_000_000_000);
		return { manager, session, state };
	}

	test("an explanation edit writes the host list once, unchanged, and the plugin's notes", () => {
		const { manager, session, state } = seeded();
		const hostBefore = session.getTodoPhases();
		const writes: unknown[] = [];
		const watched = {
			sessionManager: manager,
			getTodoPhases: session.getTodoPhases,
			setTodoPhases: (phases: Parameters<typeof session.setTodoPhases>[0]) => {
				writes.push(phases);
				session.setTodoPhases(phases);
			},
		};
		const result = saveTodoEdit(watched, { kind: "explain", title: "Verify resume", explanation: "Inspect every saved field" });
		expect(result.kind).toBe("saved");
		expect(writes).toHaveLength(1);
		expect(writes[0]).toEqual(hostBefore);
		expect(session.getTodoPhases()).toEqual(hostBefore);
		const entries = manager.getBranch().filter((entry) => entry.type === "custom");
		expect(entries.map((entry) => entry.type === "custom" && entry.customType)).toEqual([TODO_MORE_NOTES_TYPE, TODO_MORE_NOTES_TYPE]);
		const edited = readTodoMore(manager.getBranch());
		const item =
			edited.kind === "list"
				? edited.phases.flatMap((phase) => phase.items).find((candidate) => candidate.title === "Verify resume")
				: undefined;
		expect(item?.explanation).toEqual({ kind: "explained", text: "Inspect every saved field" });
		expect(item?.status).toBe("pending");
		expect(item?.time).toEqual(state.kind === "list" ? state.phases[0]?.items[1]?.time : undefined);
	});

	test("a goal edit replaces only the goal; an unchanged edit appends nothing", () => {
		const { manager, session } = seeded();
		const replacement: TodoGoal = { objective: "New", measure: "Measured", doneWhen: "Done" };
		expect(saveTodoEdit(session, { kind: "set_goal", goal: replacement }).kind).toBe("saved");
		const appended = manager.getBranch().length;
		expect(branchFacts(manager).notes.goal).toEqual(replacement);
		expect(saveTodoEdit(session, { kind: "set_goal", goal: replacement }).kind).toBe("saved");
		expect(manager.getBranch()).toHaveLength(appended);
	});

	test("an edit on an empty list is rejected without any write", () => {
		const manager = SessionManager.inMemory("/tmp/todo-more-edit-tests-empty");
		const session = hostSession(manager);
		expect(saveTodoEdit(session, { kind: "set_goal", goal })).toEqual({ kind: "rejected", message: "Todo list is empty." });
		expect(manager.getBranch()).toHaveLength(0);
	});
});
