import { describe, expect, spyOn, test } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { TodoPhase as HostTodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { branchFacts, readTodoMore } from "../src/branch.ts";
import type { TodoSession } from "../src/commit.ts";
import { formatClock, formatDateTime } from "../src/format.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";
import {
	elapsedTime,
	type ItemTime,
	OVERTIME_TYPE,
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
type SnapshotItem = TodoMoreSnapshot["phases"][number]["items"][number];
type EstimatedTime = Extract<ItemTime, { kind: "estimated" }>;

async function at<T>(time: number, invoke: () => Promise<T>, tick = 0): Promise<T> {
	let reads = 0;
	const clock = spyOn(Date, "now").mockImplementation(() => time + tick * reads++);
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
	notesEntries: () => SessionEntry[];
	run: (raw: unknown, leafMaxMinutes?: number) => Promise<AgentToolResult<TodoMoreDetails>>;
	call: (args: unknown) => Promise<AgentToolResult<TodoMoreDetails>>;
	callAt: (time: number, args: unknown) => Promise<AgentToolResult<TodoMoreDetails>>;
};

function notesOf(snapshot: TodoMoreSnapshot): TodoNotes {
	return {
		goal: snapshot.goal,
		items: snapshot.phases.flatMap((phase) =>
			phase.items.map((item) => ({
				...(item.id === undefined ? {} : { id: item.id }),
				phase: phase.name,
				title: item.title,
				explanation: item.explanation,
				time: item.time,
				...(item.timestamps === undefined ? {} : { timestamps: item.timestamps }),
				...(item.commit === undefined ? {} : { commit: item.commit }),
			})),
		),
	};
}

function fixture(initial?: TodoMoreSnapshot): Fixture {
	const sessionManager = SessionManager.inMemory("/tmp/todo-more-tool-tests");
	const projections: HostTodoPhase[][] = [];
	let list: HostTodoPhase[] = [];
	const session: TodoSession = {
		sessionManager,
		getTodoPhases: () => structuredClone(list),
		setTodoPhases: (phases) => {
			list = structuredClone(phases);
			projections.push(phases);
		},
	};
	if (initial !== undefined) {
		list = projected(initial);
		sessionManager.appendCustomEntry(TODO_MORE_NOTES_TYPE, notesOf(initial));
		sessionManager.appendMessage(todoResultMessage({ op: "update", phases: projected(initial) }, epoch));
	}
	const run: Fixture["run"] = async (raw, leafMaxMinutes) => {
		const result = await runTodo(session, raw, leafMaxMinutes);
		sessionManager.appendMessage(todoResultMessage(result.details, Date.now(), result.isError === true));
		return result;
	};
	const callAt = (time: number, args: unknown): Promise<AgentToolResult<TodoMoreDetails>> => at(time, () => run(args));
	return {
		session,
		projections,
		snapshot: () => toSnapshot(readTodoMore(sessionManager.getBranch())),
		notesEntries: () => sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === TODO_MORE_NOTES_TYPE),
		run,
		call: (args) => callAt(epoch, args),
		callAt,
	};
}

function projected(snapshot: TodoMoreSnapshot): HostTodoPhase[] {
	return snapshot.phases.map((phase) => ({
		name: phase.name,
		tasks: phase.items.map((item) => ({ content: item.title, status: item.status })),
	}));
}

function expectSaved(
	harness: Fixture,
	result: AgentToolResult<TodoMoreDetails>,
	expected: TodoMoreSnapshot,
	previousProjections: number,
): void {
	expect(result.isError).not.toBe(true);
	expect(harness.snapshot()).toEqual(expected);
	expect(result.details?.more).toEqual(expected);
	expect(result.details?.phases).toStrictEqual(projected(expected));
	expect(harness.session.getTodoPhases()).toStrictEqual(projected(expected));
	expect(branchFacts(harness.session.sessionManager).notes).toEqual(notesOf(expected));
	expect(harness.projections).toHaveLength(previousProjections + 1);
	expect(harness.projections.at(-1)).toStrictEqual(projected(expected));
	expectNoFullListEntry(harness);
}

function expectNoFullListEntry(harness: Fixture): void {
	for (const entry of harness.session.sessionManager.getBranch()) {
		if (entry.type !== "custom" || !entry.customType.startsWith(TODO_MORE_ENTRY_TYPE)) continue;
		expect(entry.customType).toBe(TODO_MORE_NOTES_TYPE);
		expect(Object.keys(entry.data as object).sort()).toEqual(["goal", "items"]);
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
	expect(result.details?.phases).toStrictEqual(projected(before));
	expect(result.details).not.toHaveProperty("changes");
	expect(harness.snapshot()).toEqual(before);
	expect(harness.notesEntries()).toEqual(notes);
	expect(harness.session.getTodoPhases()).toEqual(list);
	expect(harness.projections).toEqual(projections);
	return result;
}

function itemOf(snapshot: TodoMoreSnapshot, title: string): SnapshotItem {
	const item = snapshot.phases.flatMap((phase) => phase.items).find((candidate) => candidate.title === title);
	if (item === undefined) throw new Error(`Expected task ${title}`);
	return item;
}

function resultText(result: AgentToolResult<TodoMoreDetails>): string {
	return result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function estimateOf(snapshot: TodoMoreSnapshot, title: string): EstimatedTime {
	const time = itemOf(snapshot, title).time;
	if (time.kind !== "estimated") throw new Error(`Expected estimate for ${title}`);
	return time;
}

function time(budgetId: string, minutes: number, elapsedMs = 0, runningSince: number | null = null): EstimatedTime {
	return { kind: "estimated", budgetId, minutes, elapsedMs, runningSince };
}

function createdTime(harness: Fixture, title: string, minutes: number, runningSince: number | null, elapsedMs = 0): EstimatedTime {
	const budgetId = estimateOf(harness.snapshot(), title).budgetId;
	expect(budgetId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
	return time(budgetId, minutes, elapsedMs, runningSince);
}

function populated(): TodoMoreSnapshot {
	return {
		goal,
		phases: [
			{
				name: "Delivery",
				items: [
					{ id: "t1", title: "Implement", explanation: "Consume complete commands", status: "in_progress", time: { kind: "missing" } },
					{ id: "t2", title: "Review", explanation: "Review original behavior", status: "pending", time: { kind: "missing" } },
				],
			},
			{
				name: "Verification",
				items: [
					{ id: "t3", title: "Runtime", explanation: "Use the real host", status: "pending", time: { kind: "missing" } },
					{ id: "t4", title: "Already checked", explanation: "Retain earlier evidence", status: "completed", time: { kind: "missing" } },
					{ id: "t5", title: "Old approach", explanation: "Keep historical scope", status: "abandoned", time: { kind: "missing" } },
				],
			},
		],
	};
}

function timed(): TodoMoreSnapshot {
	const snapshot = populated();
	itemOf(snapshot, "Implement").time = time("implement-budget", 10, 1_250, epoch);
	itemOf(snapshot, "Review").time = time("review-budget", 20, 500);
	itemOf(snapshot, "Runtime").time = time("runtime-budget", 30, 750);
	return snapshot;
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
		const implement = createdTime(harness, "Implement", 10, epoch);
		const review = createdTime(harness, "Review", 20, null);
		expect(implement.budgetId).not.toBe(review.budgetId);
		expectSaved(
			harness,
			result,
			{
				goal,
				phases: [
					{
						name: "Tasks",
						items: [
							{
								id: "t1",
								title: "Implement",
								explanation: "Consume the structured input",
								status: "in_progress",
								time: implement,
								timestamps: { startedAt: epoch, statusChangedAt: epoch },
							},
							{
								id: "t2",
								title: "Review",
								explanation: "Check all fields",
								status: "pending",
								time: review,
								timestamps: { statusChangedAt: epoch },
							},
						],
					},
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

	test("done_ids, start_id, explain and add publish one snapshot preserving unrelated rich fields", async () => {
		const harness = fixture(populated());
		const result = await harness.callAt(epoch + 5_000, {
			done_ids: ["t1"],
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
		const result = await harness.call({ done_ids: ["t1"] });
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
		expect(itemOf(harness.snapshot(), "Implement").time).toEqual(time("implement-budget", 10, 1_250, epoch));
	});

	test("goal on an empty list without add is rejected", async () => {
		const harness = fixture();
		const res = await expectRejected(harness, () => harness.call({ goal: goalInput }));
		expect(resultText(res)).toContain("provide at least one item in add");
	});

	test("missing goal requires goal alongside mutations", async () => {
		const noGoal: TodoMoreSnapshot = { ...populated(), goal: null };
		const harness = fixture(noGoal);
		await expectRejected(harness, () => harness.call({ done_ids: ["t1"] }));
		const fixed = await harness.call({ goal: goalInput, done_ids: ["t1"] });
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

	test("rejects duplicate task titles and conflicting start_id / done_ids / drop_ids", async () => {
		const harness = fixture(populated());
		await expectRejected(harness, () => harness.call({ add: [{ title: "Implement", detail: "Duplicate", minutes: 5 }] }));
		await expectRejected(harness, () => harness.call({ done_ids: ["t2"], drop_ids: ["t2"] }));
		await expectRejected(harness, () => harness.call({ start_id: "t2", done_ids: ["t2"] }));
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
		const second = await at(epoch + 5_000, () =>
			runTodo(harness.session, {
				done_ids: ["t1"],
				explain: [{ id: "t2", note: "Now active" }],
			}),
		);
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

	test("a todo result and the notes together reproduce the list; the notes alone do not", async () => {
		const harness = fixture();
		await harness.call({
			goal: goalInput,
			add: [
				{ title: "First", detail: "Open the list", minutes: 10 },
				{ title: "Second", detail: "Follow it", minutes: 20 },
			],
		});
		const rebuilt = readTodoMore(harness.session.sessionManager.getBranch());
		expect(toSnapshot(rebuilt)).toEqual(harness.snapshot());
		const notesOnly = harness.session.sessionManager.getBranch().filter((entry) => entry.type === "custom");
		expect(readTodoMore(notesOnly)).toEqual({ kind: "empty" });
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
					done_ids: ["t1"],
					drop_ids: ["t2"],
					explain: [{ id: "t3", note: "Accepted active explanation" }],
				}),
			1_000,
		);
		const first = createdTime(harness, "First", 2, null);
		const second = createdTime(harness, "Second", 3, null);
		const third = createdTime(harness, "Third", 4, anchor);
		expect(new Set([first.budgetId, second.budgetId, third.budgetId]).size).toBe(3);
		expectSaved(
			harness,
			result,
			{
				goal,
				phases: [
					{
						name: "Tasks",
						items: [
							{
								id: "t1",
								title: "First",
								explanation: "Complete within the batch",
								status: "completed",
								time: first,
								timestamps: { completedAt: anchor, statusChangedAt: anchor },
							},
							{
								id: "t2",
								title: "Second",
								explanation: "Pause within the batch",
								status: "abandoned",
								time: second,
								timestamps: { abandonedAt: anchor, statusChangedAt: anchor },
							},
							{
								id: "t3",
								title: "Third",
								explanation: "Accepted active explanation",
								status: "in_progress",
								time: third,
								timestamps: { startedAt: anchor, statusChangedAt: anchor },
							},
						],
					},
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
		const expected = timed();
		Object.assign(itemOf(expected, "Implement"), {
			status: "pending",
			time: time("implement-budget", 10, 7_250),
			timestamps: { startedAt: epoch, pausedAt: anchor, statusChangedAt: anchor },
		});
		Object.assign(itemOf(expected, "Review"), {
			status: "in_progress",
			explanation: "Continue with review",
			time: time("review-budget", 20, 500, anchor),
			timestamps: { startedAt: anchor, statusChangedAt: anchor },
		});
		expectSaved(harness, result, expected, 0);
	});

	test("start_id pauses the clock, paused estimate, resume, active estimate and done_ids preserve active elapsed time", async () => {
		const initial = timed();
		const harness = fixture(initial);
		const paused: TodoMoreSnapshot = {
			goal,
			phases: [
				{
					name: "Delivery",
					items: [
						{
							id: "t1",
							title: "Implement",
							explanation: "Consume complete commands",
							status: "pending",
							time: time("implement-budget", 10, 7_250),
							timestamps: { startedAt: epoch, pausedAt: epoch + 6_000, statusChangedAt: epoch + 6_000 },
						},
						{
							id: "t2",
							title: "Review",
							explanation: "Review original behavior",
							status: "in_progress",
							time: time("review-budget", 20, 500, epoch + 6_000),
							timestamps: { startedAt: epoch + 6_000, statusChangedAt: epoch + 6_000 },
						},
					],
				},
				initial.phases[1]!,
			],
		};
		expectSaved(harness, await harness.callAt(epoch + 6_000, { start_id: "t2" }), paused, 0);
		const reestimated = await harness.callAt(epoch + 20_000, { estimate: [{ id: "t1", minutes: 12 }] });
		const changedBudget = createdTime(harness, "Implement", 12, null, 7_250);
		expect(changedBudget.budgetId).not.toBe("implement-budget");
		const changed = structuredClone(paused);
		itemOf(changed, "Implement").time = changedBudget;
		expectSaved(harness, reestimated, changed, 1);
		expect(reestimated.details?.changes).toEqual([{ op: "estimate", id: "t1", title: "Implement", estimatedMinutes: 12 }]);
		expect(elapsedTime(estimateOf(harness.snapshot(), "Implement"), epoch + 29_000)).toBe(7_250);

		const sameEstimate = await harness.callAt(epoch + 25_000, { estimate: [{ id: "t1", minutes: 12 }] });
		expect(sameEstimate.isError).not.toBe(true);
		expect(harness.snapshot()).toEqual(changed);

		const resumed = structuredClone(changed);
		Object.assign(itemOf(resumed, "Implement"), {
			status: "in_progress",
			time: time(changedBudget.budgetId, 12, 7_250, epoch + 30_000),
			timestamps: { startedAt: epoch, statusChangedAt: epoch + 30_000 },
		});
		Object.assign(itemOf(resumed, "Review"), {
			status: "pending",
			time: time("review-budget", 20, 24_500),
			timestamps: { startedAt: epoch + 6_000, pausedAt: epoch + 30_000, statusChangedAt: epoch + 30_000 },
		});
		expectSaved(harness, await harness.callAt(epoch + 30_000, { start_id: "t1" }), resumed, 3);
		expect(elapsedTime(estimateOf(harness.snapshot(), "Implement"), epoch + 35_000)).toBe(12_250);

		const final = structuredClone(resumed);
		Object.assign(itemOf(final, "Implement"), {
			status: "completed",
			time: time(changedBudget.budgetId, 12, 12_250),
			timestamps: { startedAt: epoch, completedAt: epoch + 35_000, statusChangedAt: epoch + 35_000 },
		});
		Object.assign(itemOf(final, "Review"), {
			status: "in_progress",
			time: time("review-budget", 20, 24_500, epoch + 35_000),
			timestamps: { startedAt: epoch + 6_000, statusChangedAt: epoch + 35_000 },
		});
		expectSaved(harness, await harness.callAt(epoch + 35_000, { done_ids: ["t1"] }), final, 4);
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
		expect((await harness.callAt(epoch + 306_000, { done_ids: ["t1"] })).isError).not.toBe(true);
		expect(estimateOf(harness.snapshot(), "Implement")).toEqual(time("implement-budget", 10, 7_250));
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
				done_ids: ["t1"],
				estimate: [{ id: "missing", minutes: 20 }],
			}),
		);
		expect(harness.snapshot()).toEqual(timed());
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
		const doneResult = await harness.callAt(t1, { done_ids: ["t1"] });
		const doneText = resultText(doneResult);
		expect(doneText).toContain(`Current time: ${formatDateTime(t1)}`);
		expect(doneText).not.toContain('"Alpha"');
		expect(doneText).toContain(`started ${formatClock(t1, t1)}, due by ${formatClock(t1 + 20 * 60_000, t1)}`);
		expect(doneText).toContain("Detailed beta acceptance criteria");
		expect(doneText).toContain('Omitted: closed items and pending explanations. Call todo({}) or todo({ view: "<phase>" }) to inspect.');
		expect(doneText).not.toContain("Estimate:");
	});

	test("atomic done_ids + start_id skips an intermediate pending task without falsely starting or pausing it", async () => {
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
		await harness.callAt(t1, { done_ids: ["t1"], start_id: "t3" });
		expect(itemOf(harness.snapshot(), "A").timestamps).toEqual({ startedAt: t0, completedAt: t1, statusChangedAt: t1 });
		expect(itemOf(harness.snapshot(), "B").timestamps).toEqual({ statusChangedAt: t0 });
		expect(itemOf(harness.snapshot(), "C").timestamps).toEqual({ startedAt: t1, statusChangedAt: t1 });
	});
});
