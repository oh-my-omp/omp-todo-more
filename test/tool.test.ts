import { describe, expect, spyOn, test } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { TodoPhase as HostTodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { branchFacts, foldBranch } from "../src/branch.ts";
import type { TodoSession } from "../src/commit.ts";
import { formatClock, formatDateTime } from "../src/format.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";
import {
	type Estimate,
	elapsedOf,
	FRESH,
	joinHost,
	OVERTIME_TYPE,
	type Progress,
	TODO_MORE_ENTRY_TYPE,
	TODO_MORE_NOTES_TYPE,
	type TodoGoal,
	type TodoMoreSnapshot,
	type TodoNotes,
	toSnapshot,
} from "../src/state.ts";
import { runTodo, type TodoMoreDetails } from "../src/tool.ts";
import { todoResultMessage } from "./host.ts";

const epoch = Date.parse("2026-10-15T12:00:00.000Z");
const goal: TodoGoal = {
	objective: "Ship atomic structured todos",
	measure: "Every call publishes one accepted state",
	doneWhen: "Tasks, explanations and goal survive the complete batch",
};
const goalInput = {
	title: goal.objective,
	summary: goal.measure,
	acceptance: goal.doneWhen,
};
type ItemNote = TodoNotes["items"][number];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const missing: Estimate = { kind: "missing" };
const time = (budgetId: string, minutes: number): Estimate => ({ kind: "estimated", budgetId, minutes });
const active = (startedAt: number | null, elapsedMs = 0, runningSince: number | null = null): Progress => ({
	status: "in_progress",
	startedAt,
	elapsedMs,
	runningSince,
});
const parked = (startedAt: number | null, elapsedMs = 0, pausedAt: number | null = null): Progress => ({
	status: "pending",
	startedAt,
	elapsedMs,
	pausedAt,
});
const closed = (status: "completed" | "abandoned", startedAt: number | null, elapsedMs = 0, closedAt: number | null = null): Progress => ({
	status,
	startedAt,
	elapsedMs,
	closedAt,
});

function note(id: string, phase: string, title: string, explanation: string | null, estimate: Estimate, progress: Progress): ItemNote {
	return { id, phase, title, explanation, estimate, progress, commit: null };
}

async function at<T>(now: number, invoke: () => Promise<T>, tick = 0): Promise<T> {
	let reads = 0;
	const clock = spyOn(Date, "now").mockImplementation(() => now + tick * reads++);
	try {
		return await invoke();
	} finally {
		clock.mockRestore();
	}
}

type Fixture = {
	session: TodoSession;
	projections: HostTodoPhase[][];
	snapshot: () => TodoMoreSnapshot;
	notes: () => TodoNotes;
	notesEntries: () => SessionEntry[];
	run: (raw: unknown, leafMaxMinutes?: number) => Promise<AgentToolResult<TodoMoreDetails>>;
	call: (args: unknown) => Promise<AgentToolResult<TodoMoreDetails>>;
	callAt: (now: number, args: unknown) => Promise<AgentToolResult<TodoMoreDetails>>;
};

function phasesOf(notes: TodoNotes): HostTodoPhase[] {
	const phases: { name: string; tasks: { content: string; status: ItemNote["progress"]["status"] }[] }[] = [];
	for (const item of notes.items) {
		const phase = phases.find((candidate) => candidate.name === item.phase) ?? { name: item.phase, tasks: [] };
		if (!phases.includes(phase)) phases.push(phase);
		phase.tasks.push({ content: item.title, status: item.progress.status });
	}
	return phases;
}

function snapshotOf(notes: TodoNotes): TodoMoreSnapshot {
	return toSnapshot(joinHost(phasesOf(notes), notes));
}

function withItem(notes: TodoNotes, id: string, patch: Partial<ItemNote>): TodoNotes {
	return { ...notes, items: notes.items.map((item) => (item.id === id ? { ...item, ...patch } : item)) };
}

function fixture(initial?: TodoNotes): Fixture {
	const sessionManager = SessionManager.inMemory("/tmp/todo-more-tool-tests");
	const projections: HostTodoPhase[][] = [];
	let list: HostTodoPhase[] = [];
	const session: TodoSession = {
		sessionManager,
		model: undefined,
		getTodoPhases: () => structuredClone(list),
		setTodoPhases: (phases) => {
			list = structuredClone(phases);
			projections.push(phases);
		},
	};
	if (initial !== undefined) {
		list = phasesOf(initial);
		sessionManager.appendCustomEntry(TODO_MORE_NOTES_TYPE, initial);
		sessionManager.appendMessage(todoResultMessage({ op: "batch", phases: phasesOf(initial) }, epoch));
	}
	const run: Fixture["run"] = async (raw, leafMaxMinutes) => {
		const result = await runTodo(session, raw, leafMaxMinutes);
		sessionManager.appendMessage(todoResultMessage(result.details, Date.now(), result.isError === true));
		return result;
	};
	const callAt = (now: number, args: unknown): Promise<AgentToolResult<TodoMoreDetails>> => at(now, () => run(args));
	return {
		session,
		projections,
		snapshot: () => toSnapshot(foldBranch(sessionManager.getBranch()).state),
		notes: () => branchFacts(sessionManager).notes,
		notesEntries: () => sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === TODO_MORE_NOTES_TYPE),
		run,
		call: (args) => callAt(epoch, args),
		callAt,
	};
}

function expectSaved(harness: Fixture, result: AgentToolResult<TodoMoreDetails>, expected: TodoNotes, previousProjections: number): void {
	const snapshot = snapshotOf(expected);
	expect(result.isError).not.toBe(true);
	expect(harness.snapshot()).toEqual(snapshot);
	expect(result.details?.more).toEqual(snapshot);
	expect(result.details?.phases).toStrictEqual(phasesOf(expected));
	expect(harness.session.getTodoPhases()).toStrictEqual(phasesOf(expected));
	expect(harness.notes()).toEqual(expected);
	expect(harness.projections).toHaveLength(previousProjections + 1);
	expect(harness.projections.at(-1)).toStrictEqual(phasesOf(expected));
	expectNoFullListEntry(harness);
}

function keysOf(data: unknown): string[] {
	return typeof data === "object" && data !== null ? Object.keys(data).sort() : [];
}

function expectNoFullListEntry(harness: Fixture): void {
	for (const entry of harness.session.sessionManager.getBranch()) {
		if (entry.type !== "custom" || !entry.customType.startsWith(TODO_MORE_ENTRY_TYPE)) continue;
		expect(entry.customType).toBe(TODO_MORE_NOTES_TYPE);
		expect(keysOf(entry.data)).toEqual(["goal", "items"]);
	}
}

async function expectRejected(
	harness: Fixture,
	invoke: () => Promise<AgentToolResult<TodoMoreDetails>>,
): Promise<AgentToolResult<TodoMoreDetails>> {
	const before = harness.snapshot();
	const notes = structuredClone(harness.notesEntries());
	const list = harness.session.getTodoPhases();
	const projections = structuredClone(harness.projections);
	const result = await invoke();
	expect(result.isError).toBe(true);
	expect(result.details?.more).toEqual(before);
	expect(result.details?.phases).toStrictEqual(phasesOf(harness.notes()));
	expect(result.details?.changes).toBeUndefined();
	expect(harness.snapshot()).toEqual(before);
	expect(harness.notesEntries()).toEqual(notes);
	expect(harness.session.getTodoPhases()).toEqual(list);
	expect(harness.projections).toEqual(projections);
	return result;
}

function itemOf(snapshot: TodoMoreSnapshot, title: string) {
	const item = snapshot.phases.flatMap((phase) => phase.items).find((candidate) => candidate.title === title);
	if (item === undefined) throw new Error(`Expected task ${title}`);
	return item;
}

function resultText(result: AgentToolResult<TodoMoreDetails>): string {
	return result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function estimateOf(snapshot: TodoMoreSnapshot, title: string): Extract<Estimate, { kind: "estimated" }> {
	const estimate = itemOf(snapshot, title).estimate;
	if (estimate.kind !== "estimated") throw new Error(`Expected estimate for ${title}`);
	return estimate;
}

function createdEstimate(harness: Fixture, title: string, minutes: number): Extract<Estimate, { kind: "estimated" }> {
	const estimate = estimateOf(harness.snapshot(), title);
	expect(estimate.budgetId).toMatch(uuidPattern);
	expect(estimate.minutes).toBe(minutes);
	return estimate;
}

function progressOf(harness: Fixture, title: string): Progress {
	const item = harness.notes().items.find((candidate) => candidate.title === title);
	if (item === undefined) throw new Error(`Expected task ${title}`);
	return item.progress;
}

function populated(): TodoNotes {
	return {
		goal,
		items: [
			note("t1", "Delivery", "Implement", "Consume complete commands", missing, active(null)),
			note("t2", "Delivery", "Review", "Review original behavior", missing, parked(null)),
			note("t3", "Verification", "Runtime", "Use the real host", missing, parked(null)),
			note("t4", "Verification", "Already checked", "Retain earlier evidence", missing, closed("completed", null)),
			note("t5", "Verification", "Old approach", "Keep historical scope", missing, closed("abandoned", null)),
		],
	};
}

function timed(): TodoNotes {
	return withItem(
		withItem(withItem(populated(), "t1", { estimate: time("implement-budget", 10), progress: active(epoch, 1_250, epoch) }), "t2", {
			estimate: time("review-budget", 20),
			progress: parked(null, 500),
		}),
		"t3",
		{ estimate: time("runtime-budget", 30), progress: parked(null, 750) },
	);
}

describe("atomic structured todo execution", () => {
	test("flat initialization with multiple estimates appends one snapshot and defaults to Tasks", async () => {
		const harness = fixture();
		const result = await harness.call({
			goal: goalInput,
			add: [
				{ title: "Implement", detail: "Consume the structured input", minutes: 10 },
				{ title: "Review", detail: "Check all fields", minutes: 20 },
			],
		});
		const implement = createdEstimate(harness, "Implement", 10);
		const review = createdEstimate(harness, "Review", 20);
		expect(implement.budgetId).not.toBe(review.budgetId);
		expectSaved(
			harness,
			result,
			{
				goal,
				items: [
					note("t1", "Tasks", "Implement", "Consume the structured input", implement, active(epoch, 0, epoch)),
					note("t2", "Tasks", "Review", "Check all fields", review, FRESH),
				],
			},
			0,
		);
		expect(result.details?.op).toBe("init");
		expect(result.details?.changes).toEqual([
			{ op: "goal", goal },
			{
				op: "add",
				phase: "Tasks",
				items: [
					{ id: "t1", title: "Implement", explanation: "Consume the structured input", estimatedMinutes: 10 },
					{ id: "t2", title: "Review", explanation: "Check all fields", estimatedMinutes: 20 },
				],
			},
		]);
	});

	test("phased initialization normalizes across all tasks after assembling its phases", async () => {
		const harness = fixture();
		const result = await harness.call({
			goal: goalInput,
			add: [
				{ phase: "Delivery", title: "Implement", detail: "Build it", minutes: 10 },
				{ phase: "Verification", title: "Verify", detail: "Test it", minutes: 5 },
			],
		});
		expect(result.isError).not.toBe(true);
		expect(harness.snapshot().phases.map((p) => p.name)).toEqual(["Delivery", "Verification"]);
		expect(itemOf(harness.snapshot(), "Implement").id).toBe("t1");
		expect(itemOf(harness.snapshot(), "Implement").status).toBe("in_progress");
		expect(itemOf(harness.snapshot(), "Verify").id).toBe("t2");
		expect(itemOf(harness.snapshot(), "Verify").status).toBe("pending");
	});

	test("done_id, start_id, explain and add publish one snapshot preserving unrelated rich fields", async () => {
		const harness = fixture(populated());
		const result = await harness.callAt(epoch + 5_000, {
			done_id: "t1",
			start_id: "t3",
			explain: [{ id: "t3", note: "Verify through runtime" }],
			add: [{ phase: "Polish", title: "Document", detail: "Update README", minutes: 8 }],
		});
		expect(result.isError).not.toBe(true);
		expect(itemOf(harness.snapshot(), "Implement").status).toBe("completed");
		expect(itemOf(harness.snapshot(), "Runtime").status).toBe("in_progress");
		expect(itemOf(harness.snapshot(), "Runtime").explanation).toBe("Verify through runtime");
		expect(itemOf(harness.snapshot(), "Document").id).toBe("t6");
		expect(itemOf(harness.snapshot(), "Already checked").status).toBe("completed");
		expect(itemOf(harness.snapshot(), "Old approach").status).toBe("abandoned");
		expect(result.details?.operations).toEqual(["add", "explain", "done", "start"]);
	});

	test("completion promotes the earliest pending task", async () => {
		const harness = fixture(populated());
		const result = await harness.call({ done_id: "t1" });
		expect(result.isError).not.toBe(true);
		expect(itemOf(harness.snapshot(), "Implement").status).toBe("completed");
		expect(itemOf(harness.snapshot(), "Review").status).toBe("in_progress");
	});

	test("goal updates only goal fields without normalizing imported statuses or clocks", async () => {
		const harness = fixture(timed());
		const nextGoal = { title: "Updated", summary: "Measured", acceptance: "Complete" };
		const result = await harness.callAt(epoch + 5_000, { goal: nextGoal });
		expect(result.isError).not.toBe(true);
		expect(harness.snapshot().goal).toEqual({
			objective: "Updated",
			measure: "Measured",
			doneWhen: "Complete",
		});
		expectSaved(harness, result, { goal: { objective: "Updated", measure: "Measured", doneWhen: "Complete" }, items: timed().items }, 0);
	});

	test("goal on an empty list without add is rejected", async () => {
		const harness = fixture();
		const res = await expectRejected(harness, () => harness.call({ goal: goalInput }));
		expect(resultText(res)).toContain("provide at least one item in add");
	});

	test("missing goal requires goal alongside mutations", async () => {
		const noGoal: TodoNotes = { ...populated(), goal: null };
		const harness = fixture(noGoal);
		await expectRejected(harness, () => harness.call({ done_id: "t1" }));
		const fixed = await harness.call({ goal: goalInput, done_id: "t1" });
		expect(fixed.isError).not.toBe(true);
		expect(harness.snapshot().goal).toEqual(goal);
	});

	test("rejects old DSL input shape and allows empty argument object as view", async () => {
		const harness = fixture();
		const dsl = await expectRejected(harness, () => harness.call({ input: "*** Begin Todo\nVIEW\n*** End Todo" }));
		expect(resultText(dsl)).toContain("Invalid todo arguments");
		const empty = await harness.call({});
		expect(empty.isError).toBeUndefined();
		expect(resultText(empty)).toContain("Todo list is empty.");
	});

	test("rejects duplicate task titles and conflicting start_id / done_id / drop_ids", async () => {
		const harness = fixture(populated());
		await expectRejected(harness, () => harness.call({ add: [{ title: "Implement", detail: "Duplicate", minutes: 5 }] }));
		await expectRejected(harness, () => harness.call({ done_id: "t2", drop_ids: ["t2"] }));
		await expectRejected(harness, () => harness.call({ start_id: "t2", done_id: "t2" }));
		await expectRejected(harness, () => harness.call({ start_id: "t2", drop_ids: ["t2"] }));
	});
});

describe("host list authority", () => {
	test("a call that follows another before the first result reaches the branch works on the live host list", async () => {
		const harness = fixture();
		const first = await at(epoch, () =>
			runTodo(harness.session, {
				goal: goalInput,
				add: [
					{ title: "First", detail: "Open the list", minutes: 10 },
					{ title: "Second", detail: "Follow it", minutes: 20 },
				],
			}),
		);
		expect(first.isError).not.toBe(true);
		expect(harness.session.sessionManager.getBranch().some((entry) => entry.type === "message")).toBe(false);
		const second = await at(epoch + 5_000, () => runTodo(harness.session, { done_id: "t1", explain: [{ id: "t2", note: "Now active" }] }));
		expect(second.isError).not.toBe(true);
		expect(second.details?.phases).toStrictEqual([
			{
				name: "Tasks",
				tasks: [
					{ content: "First", status: "completed" },
					{ content: "Second", status: "in_progress" },
				],
			},
		]);
		expect(harness.session.getTodoPhases()).toStrictEqual(second.details?.phases ?? []);
		const more = second.details?.more;
		expect(more?.goal).toEqual(goal);
		expect(more?.phases[0]?.items.map((item) => item.explanation)).toEqual(["Open the list", "Now active"]);
	});

	test("the branch state combines the notes with the host list, which the notes alone do not reproduce", async () => {
		const harness = fixture();
		await harness.call({
			goal: goalInput,
			add: [
				{ title: "First", detail: "Open the list", minutes: 10 },
				{ title: "Second", detail: "Follow it", minutes: 20 },
			],
		});
		const facts = foldBranch(harness.session.sessionManager.getBranch());
		expect(facts.state.kind === "list" ? facts.state.phases.flatMap((phase) => phase.items.map((item) => item.title)) : []).toEqual([
			"First",
			"Second",
		]);
		expect(toSnapshot(facts.state)).toEqual(harness.snapshot());
		const notesOnly = harness.session.sessionManager.getBranch().filter((entry) => entry.type === "custom");
		const alone = foldBranch(notesOnly);
		expect(alone.state).toEqual({ kind: "empty" });
		expect(alone.notes.items.map((item) => item.title)).toEqual(["First", "Second"]);
	});

	test("a call through eval, which the host records as user_todo_edit instead of a todo result, rebuilds the same list", async () => {
		const harness = fixture();
		const manager = harness.session.sessionManager;
		const result = await at(epoch, () =>
			runTodo(harness.session, {
				goal: goalInput,
				add: [
					{ title: "First", detail: "Open the list", minutes: 10 },
					{ title: "Second", detail: "Follow it", minutes: 20 },
				],
			}),
		);
		const details = result.details;
		if (details === undefined) throw new Error("todo returned no details");
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: details.phases });
		expect(manager.getBranch().some((entry) => entry.type === "message")).toBe(false);
		expect(details.more.phases).toHaveLength(1);
		expect(toSnapshot(foldBranch(manager.getBranch()).state)).toEqual(details.more);
		expect(toSnapshot(branchFacts(manager).state)).toEqual(details.more);
	});
});

describe("atomic batch timing through the authority branch", () => {
	test("all transitions share T and transient active add tasks gain no execution time", async () => {
		const harness = fixture();
		const anchor = epoch + 10_000;
		const result = await at(
			anchor,
			() =>
				harness.run({
					goal: goalInput,
					add: [
						{ title: "First", detail: "Complete within the batch", minutes: 2 },
						{ title: "Second", detail: "Pause within the batch", minutes: 3 },
						{ title: "Third", detail: "Remain active", minutes: 4 },
					],
					done_id: "t1",
					drop_ids: ["t2"],
					explain: [{ id: "t3", note: "Accepted active explanation" }],
				}),
			1_000,
		);
		const first = createdEstimate(harness, "First", 2);
		const second = createdEstimate(harness, "Second", 3);
		const third = createdEstimate(harness, "Third", 4);
		expect(new Set([first.budgetId, second.budgetId, third.budgetId]).size).toBe(3);
		expectSaved(
			harness,
			result,
			{
				goal,
				items: [
					note("t1", "Tasks", "First", "Complete within the batch", first, closed("completed", null, 0, anchor)),
					note("t2", "Tasks", "Second", "Pause within the batch", second, closed("abandoned", null, 0, anchor)),
					note("t3", "Tasks", "Third", "Accepted active explanation", third, active(anchor, 0, anchor)),
				],
			},
			0,
		);
	});

	test("existing active time is settled at the same T as its successor starts", async () => {
		const initial = timed();
		const harness = fixture(initial);
		const anchor = epoch + 6_000;
		const result = await at(
			anchor,
			() =>
				harness.run({
					start_id: "t2",
					explain: [{ id: "t2", note: "Continue with review" }],
				}),
			1_000,
		);
		const expected = withItem(withItem(initial, "t1", { progress: parked(epoch, 7_250, anchor) }), "t2", {
			explanation: "Continue with review",
			progress: active(anchor, 500, anchor),
		});
		expectSaved(harness, result, expected, 0);
	});

	test("start_id pauses the clock, paused estimate, resume, active estimate and done_id preserve active elapsed time", async () => {
		const initial = timed();
		const harness = fixture(initial);
		const paused = withItem(withItem(initial, "t1", { progress: parked(epoch, 7_250, epoch + 6_000) }), "t2", {
			progress: active(epoch + 6_000, 500, epoch + 6_000),
		});
		expectSaved(harness, await harness.callAt(epoch + 6_000, { start_id: "t2" }), paused, 0);
		const reestimated = await harness.callAt(epoch + 20_000, { estimate: [{ id: "t1", minutes: 12 }] });
		const changedBudget = createdEstimate(harness, "Implement", 12);
		expect(changedBudget.budgetId).not.toBe("implement-budget");
		const changed = withItem(paused, "t1", { estimate: changedBudget });
		expectSaved(harness, reestimated, changed, 1);
		expect(reestimated.details?.changes).toEqual([{ op: "estimate", id: "t1", title: "Implement", estimatedMinutes: 12 }]);
		expect(elapsedOf(progressOf(harness, "Implement"), epoch + 29_000)).toBe(7_250);

		const sameEstimate = await harness.callAt(epoch + 25_000, { estimate: [{ id: "t1", minutes: 12 }] });
		expectSaved(harness, sameEstimate, changed, 2);

		const resumed = withItem(withItem(changed, "t1", { progress: active(epoch, 7_250, epoch + 30_000) }), "t2", {
			progress: parked(epoch + 6_000, 24_500, epoch + 30_000),
		});
		expectSaved(harness, await harness.callAt(epoch + 30_000, { start_id: "t1" }), resumed, 3);
		expect(elapsedOf(progressOf(harness, "Implement"), epoch + 35_000)).toBe(12_250);

		const final = withItem(withItem(resumed, "t1", { progress: closed("completed", epoch, 12_250, epoch + 35_000) }), "t2", {
			progress: active(epoch + 6_000, 24_500, epoch + 35_000),
		});
		expectSaved(harness, await harness.callAt(epoch + 35_000, { done_id: "t1" }), final, 4);
	});

	test("a transition leaves the time spent waiting on the user in ask out of elapsed time", async () => {
		const harness = fixture(timed());
		const manager = harness.session.sessionManager;
		manager.appendCustomEntry("tool_execution_start", {
			toolCallId: "ask-1",
			toolName: "ask",
			startedAt: new Date(epoch + 2_000).toISOString(),
		});
		manager.appendMessage({
			role: "toolResult",
			toolName: "ask",
			toolCallId: "ask-1",
			content: [{ type: "text", text: "User answers:\nq: A" }],
			details: { results: [] },
			isError: false,
			timestamp: epoch + 302_000,
		});
		const expected = withItem(withItem(timed(), "t1", { progress: closed("completed", epoch, 7_250, epoch + 306_000) }), "t2", {
			progress: active(epoch + 306_000, 500, epoch + 306_000),
		});
		expectSaved(harness, await harness.callAt(epoch + 306_000, { done_id: "t1" }), expected, 0);
	});

	const limit = DEFAULT_SETTINGS.leafMaxMinutes;

	test("an estimate at the per-item limit is accepted in add and estimate", async () => {
		const harness = fixture(timed());
		const result = await harness.callAt(epoch + 1_000, {
			estimate: [{ id: "t2", minutes: limit }],
			add: [{ phase: "Delivery", title: "Boundary", detail: "Exactly at the limit", minutes: limit }],
		});
		expect(result.isError).not.toBe(true);
		expect(estimateOf(harness.snapshot(), "Review").minutes).toBe(limit);
		expect(estimateOf(harness.snapshot(), "Boundary").minutes).toBe(limit);
	});

	test("an estimate over the per-item limit rejects the entire batch", async () => {
		const harness = fixture(timed());
		const result = await expectRejected(harness, () =>
			harness.callAt(epoch + 1_000, {
				explain: [{ id: "t1", note: "Would change" }],
				estimate: [{ id: "t2", minutes: limit + 1 }],
			}),
		);
		expect(resultText(result)).toContain(`exceeds the ${limit}-minute limit for one item`);
	});

	test("the configured per-item limit replaces the default", async () => {
		const harness = fixture(timed());
		const over = await expectRejected(harness, () =>
			at(epoch + 1_000, () => harness.run({ add: [{ phase: "Delivery", title: "Over", detail: "Too high", minutes: 16 }] }, 15)),
		);
		expect(resultText(over)).toContain("exceeds the 15-minute limit for one item");
		const within = await at(epoch + 1_000, () =>
			harness.run({ add: [{ phase: "Delivery", title: "Within", detail: "At limit", minutes: 15 }] }, 15),
		);
		expect(within.isError).not.toBe(true);
		expect(estimateOf(harness.snapshot(), "Within").minutes).toBe(15);
	});

	for (const minutes of [5, 20]) {
		test(`estimate cannot change a budget that received an overtime warning: ${minutes} min`, async () => {
			const harness = fixture(timed());
			harness.session.sessionManager.appendCustomMessageEntry(OVERTIME_TYPE, "overtime", true, {
				budgetId: "implement-budget",
				title: "Implement",
				estimatedMinutes: 10,
				elapsedMs: 600_000,
			});
			const rejected = await expectRejected(harness, () => harness.callAt(epoch + 700_000, { estimate: [{ id: "t1", minutes }] }));
			expect(resultText(rejected)).toContain("already received an overtime warning");

			const continued = await harness.callAt(epoch + 700_000, {
				estimate: [{ id: "t1", minutes: 10 }],
				add: [{ phase: "Delivery", title: "Implement remainder", detail: "Finish remaining work", minutes: 15 }],
			});
			expect(continued.isError).not.toBe(true);
			expect(estimateOf(harness.snapshot(), "Implement").budgetId).toBe("implement-budget");
			expect(estimateOf(harness.snapshot(), "Implement remainder").minutes).toBe(15);
		});
	}

	test("late failure preserves all original time, goal, status, branch and projection", async () => {
		const harness = fixture(timed());
		await expectRejected(harness, () =>
			harness.callAt(epoch + 6_000, {
				goal: { title: "Replacement", summary: "New measure", acceptance: "New boundary" },
				done_id: "t1",
				estimate: [{ id: "missing", minutes: 20 }],
			}),
		);
		expect(harness.snapshot()).toEqual(snapshotOf(timed()));
		expect(harness.notesEntries()).toHaveLength(1);
		expect(harness.projections).toHaveLength(0);
	});
});

describe("compact mutation output and clock-time conversion", () => {
	test("mutation returns IDs, current time, active due-by clock, omits pending explanations and closed items", async () => {
		const harness = fixture();
		const t0 = epoch;
		const initResult = await harness.callAt(t0, {
			goal: goalInput,
			add: [
				{ phase: "Build", title: "Alpha", detail: "Detailed alpha acceptance criteria", minutes: 30 },
				{ phase: "Build", title: "Beta", detail: "Detailed beta acceptance criteria", minutes: 20 },
				{ phase: "Verify", title: "Gamma", detail: "Detailed gamma acceptance criteria", minutes: 15 },
			],
		});
		const initText = resultText(initResult);
		expect(initText).toContain(`Current time: ${formatDateTime(t0)}`);
		expect(initText).toContain("[t1] [in_progress]");
		expect(initText).toContain("[t2] [pending]");
		expect(initText).toContain(`started ${formatClock(t0, t0)}, due by ${formatClock(t0 + 30 * 60_000, t0)}`);
		expect(initText).toContain("Detailed alpha acceptance criteria");
		expect(initText).toContain('Active phase 1/2 "Build" (0/2 done)');
		expect(initText).not.toContain("todo://");
		expect(initText).not.toContain("Detailed beta acceptance criteria");
		expect(initText).not.toContain("Detailed gamma acceptance criteria");
		expect(initText).not.toContain("Estimate:");
		expect(initText.match(/due by /g)).toHaveLength(1);

		const t1 = t0 + 10 * 60_000;
		const doneResult = await harness.callAt(t1, { done_id: "t1" });
		const doneText = resultText(doneResult);
		expect(doneText).toContain(`Current time: ${formatDateTime(t1)}`);
		expect(doneText).not.toContain('"Alpha"');
		expect(doneText).toContain(`started ${formatClock(t1, t1)}, due by ${formatClock(t1 + 20 * 60_000, t1)}`);
		expect(doneText).toContain("Detailed beta acceptance criteria");
		expect(doneText).toContain('Omitted: closed items and pending explanations. Call todo({}) or todo({ view: "<phase>" }) to inspect.');
		expect(doneText).not.toContain("Estimate:");
	});

	test("atomic done_id + start_id skips an intermediate pending task without falsely starting or pausing it", async () => {
		const harness = fixture();
		const t0 = epoch;
		await harness.callAt(t0, {
			goal: goalInput,
			add: [
				{ title: "A", detail: "Task A", minutes: 10 },
				{ title: "B", detail: "Task B", minutes: 20 },
				{ title: "C", detail: "Task C", minutes: 15 },
			],
		});
		const t1 = t0 + 4 * 60_000;
		await harness.callAt(t1, { done_id: "t1", start_id: "t3" });
		expect(progressOf(harness, "A")).toEqual(closed("completed", t0, 4 * 60_000, t1));
		expect(progressOf(harness, "B")).toEqual(FRESH);
		expect(progressOf(harness, "C")).toEqual(active(t1, 0, t1));
	});
});
