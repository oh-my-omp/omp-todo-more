import { describe, expect, test } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { branchFacts, foldBranch } from "../src/branch.ts";
import { applyTodoEdit, saveTodoEdit, type TodoEdit } from "../src/edit.ts";
import {
	EMPTY,
	hostPhases,
	stateOf,
	TODO_NG_NOTES_TYPE,
	type TodoGoal,
	type TodoItem,
	type TodoNgState,
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
					id: "t1",
					title: "Edit goal",
					explanation: { kind: "explained", text: "Replace the objective" },
					estimate: { kind: "estimated", budgetId: "edit-goal-budget", minutes: 3 },
					progress: { status: "in_progress", startedAt: 1_800_000_000_000, elapsedMs: 12_000, runningSince: 1_800_000_000_000 },
					commit: null,
				},
				{
					id: "t2",
					title: "Verify resume",
					explanation: { kind: "explained", text: "Inspect saved fields" },
					estimate: { kind: "estimated", budgetId: "verify-resume-budget", minutes: 4 },
					progress: { status: "pending", startedAt: null, elapsedMs: 0, pausedAt: null },
					commit: null,
				},
			],
		},
		{
			name: "Verification",
			items: [
				{
					id: "t3",
					title: "Check runtime",
					explanation: { kind: "explained", text: "Wait for the environment" },
					estimate: { kind: "estimated", budgetId: "check-runtime-budget", minutes: 6 },
					progress: { status: "pending", startedAt: null, elapsedMs: 35_000, pausedAt: null },
					commit: null,
				},
				{
					id: "t4",
					title: "Review results",
					explanation: { kind: "missing" },
					estimate: { kind: "estimated", budgetId: "review-results-budget", minutes: 3 },
					progress: { status: "completed", startedAt: null, elapsedMs: 90_000, closedAt: null },
					commit: null,
				},
				{
					id: "t5",
					title: "Old approach",
					explanation: { kind: "explained", text: "No longer needed" },
					estimate: { kind: "missing" },
					progress: { status: "abandoned", startedAt: null, elapsedMs: 0, closedAt: null },
					commit: null,
				},
			],
		},
	];
}

function applySuccessfully(state: TodoNgState, edit: TodoEdit): TodoNgState {
	const result = applyTodoEdit(state, edit);
	expect(result.kind).toBe("ok");
	if (result.kind !== "ok") throw new Error(result.message);
	return result.state;
}

function expectRejected(state: TodoNgState, edit: TodoEdit): void {
	const before = toSnapshot(state);
	expect(applyTodoEdit(state, edit).kind).toBe("rejected");
	expect(toSnapshot(state)).toEqual(before);
}

describe("applyTodoEdit", () => {
	test("an explanation edit preserves the item's running status and estimate", () => {
		const latestItem: TodoItem = {
			id: "t9",
			title: "Verify resume",
			explanation: { kind: "explained", text: "Earlier draft" },
			estimate: { kind: "estimated", budgetId: "running-resume-budget", minutes: 2 },
			progress: { status: "in_progress", startedAt: 1_800_000_060_000, elapsedMs: 20_000, runningSince: 1_800_000_060_000 },
			commit: null,
		};
		const state = stateOf({ kind: "set", goal }, [
			...currentPhases(),
			{ name: "Latest branch", items: [{ ...latestItem, title: "Edited task" }] },
		]);
		const before = toSnapshot(state);
		const edited = applySuccessfully(state, { kind: "explain", id: "t9", explanation: "Verified after resume" });

		expect(toSnapshot(edited)).toEqual({
			goal,
			phases: [
				...before.phases.slice(0, -1),
				{
					name: "Latest branch",
					items: [
						{
							id: "t9",
							title: "Edited task",
							explanation: "Verified after resume",
							status: "in_progress",
							estimate: latestItem.estimate,
							commit: null,
						},
					],
				},
			],
		});
		expect(toSnapshot(state)).toEqual(before);
	});

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

	test("an explanation draft for a deleted id is rejected without restoring the item", () => {
		const phases = currentPhases();
		const latest = stateOf(
			{ kind: "set", goal },
			phases.map((phase) => ({ ...phase, items: phase.items.filter((item) => item.id !== "t2") })),
		);

		expectRejected(latest, { kind: "explain", id: "t2", explanation: "Stale draft" });
	});

	test("reordered phases and tasks are edited by id, not the old position", () => {
		const phases = currentPhases();
		const latest = stateOf(
			{ kind: "set", goal },
			[...phases].reverse().map((phase) => ({ ...phase, items: [...phase.items].reverse() })),
		);
		const before = toSnapshot(latest);
		const edited = applySuccessfully(latest, { kind: "explain", id: "t2", explanation: "Saved in the current order" });

		expect(toSnapshot(edited)).toEqual({
			goal,
			phases: before.phases.map((phase) => ({
				...phase,
				items: phase.items.map((item) => (item.id === "t2" ? { ...item, explanation: "Saved in the current order" } : item)),
			})),
		});
		expect(toSnapshot(latest)).toEqual(before);
	});

	test("missing goal rejects explanation edits until a goal is set", () => {
		const state = stateOf({ kind: "missing" }, currentPhases());
		const edit: TodoEdit = { kind: "explain", id: "t4", explanation: "Reviewed the saved values" };
		expectRejected(state, edit);

		const withGoal = applySuccessfully(state, { kind: "set_goal", goal });
		expect(toSnapshot(withGoal)).toEqual({ goal, phases: toSnapshot(state).phases });
		const expected = toSnapshot(withGoal);
		expect(toSnapshot(applySuccessfully(withGoal, edit))).toEqual({
			goal,
			phases: expected.phases.map((phase) => ({
				...phase,
				items: phase.items.map((item) => (item.id === "t4" ? { ...item, explanation: "Reviewed the saved values" } : item)),
			})),
		});
	});

	for (const { label, state } of [
		{ label: "canonical empty", state: EMPTY },
		{ label: "normalized empty phase", state: stateOf({ kind: "set", goal }, [{ name: "Empty phase", items: [] }]) },
	]) {
		test(`empty list rejects both edit kinds (${label})`, () => {
			expectRejected(state, { kind: "set_goal", goal });
			expectRejected(state, { kind: "explain", id: "t2", explanation: "Cannot create a task" });
		});
	}

	test("a whitespace-only explanation is rejected", () => {
		expectRejected(stateOf({ kind: "set", goal }, currentPhases()), { kind: "explain", id: "t2", explanation: " \t\n " });
	});

	test("unchanged explanation returns the same state with no meaningful change", () => {
		const state = stateOf({ kind: "set", goal }, currentPhases());

		expect(applySuccessfully(state, { kind: "explain", id: "t2", explanation: "Inspect saved fields" })).toBe(state);
	});
});

describe("saveTodoEdit", () => {
	function seeded() {
		const manager = SessionManager.inMemory("/tmp/todo-ng-edit-tests");
		const session = hostSession(manager);
		const state = stateOf({ kind: "set", goal }, currentPhases());
		session.setTodoPhases(hostPhases(state));
		manager.appendCustomEntry(TODO_NG_NOTES_TYPE, toNotes(state));
		appendStateResult(manager, state, 1_800_000_000_000);
		return { manager, session, state };
	}

	test("an explanation edit leaves the host list unchanged and persists the notes", () => {
		const { manager, session, state } = seeded();
		const hostBefore = session.getTodoPhases();
		const result = saveTodoEdit(session, { kind: "explain", id: "t2", explanation: "Inspect every saved field" });
		expect(result.kind).toBe("saved");
		expect(session.getTodoPhases()).toEqual(hostBefore);
		const edited = foldBranch(manager.getBranch()).state;
		const seededItem = state.kind === "list" ? state.phases.flatMap((phase) => phase.items).find((item) => item.id === "t2") : undefined;
		if (seededItem === undefined) throw new Error("Expected the seeded item");
		const item =
			edited.kind === "list" ? edited.phases.flatMap((phase) => phase.items).find((candidate) => candidate.id === "t2") : undefined;
		expect(item).toEqual({ ...seededItem, explanation: { kind: "explained", text: "Inspect every saved field" } });
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
		const manager = SessionManager.inMemory("/tmp/todo-ng-edit-tests-empty");
		const session = hostSession(manager);
		expect(saveTodoEdit(session, { kind: "set_goal", goal }).kind).toBe("rejected");
		expect(manager.getBranch()).toHaveLength(0);
	});
});
