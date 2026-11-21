import { describe, expect, spyOn, test } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { TodoPhase as HostTodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { branchFacts, readTodoMore } from "../src/branch.ts";
import type { TodoSession } from "../src/commit.ts";
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
	objective: "Ship atomic streaming todos",
	measure: "Every call publishes one accepted state",
	doneWhen: "Tasks, explanations and goal survive the complete batch",
};
const init = `INIT ${JSON.stringify(goal.objective)} ${JSON.stringify(goal.measure)} ${JSON.stringify(goal.doneWhen)}`;
type SnapshotItem = TodoMoreSnapshot["phases"][number]["items"][number];
type EstimatedTime = Extract<ItemTime, { kind: "estimated" }>;

function document(...lines: string[]): string {
	return ["*** Begin Todo", ...lines, "*** End Todo"].join("\n");
}

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
	/** Every list the plugin wrote to the host. */
	projections: HostTodoPhase[][];
	snapshot: () => TodoMoreSnapshot;
	notesEntries: () => SessionEntry[];
	/** Runs the tool, then persists its result the way the host does. */
	run: (raw: unknown, parentCwd?: Parameters<typeof runTodo>[2], leafMaxMinutes?: number) => Promise<AgentToolResult<TodoMoreDetails>>;
	call: (...lines: string[]) => Promise<AgentToolResult<TodoMoreDetails>>;
	callAt: (time: number, ...lines: string[]) => Promise<AgentToolResult<TodoMoreDetails>>;
};

function notesOf(snapshot: TodoMoreSnapshot): TodoNotes {
	return {
		goal: snapshot.goal,
		items: snapshot.phases.flatMap((phase) =>
			phase.items.map((item) => ({
				phase: phase.name,
				title: item.title,
				explanation: item.explanation,
				time: item.time,
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
		model: undefined,
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
	const run: Fixture["run"] = async (raw, parentCwd, leafMaxMinutes) => {
		const result = await runTodo(session, raw, parentCwd, leafMaxMinutes);
		sessionManager.appendMessage(todoResultMessage(result.details, Date.now(), result.isError === true));
		return result;
	};
	const callAt = (time: number, ...lines: string[]): Promise<AgentToolResult<TodoMoreDetails>> =>
		at(time, () => run({ input: document(...lines) }));
	return {
		session,
		projections,
		snapshot: () => toSnapshot(readTodoMore(sessionManager.getBranch())),
		notesEntries: () => sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === TODO_MORE_NOTES_TYPE),
		run,
		call: (...lines: string[]) => callAt(epoch, ...lines),
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

/** The plugin's custom entries carry only what the host list cannot hold. */
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
					{ title: "Implement", explanation: "Consume complete commands", status: "in_progress", time: { kind: "missing" } },
					{ title: "Review", explanation: "Review original behavior", status: "pending", time: { kind: "missing" } },
				],
			},
			{
				name: "Verification",
				items: [
					{ title: "Runtime", explanation: "Use the real host", status: "pending", time: { kind: "missing" } },
					{ title: "Already checked", explanation: "Retain earlier evidence", status: "completed", time: { kind: "missing" } },
					{ title: "Old approach", explanation: "Keep historical scope", status: "abandoned", time: { kind: "missing" } },
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

describe("atomic Todo document execution", () => {
	test("flat initialization with multiple estimates appends one snapshot and defaults to Tasks", async () => {
		const harness = fixture();
		const result = await harness.call(init, 'ADD "Implement" "Consume the text document" 10', 'ADD "Review" "Check all fields" 20');
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
							{ title: "Implement", explanation: "Consume the text document", status: "in_progress", time: implement },
							{ title: "Review", explanation: "Check all fields", status: "pending", time: review },
						],
					},
				],
			},
			0,
		);
		expect(result.details?.op).toBe("init");
		expect(result.details?.operations).toEqual(["init"]);
		expect(result.details?.changes).toEqual([
			{
				op: "init",
				goal,
				list: [
					{
						phase: "Tasks",
						items: [
							{ title: "Implement", explanation: "Consume the text document", estimatedMinutes: 10 },
							{ title: "Review", explanation: "Check all fields", estimatedMinutes: 20 },
						],
					},
				],
			},
		]);
	});

	test("task identity survives escaped quotes, unicode, newlines and surrounding whitespace across one batch", async () => {
		const harness = fixture();
		const title = '  检查 "quoted" \\ path\nnext 🧪  ';
		const quoted = JSON.stringify(title);
		const result = await harness.call(
			init,
			`ADD ${quoted} "Original explanation" 10`,
			`EXPLAIN ${quoted} "Accepted explanation"`,
			`DONE ${quoted}`,
		);
		expectSaved(
			harness,
			result,
			{
				goal,
				phases: [
					{
						name: "Tasks",
						items: [{ title, explanation: "Accepted explanation", status: "completed", time: createdTime(harness, title, 10, null) }],
					},
				],
			},
			0,
		);
	});

	for (const commands of [
		[init],
		[init, 'PHASE "Empty phase"'],
		[init, 'ADD "Repeated" "First" 10', 'ADD "Repeated" "Duplicate" 20'],
		[init, 'PHASE "Repeated"', 'ADD "First" "First" 10', 'PHASE "Repeated"', 'ADD "Second" "Second" 20'],
		[init, 'ADD "" "No title" 10'],
		[init, 'ADD "No explanation" "  " 10'],
	]) {
		test(`invalid initialization cannot replace an existing list: ${commands.slice(1).join("; ") || "no tasks"}`, async () => {
			const harness = fixture(populated());
			await expectRejected(harness, () => harness.call(...commands));
		});
	}

	test("phased initialization normalizes across all tasks after assembling its phases", async () => {
		const harness = fixture();
		const result = await harness.call(
			init,
			'PHASE "Delivery"',
			'ADD "Implement" "Build the behavior" 10',
			'ADD "Review" "Inspect changes" 20',
			'PHASE "Verification"',
			'ADD "Runtime" "Exercise the host" 30',
		);
		expectSaved(
			harness,
			result,
			{
				goal,
				phases: [
					{
						name: "Delivery",
						items: [
							{
								title: "Implement",
								explanation: "Build the behavior",
								status: "in_progress",
								time: createdTime(harness, "Implement", 10, epoch),
							},
							{ title: "Review", explanation: "Inspect changes", status: "pending", time: createdTime(harness, "Review", 20, null) },
						],
					},
					{
						name: "Verification",
						items: [
							{ title: "Runtime", explanation: "Exercise the host", status: "pending", time: createdTime(harness, "Runtime", 30, null) },
						],
					},
				],
			},
			0,
		);
	});

	test("DONE, START, EXPLAIN and phase additions publish one snapshot preserving unrelated rich fields", async () => {
		const initial = populated();
		const harness = fixture(initial);
		const result = await harness.call(
			'DONE "Implement"',
			'START "Review"',
			'EXPLAIN "Review" "Inspect the final accepted fields"',
			'PHASE "Delivery"',
			'ADD "Polish" "Finish the existing phase" 7',
			'PHASE "Release"',
			'ADD "Publish" "Deliver the accepted result" 12',
		);
		expectSaved(
			harness,
			result,
			{
				goal,
				phases: [
					{
						name: "Delivery",
						items: [
							{ title: "Implement", explanation: "Consume complete commands", status: "completed", time: { kind: "missing" } },
							{ title: "Review", explanation: "Inspect the final accepted fields", status: "in_progress", time: { kind: "missing" } },
							{
								title: "Polish",
								explanation: "Finish the existing phase",
								status: "pending",
								time: createdTime(harness, "Polish", 7, null),
							},
						],
					},
					initial.phases[1]!,
					{
						name: "Release",
						items: [
							{
								title: "Publish",
								explanation: "Deliver the accepted result",
								status: "pending",
								time: createdTime(harness, "Publish", 12, null),
							},
						],
					},
				],
			},
			0,
		);
		expect(result.details?.op).toBe("batch");
		expect(result.details?.operations).toEqual(["done", "start", "explain", "append", "append"]);
		expect(result.details?.changes).toEqual([
			{ op: "done", task: "Implement" },
			{ op: "start", task: "Review" },
			{ op: "explain", task: "Review", explanation: "Inspect the final accepted fields" },
			{ op: "append", phase: "Delivery", items: [{ title: "Polish", explanation: "Finish the existing phase", estimatedMinutes: 7 }] },
			{ op: "append", phase: "Release", items: [{ title: "Publish", explanation: "Deliver the accepted result", estimatedMinutes: 12 }] },
		]);
		expect(result.details?.completedTasks).toEqual([{ phase: "Delivery", content: "Implement" }]);
	});

	for (const lateCommand of [
		'START "Missing task"',
		'EXPLAIN "Review" "  "',
		'GOAL "" "Measured" "Complete"',
		'PHASE "Delivery"\nADD "Review" "Duplicate title" 10',
	]) {
		test(`late error discards an otherwise valid mutation prefix: ${lateCommand}`, async () => {
			const harness = fixture(populated());
			await expectRejected(harness, () => harness.call('DONE "Implement"', 'EXPLAIN "Review" "Would be replaced"', lateCommand));
			expect(harness.notesEntries()).toHaveLength(1);
		});
	}

	test("a late target error discards goal, append and status changes together", async () => {
		const harness = fixture(populated());
		await expectRejected(harness, () =>
			harness.call(
				'GOAL "Replacement" "New measure" "New boundary"',
				'PHASE "Release"',
				'ADD "Publish" "New scope" 10',
				'DONE "Review"',
				'START "Runtime"',
				'RM "Missing task"',
			),
		);
		expect(harness.notesEntries()).toHaveLength(1);
	});

	test("completion promotes the earliest pending task", async () => {
		const harness = fixture(populated());
		const expected = populated();
		itemOf(expected, "Implement").status = "completed";
		itemOf(expected, "Review").status = "in_progress";
		expectSaved(harness, await harness.call('DONE "Implement"'), expected, 0);
	});

	test("GOAL replaces only goal fields without normalizing imported statuses or clocks", async () => {
		const initial = timed();
		itemOf(initial, "Review").status = "in_progress";
		itemOf(initial, "Review").time = time("review-budget", 20, 500, epoch + 1_000);
		const harness = fixture(initial);
		const replacement: TodoGoal = { objective: "New objective", measure: "New measure", doneWhen: "New done boundary" };
		expectSaved(
			harness,
			await harness.callAt(epoch + 50_000, 'GOAL "New objective" "New measure" "New done boundary"'),
			{ goal: replacement, phases: initial.phases },
			0,
		);
	});

	test("missing goal must be restored by GOAL before another operation in the same batch", async () => {
		const initial = populated();
		initial.goal = null;
		const harness = fixture(initial);
		await expectRejected(harness, () => harness.call('EXPLAIN "Review" "Updated"', 'GOAL "New" "Measured" "Complete"'));
		const expected = populated();
		expected.goal = { objective: "New", measure: "Measured", doneWhen: "Complete" };
		itemOf(expected, "Review").explanation = "Updated";
		expectSaved(harness, await harness.call('GOAL "New" "Measured" "Complete"', 'EXPLAIN "Review" "Updated"'), expected, 0);
	});

	test("GOAL on an empty list cannot manufacture a list or a saved goal", async () => {
		const harness = fixture();
		await expectRejected(harness, () => harness.call('GOAL "New" "Measured" "Complete"'));
		expect(harness.notesEntries()).toHaveLength(0);
	});

	test("quoted ALL selects a task, while DONE ALL selects all phases", async () => {
		const initial: TodoMoreSnapshot = {
			goal,
			phases: [
				{
					name: "Delivery",
					items: [
						{ title: "ALL", explanation: "A literal task title", status: "in_progress", time: { kind: "missing" } },
						{ title: "Other", explanation: "Not selected by quoted ALL", status: "pending", time: { kind: "missing" } },
					],
				},
				{
					name: "Verification",
					items: [{ title: "Last", explanation: "Another phase", status: "pending", time: { kind: "missing" } }],
				},
			],
		};
		const harness = fixture(initial);
		const selected = structuredClone(initial);
		itemOf(selected, "ALL").status = "completed";
		itemOf(selected, "Other").status = "in_progress";
		expectSaved(harness, await harness.call('DONE "ALL"'), selected, 0);
		expectSaved(
			harness,
			await harness.call("DONE ALL"),
			{
				goal,
				phases: selected.phases.map((phase) => ({ ...phase, items: phase.items.map((item) => ({ ...item, status: "completed" })) })),
			},
			1,
		);
	});

	test("DROP PHASE and RM PHASE affect only the selected phase", async () => {
		const initial = populated();
		const harness = fixture(initial);
		const verification = structuredClone(initial.phases[1]!);
		verification.items[0]!.status = "in_progress";
		const dropped: TodoMoreSnapshot = {
			goal,
			phases: [{ ...initial.phases[0]!, items: initial.phases[0]!.items.map((item) => ({ ...item, status: "abandoned" })) }, verification],
		};
		expectSaved(harness, await harness.call('DROP PHASE "Delivery"'), dropped, 0);
		expectSaved(harness, await harness.call('RM PHASE "Delivery"'), { goal, phases: [{ name: "Delivery", items: [] }, verification] }, 1);
	});

	for (const remove of ["RM ALL", 'RM "Only task"']) {
		test(`${remove} clears the goal when the list becomes empty`, async () => {
			const initial: TodoMoreSnapshot = {
				goal,
				phases: [
					{
						name: "Tasks",
						items: [{ title: "Only task", explanation: "Complete scope", status: "in_progress", time: { kind: "missing" } }],
					},
				],
			};
			const harness = fixture(initial);
			await expectRejected(harness, () => harness.call(remove, 'PHASE "Tasks"', 'ADD "Replacement" "Cannot inherit a cleared goal" 10'));
			expectSaved(harness, await harness.call(remove), { goal: null, phases: [] }, 0);
			await expectRejected(harness, () => harness.call('PHASE "Tasks"', 'ADD "Replacement" "Still cannot inherit a cleared goal" 10'));
			const result = await harness.call(init, 'ADD "Replacement" "New list with its own goal" 10');
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
									title: "Replacement",
									explanation: "New list with its own goal",
									status: "in_progress",
									time: createdTime(harness, "Replacement", 10, epoch),
								},
							],
						},
					],
				},
				1,
			);
		});
	}

	test("VIEW reads the branch without append, projection, normalization, or clock changes", async () => {
		const initial = timed();
		itemOf(initial, "Implement").status = "pending";
		const harness = fixture(initial);
		const before = structuredClone(harness.notesEntries());
		const result = await harness.callAt(epoch + 90_000, "VIEW");
		expect(result.isError).not.toBe(true);
		expect(result.details?.op).toBe("view");
		expect(result.details).not.toHaveProperty("changes");
		expect(result.details?.more).toEqual(initial);
		expect(result.details?.phases).toStrictEqual(projected(initial));
		expect(harness.snapshot()).toEqual(initial);
		expect(harness.notesEntries()).toEqual(before);
		expect(harness.notesEntries()).toHaveLength(1);
		expect(harness.projections).toHaveLength(0);
	});

	test("old JSON single-operation and inferred-operation arguments are rejected explicitly", async () => {
		const harness = fixture(populated());
		for (const raw of [
			{ op: "done", task: "Implement" },
			{ op: "view" },
			{ goal, items: [{ title: "Replacement", explanation: "Must not be inferred", estimatedMinutes: 10 }] },
		]) {
			const result = await expectRejected(harness, () => harness.run(raw));
			expect(result.content.some((part) => part.type === "text" && /input|document|arguments/i.test(part.text))).toBe(true);
		}
	});

	for (const command of [
		'DONE ""',
		'RM PHASE ""',
		'PHASE "New phase"',
		'PHASE "New phase"\nDONE "Review"',
		'ADD "No phase" "Append requires explicit phase context" 10',
	]) {
		test(`invalid command/context cannot commit a valid mutation prefix: ${command}`, async () => {
			const harness = fixture(populated());
			await expectRejected(harness, () => harness.call('DONE "Implement"', command));
		});
	}

	test("an incomplete envelope or malformed suffix cannot commit a previewed prefix", async () => {
		const harness = fixture(populated());
		for (const input of [
			'*** Begin Todo\nDONE "Implement"\n',
			'*** Begin Todo\nDONE "Implement"\nEXPLAIN "Review" "unfinished',
			`${document('DONE "Implement"')}\nSTART "Review"`,
		])
			await expectRejected(harness, () => harness.run({ input }));
	});
});

describe("host list authority", () => {
	test("a call that follows another before the first result reaches the branch works on the live host list", async () => {
		const harness = fixture();
		const first = await at(epoch, () =>
			runTodo(harness.session, { input: document(init, 'ADD "First" "Open the list" 10', 'ADD "Second" "Follow it" 20') }),
		);
		expect(first.isError).not.toBe(true);
		expect(harness.session.sessionManager.getBranch().some((entry) => entry.type === "message")).toBe(false);
		const second = await at(epoch + 5_000, () =>
			runTodo(harness.session, { input: document('DONE "First"', 'EXPLAIN "Second" "Now active"') }),
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
		await harness.call(init, 'ADD "First" "Open the list" 10', 'ADD "Second" "Follow it" 20');
		const rebuilt = readTodoMore(harness.session.sessionManager.getBranch());
		expect(toSnapshot(rebuilt)).toEqual(harness.snapshot());
		const notesOnly = harness.session.sessionManager.getBranch().filter((entry) => entry.type === "custom");
		expect(readTodoMore(notesOnly)).toEqual({ kind: "empty" });
	});

	test("a write never fails after the host list was accepted: the tool result is the list it wrote", async () => {
		const harness = fixture(populated());
		const result = await harness.call('DONE "Implement"');
		expect(result.isError).not.toBe(true);
		expect(resultText(result)).not.toMatch(/projection|did not accept/i);
	});
});

describe("atomic batch timing through the authority branch", () => {
	test("all transitions share T and transient active ADD tasks gain no command-execution time", async () => {
		const harness = fixture();
		const anchor = epoch + 10_000;
		const result = await at(
			anchor,
			() =>
				harness.run({
					input: document(
						init,
						'ADD "First" "Complete within the batch" 2',
						'ADD "Second" "Pause within the batch" 3',
						'ADD "Third" "Remain active" 4',
						'DONE "First"',
						'DROP "Second"',
						'EXPLAIN "Third" "Accepted active explanation"',
					),
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
							{ title: "First", explanation: "Complete within the batch", status: "completed", time: first },
							{ title: "Second", explanation: "Pause within the batch", status: "abandoned", time: second },
							{ title: "Third", explanation: "Accepted active explanation", status: "in_progress", time: third },
						],
					},
				],
			},
			0,
		);
		expect(result.details?.operations).toEqual(["init", "done", "drop", "explain"]);
	});

	test("existing active time is settled at the same T as its successor starts", async () => {
		const initial = timed();
		const harness = fixture(initial);
		const anchor = epoch + 6_000;
		const result = await at(
			anchor,
			() =>
				harness.run({
					input: document('START "Review"', 'EXPLAIN "Review" "Continue with review"'),
				}),
			1_000,
		);
		const expected = timed();
		Object.assign(itemOf(expected, "Implement"), { status: "pending", time: time("implement-budget", 10, 7_250) });
		Object.assign(itemOf(expected, "Review"), {
			status: "in_progress",
			explanation: "Continue with review",
			time: time("review-budget", 20, 500, anchor),
		});
		expectSaved(harness, result, expected, 0);
	});

	test("START pauses the clock, paused ESTIMATE, resume, active ESTIMATE and DONE preserve only active elapsed time", async () => {
		const initial = timed();
		const harness = fixture(initial);
		const paused: TodoMoreSnapshot = {
			goal,
			phases: [
				{
					name: "Delivery",
					items: [
						{ title: "Implement", explanation: "Consume complete commands", status: "pending", time: time("implement-budget", 10, 7_250) },
						{
							title: "Review",
							explanation: "Review original behavior",
							status: "in_progress",
							time: time("review-budget", 20, 500, epoch + 6_000),
						},
					],
				},
				initial.phases[1]!,
			],
		};
		expectSaved(harness, await harness.callAt(epoch + 6_000, 'START "Review"'), paused, 0);
		const reestimated = await harness.callAt(epoch + 20_000, 'ESTIMATE "Implement" 12');
		const changedBudget = createdTime(harness, "Implement", 12, null, 7_250);
		expect(changedBudget.budgetId).not.toBe("implement-budget");
		const changed = structuredClone(paused);
		itemOf(changed, "Implement").time = changedBudget;
		expectSaved(harness, reestimated, changed, 1);
		expect(reestimated.details?.changes).toEqual([{ op: "estimate", task: "Implement", estimatedMinutes: 12 }]);
		expect(elapsedTime(estimateOf(harness.snapshot(), "Implement"), epoch + 29_000)).toBe(7_250);

		const sameEstimate = await harness.callAt(epoch + 25_000, 'ESTIMATE "Implement" 12');
		expect(sameEstimate.isError).not.toBe(true);
		expect(harness.snapshot()).toEqual(changed);
		expect(sameEstimate.details?.more).toEqual(changed);
		expect(harness.notesEntries()).toHaveLength(3);
		expect(harness.projections).toHaveLength(3);
		expect(harness.projections.at(-1)).toStrictEqual(projected(changed));

		const resumed = structuredClone(changed);
		Object.assign(itemOf(resumed, "Implement"), { status: "in_progress", time: time(changedBudget.budgetId, 12, 7_250, epoch + 30_000) });
		Object.assign(itemOf(resumed, "Review"), { status: "pending", time: time("review-budget", 20, 24_500) });
		expectSaved(harness, await harness.callAt(epoch + 30_000, 'START "Implement"'), resumed, 3);
		expect(elapsedTime(estimateOf(harness.snapshot(), "Implement"), epoch + 35_000)).toBe(12_250);

		const activeEstimate = await harness.callAt(epoch + 32_000, 'ESTIMATE "Implement" 15');
		const activeBudget = createdTime(harness, "Implement", 15, epoch + 30_000, 7_250);
		expect(activeBudget.budgetId).not.toBe(changedBudget.budgetId);
		expect(activeBudget.budgetId).not.toBe("implement-budget");
		const active = structuredClone(resumed);
		itemOf(active, "Implement").time = activeBudget;
		expectSaved(harness, activeEstimate, active, 4);

		const final = structuredClone(active);
		Object.assign(itemOf(final, "Implement"), { status: "completed", time: time(activeBudget.budgetId, 15, 12_250) });
		Object.assign(itemOf(final, "Review"), { status: "in_progress", time: time("review-budget", 20, 24_500, epoch + 35_000) });
		expectSaved(harness, await harness.callAt(epoch + 35_000, 'DONE "Implement"'), final, 5);
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
		expect((await harness.callAt(epoch + 306_000, 'DONE "Implement"')).isError).not.toBe(true);
		expect(estimateOf(harness.snapshot(), "Implement")).toEqual(time("implement-budget", 10, 7_250));
	});

	test("repeated START, EXPLAIN, same-budget ESTIMATE and VIEW never reset a running interval", async () => {
		const harness = fixture(timed());
		const before = timed();
		const repeated = await harness.callAt(epoch + 2_000, 'START "Implement"', 'START "Implement"', 'ESTIMATE "Implement" 10');
		expect(repeated.isError).not.toBe(true);
		expect(harness.snapshot()).toEqual(before);
		expect(repeated.details?.more).toEqual(before);
		expect(harness.notesEntries()).toHaveLength(1);
		expect(harness.projections).toStrictEqual([projected(before)]);
		const explained = timed();
		itemOf(explained, "Implement").explanation = "Accepted explanation";
		expectSaved(harness, await harness.callAt(epoch + 4_000, 'EXPLAIN "Implement" "Accepted explanation"'), explained, 1);
		const notes = structuredClone(harness.notesEntries());
		const view = await harness.callAt(epoch + 8_000, "VIEW");
		expect(view.details?.more).toEqual(explained);
		expect(view.details).not.toHaveProperty("changes");
		expect(harness.notesEntries()).toEqual(notes);
		expect(harness.projections).toHaveLength(2);
		expect(estimateOf(harness.snapshot(), "Implement")).toEqual(time("implement-budget", 10, 1_250, epoch));
		expect(elapsedTime(estimateOf(harness.snapshot(), "Implement"), epoch + 8_000)).toBe(9_250);
	});

	test("ESTIMATE supplies missing imported time without inventing historical elapsed time", async () => {
		const harness = fixture(populated());
		const anchor = epoch + 40_000;
		const result = await harness.callAt(anchor, 'ESTIMATE "Implement" 5', 'ESTIMATE "Review" 6');
		const expected = populated();
		const implement = createdTime(harness, "Implement", 5, anchor);
		const review = createdTime(harness, "Review", 6, null);
		expect(implement.budgetId).not.toBe(review.budgetId);
		itemOf(expected, "Implement").time = implement;
		itemOf(expected, "Review").time = review;
		expectSaved(harness, result, expected, 0);
		expect(result.details?.changes).toEqual([
			{ op: "estimate", task: "Implement", estimatedMinutes: 5 },
			{ op: "estimate", task: "Review", estimatedMinutes: 6 },
		]);
	});

	const maximumMinutes = Math.floor(Number.MAX_SAFE_INTEGER / 60_000);
	for (const invalid of ["", "0", "-1", "1.5", String(maximumMinutes + 1)]) {
		for (const command of [
			`ESTIMATE "Implement"${invalid === "" ? "" : ` ${invalid}`}`,
			`PHASE "Delivery"\nADD "Invalid estimate" "Cannot commit"${invalid === "" ? "" : ` ${invalid}`}`,
		]) {
			test(`invalid required minute budget rejects the entire batch: ${command}`, async () => {
				const harness = fixture(timed());
				await expectRejected(harness, () =>
					harness.callAt(epoch + 6_000, 'GOAL "Changed" "Measured" "Complete"', 'DONE "Implement"', command),
				);
				expect(harness.snapshot()).toEqual(timed());
			});
		}
	}

	const limit = DEFAULT_SETTINGS.leafMaxMinutes;

	test("an estimate at the per-item limit is accepted in ADD and ESTIMATE", async () => {
		const harness = fixture(timed());
		const result = await harness.callAt(
			epoch + 1_000,
			`ESTIMATE "Review" ${limit}`,
			'PHASE "Delivery"',
			`ADD "Boundary" "Exactly at the limit" ${limit}`,
		);
		expect(result.isError).not.toBe(true);
		expect(estimateOf(harness.snapshot(), "Review").minutes).toBe(limit);
		expect(estimateOf(harness.snapshot(), "Boundary").minutes).toBe(limit);
	});

	for (const command of [`ESTIMATE "Review" ${limit + 1}`, `PHASE "Delivery"\nADD "Too long" "One minute over the limit" ${limit + 1}`]) {
		test(`an estimate one minute over the per-item limit rejects the entire batch: ${command}`, async () => {
			const harness = fixture(timed());
			const result = await expectRejected(harness, () => harness.callAt(epoch + 1_000, 'EXPLAIN "Implement" "Would change"', command));
			expect(resultText(result)).toContain(`exceeds the ${limit}-minute limit for one item`);
		});
	}

	test("the configured per-item limit replaces the default", async () => {
		const harness = fixture(timed());
		const call = (line: string) => at(epoch + 1_000, () => harness.run({ input: document('PHASE "Delivery"', line) }, undefined, 15));
		const over = await expectRejected(harness, () => call('ADD "Over" "Above the configured limit" 16'));
		expect(resultText(over)).toContain("exceeds the 15-minute limit for one item");
		const within = await call('ADD "Within" "At the configured limit" 15');
		expect(within.isError).not.toBe(true);
		expect(estimateOf(harness.snapshot(), "Within").minutes).toBe(15);
	});

	for (const minutes of [5, 20]) {
		test(`ESTIMATE cannot change a budget that received an overtime warning: ${minutes} min`, async () => {
			const harness = fixture(timed());
			harness.session.sessionManager.appendCustomMessageEntry(OVERTIME_TYPE, "overtime", true, {
				budgetId: "implement-budget",
				title: "Implement",
				estimatedMinutes: 10,
				elapsedMs: 600_000,
			});
			const rejected = await expectRejected(harness, () => harness.callAt(epoch + 700_000, `ESTIMATE "Implement" ${minutes}`));
			expect(resultText(rejected)).toContain('Task "Implement" already received an overtime warning');
			expect(resultText(rejected)).toContain('PHASE "Delivery"');

			const continued = await harness.callAt(
				epoch + 700_000,
				'ESTIMATE "Implement" 10',
				'PHASE "Delivery"',
				'ADD "Implement remainder" "Finish the work the overrun left" 15',
			);
			expect(continued.isError).not.toBe(true);
			expect(estimateOf(harness.snapshot(), "Implement").budgetId).toBe("implement-budget");
			expect(estimateOf(harness.snapshot(), "Implement remainder").minutes).toBe(15);
		});
	}

	for (const lateCommand of ['ESTIMATE "Missing task" 20', 'RM "Missing task"', 'GOAL "" "Measured" "Complete"']) {
		test(`late failure preserves all original time, goal, status, branch and projection: ${lateCommand}`, async () => {
			const harness = fixture(timed());
			await expectRejected(harness, () =>
				harness.callAt(
					epoch + 6_000,
					'GOAL "Replacement" "New measure" "New boundary"',
					'ESTIMATE "Implement" 11',
					'DONE "Implement"',
					'START "Runtime"',
					'ESTIMATE "Review" 21',
					lateCommand,
				),
			);
			expect(harness.snapshot()).toEqual(timed());
			expect(harness.notesEntries()).toHaveLength(1);
			expect(harness.projections).toHaveLength(0);
		});
	}
});
