/**
 * Parity scenarios: each drives one omp session through scripted model turns.
 * Model output is fixed by the script, so every difference between a baseline
 * and a candidate recording comes from the extension under test.
 *
 * Turn budgeting: every `turns` entry is one provider request. A run keeps
 * requesting until a text-only reply, and stop/cut-off reminders create extra
 * requests the same queue feeds, so each step enqueues exactly the requests
 * its run (plus any reminder continuation it provokes) will make. Reminder
 * continuations race subsequent steps, so a step that leaves todos open is
 * either last or is followed by a `sleep` step carrying the continuation
 * turns — the sleep drains the chain deterministically before the next prompt.
 * A `task` subagent runs on its own model and queue: its turns are marked
 * `child(…)`, and an unscripted subagent request gets the plain reply "ok".
 */
import type { ScriptedTurn } from "./mock-provider.ts";

export type Variant = "baseline" | "candidate";

/** Todo reminder settings: host `todo.*` in the baseline, todo-more plugin settings in the candidate. */
export type TodoSettings = {
	readonly reminders?: boolean;
	readonly remindersMax?: number;
	readonly eager?: "default" | "preferred" | "always";
};

export type Step =
	| { readonly kind: "prompt" | "steer" | "follow_up"; readonly text: string; readonly turns?: readonly ScriptedTurn[] }
	| { readonly kind: "rpc"; readonly command: Record<string, unknown>; readonly settle: boolean; readonly turns?: readonly ScriptedTurn[] }
	| { readonly kind: "sleep"; readonly ms: number; readonly turns?: readonly ScriptedTurn[] }
	| { readonly kind: "shell"; readonly command: string; readonly turns?: readonly ScriptedTurn[] };

export type Scenario = {
	readonly name: string;
	/** Extra config.yml keys, deep-merged over the variant's settings. */
	readonly config?: Record<string, unknown>;
	readonly todo?: TodoSettings;
	/** OMOMP_LANG; defaults to en. */
	readonly lang?: "en" | "zh";
	/** sh run in the session cwd before omp starts. */
	readonly setup?: string;
	/** `--mode rpc-ui` instead of rpc (tool UI such as `ask` reaches the responder). */
	readonly rpcUi?: boolean;
	/** `--no-ui` (extensions run with hasUI=false). */
	readonly noUi?: boolean;
	/** Reply to an extension UI request; may be async; undefined leaves it unanswered. */
	readonly ui?: (request: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown> | undefined> | undefined;
	/** Literal substrings that must appear in the normalized output (checked by normalize.ts). */
	readonly expect?: readonly string[];
	readonly steps: readonly Step[];
};

const call = (name: string, args: Record<string, unknown>): ScriptedTurn => ({ toolCalls: [{ name, arguments: args }] });
const calls = (...items: readonly { name: string; arguments: Record<string, unknown> }[]): ScriptedTurn => ({ toolCalls: items });
const bashTool = (command: string): { name: string; arguments: Record<string, unknown> } => ({
	name: "bash",
	arguments: { command, i: "run command" },
});

/** A `todo` tool call carrying one Todo document. */
export function todo(...lines: string[]): ScriptedTurn {
	return { toolCalls: [{ name: "todo", arguments: { input: ["*** Begin Todo", ...lines, "*** End Todo"].join("\n") } }] };
}

const say = (text: string): ScriptedTurn => ({ text });
/** A turn answered to the subagent (model `child`); unscripted subagent requests get the plain reply "ok". */
const child = (turn: ScriptedTurn): ScriptedTurn => ({ ...turn, child: true });
const ctxTool = (args: Record<string, unknown>): ScriptedTurn => call("ctx", { i: "inspect contexts", ...args });

const INIT1 = todo('INIT "Ship" "tests" "merged"', 'PHASE "P"', 'ADD "Task A" "work" 10');
const INIT2 = todo(
	'INIT "Ship it" "tests pass" "merged"',
	'ADD "Prep" "setup work" 5',
	'PHASE "Build"',
	'ADD "Write code" "core change" 10',
	'PHASE "Verify"',
	'ADD "Run tests" "suite green" 15',
);

export const SCENARIOS: readonly Scenario[] = [
	{
		name: "smoke-init",
		expect: ["mouriya.omp.todo-more", "session-stop-continuation"],
		steps: [
			{
				kind: "prompt",
				text: "Plan the work.",
				turns: [INIT1, say("Planned."), say("Reminder turn.")],
			},
		],
	},
	{
		name: "goal-mode-context",
		expect: ["goal-mode-context", "todo_context"],
		steps: [
			{
				kind: "prompt",
				text: "Plan the work.",
				turns: [INIT2, todo('DONE "Prep"'), say("Listed and prepped."), say("Reminder turn.")],
			},
			{ kind: "rpc", command: { type: "goal", op: "create", objective: "Ship it", token_budget: 50 }, settle: false },
			{
				kind: "prompt",
				text: "Work the goal.",
				turns: [
					call("goal", { op: "get" }),
					// After a drop the host removes the `goal` tool asynchronously; a sleep
					// in the same batch makes the next request wait for that rebuild instead
					// of racing it.
					calls({ name: "goal", arguments: { op: "drop" } }, bashTool("sleep 1")),
					call("goal", { op: "resume" }),
					call("goal", { op: "get" }),
					todo("DONE ALL"),
					say("Goal worked."),
				],
			},
			{ kind: "rpc", command: { type: "goal", op: "drop" }, settle: false },
			{ kind: "sleep", ms: 500 },
			{ kind: "prompt", text: "Wrap up.", turns: [say("Wrapped.")] },
		],
	},
	{
		name: "subagent-tools",
		steps: [
			{
				kind: "prompt",
				text: "Delegate.",
				turns: [
					{
						toolCalls: [
							{
								name: "task",
								arguments: { context: "Probe.", tasks: [{ agent: "task", name: "Probe", task: "Say ok.", solutionSpace: "one answer" }] },
							},
						],
					},
					say("Delegated."),
				],
			},
		],
	},

	// ---------- todo grammar, parse and document rules ----------
	{
		name: "todo-parse-errors",
		expect: [
			"Expected complete",
			"needs at least one command",
			"VIEW must be the only",
			"INIT must be the first",
			"Invalid FROB command",
			"supported positive integer",
		],
		steps: [
			{
				kind: "prompt",
				text: "Reject malformed Todo documents.",
				turns: [
					call("todo", { input: 5 }),
					call("todo", { input: "*** Begin Todo\nVIEW" }),
					call("todo", { input: "*** End Todo\nVIEW\n*** Begin Todo" }),
					call("todo", { input: "*** Begin Todo\n*** End Todo" }),
					call("todo", { input: '*** Begin Todo\nVIEW\nSTART "x"\n*** End Todo' }),
					call("todo", { input: "*** Begin Todo\nVIEW\n*** End Todo\ntrailing" }),
					todo('START "x"', 'INIT "o" "m" "d"'),
					call("todo", { input: '*** Begin Todo\nstart "x"\n*** End Todo' }),
					call("todo", { input: '*** Begin Todo\nSTART "x"1\n*** End Todo' }),
					call("todo", { input: '*** Begin Todo\nSTART "x" \n*** End Todo' }),
					call("todo", { input: '*** Begin Todo\n"hello"\n*** End Todo' }),
					call("todo", { input: "*** Begin Todo\nFROB\n*** End Todo" }),
					call("todo", { input: "*** Begin Todo\nPHASE\n*** End Todo" }),
					call("todo", { input: '*** Begin Todo\nDONE "t" ""\n*** End Todo' }),
					call("todo", { input: '*** Begin Todo\nDONE "t" "s" "m" "x"\n*** End Todo' }),
					call("todo", { input: "*** Begin Todo\nUNBLOCK ALL\n*** End Todo" }),
					call("todo", { input: "*** Begin Todo\nBLOCK ALL\n*** End Todo" }),
					call("todo", { input: '*** Begin Todo\nADD "t" "x" 150323855350\n*** End Todo' }),
					call("todo", { input: '*** Begin Todo\nADD "t" "x" 0\n*** End Todo' }),
					call("todo", { input: "*** Begin Todo\nSTART ?\n*** End Todo" }),
					say("All rejected."),
				],
			},
			{
				kind: "prompt",
				text: "Confirm nothing was saved.",
				turns: [todo("VIEW"), say("Still empty.")],
			},
		],
	},
	{
		name: "todo-parse-errors-zh",
		lang: "zh",
		expect: ["Invalid FROB command or arguments", "Expected complete", "没有待发的待办提醒"],
		steps: [
			{
				kind: "prompt",
				text: "Reject malformed documents.",
				turns: [
					call("todo", { input: "*** Begin Todo\nFROB\n*** End Todo" }),
					call("todo", { input: "*** Begin Todo\nVIEW" }),
					say("Rejected."),
				],
			},
			{ kind: "prompt", text: "/todo-more-cancel", turns: [] },
		],
	},
	{
		name: "todo-json-escapes",
		expect: ["lineA"],
		steps: [
			{
				kind: "prompt",
				text: "Exercise JSON quoting.",
				turns: [
					todo('INIT "o" "m" "d"', 'PHASE "P"', 'ADD "tab\\tbreak\\nline\\u0041" "esc \\\\/\\b\\f\\r \\"q\\"" 5'),
					say("All accepted."),
				],
			},
			{ kind: "prompt", text: "Finish.", turns: [todo("DONE ALL"), say("Done.")] },
		],
	},
	{
		name: "todo-all-ops",
		expect: ['"batch"', '"view"', "auto-advances", "a b", "Todo list cleared."],
		steps: [
			{
				kind: "prompt",
				text: "Exercise every Todo command.",
				turns: [INIT2, todo("VIEW"), say("Initialized."), say("Reminder turn.")],
			},
			{
				kind: "prompt",
				text: "Mutate the list.",
				turns: [
					todo('GOAL "Better goal" "better measure" "better done"'),
					todo('EXPLAIN "Prep" "refined explanation"'),
					todo('ESTIMATE "Write code" 20', 'ESTIMATE "Write code" 20', 'ESTIMATE "Prep" 7'),
					todo('START "Run tests"'),
					todo('DONE "Run tests"'),
					todo('START "Write code"', 'DROP "Prep"'),
					todo('PHASE "P2"', 'ADD "Late" "added later" 3'),
					todo('BLOCK "Write code" "dep  a  b"'),
					todo('UNBLOCK PHASE "Build"'),
					todo("VIEW"),
					say("Mutated."),
				],
			},
			{
				kind: "prompt",
				text: "Exercise removals.",
				turns: [todo('RM "Write code"'), todo('DONE "Late"'), todo('RM PHASE "P2"'), todo("RM ALL"), todo("VIEW"), say("Removed.")],
			},
		],
	},
	{
		name: "todo-rule-errors",
		expect: ["Duplicate phase", "already exists", "needs at least one ADD", "GOAL requires a non-empty list", "task-9"],
		steps: [
			{
				kind: "prompt",
				text: "Exercise rule errors.",
				turns: [
					todo('GOAL "o" "m" "d"'),
					todo('START "x"'),
					INIT2,
					todo('GOAL " " "m" "d"'),
					todo('INIT "o" "m" "d"', 'PHASE "P"', 'ADD "a" "e" 1', 'PHASE "P"', 'ADD "b" "e" 1'),
					todo('INIT "o" "m" "d"', 'PHASE "P"', 'ADD "a" "e" 1', 'PHASE "Q"', 'ADD "a" "e" 1'),
					todo('INIT "o" "m" "d"', 'PHASE "P"'),
					todo('INIT "o" "m" "d"'),
					todo('ADD "x" "y" 5'),
					todo('PHASE "Late"', 'ADD "a" "e" 1', 'PHASE "Later"', 'ADD "Prep" "dup" 1'),
					todo('PHASE "Later"', 'ADD "b" "e" 1', 'PHASE "Latest"'),
					todo('EXPLAIN "Write code" ""'),
					todo('EXPLAIN "" "x"'),
					todo('EXPLAIN "nosuch" "x"'),
					todo('ESTIMATE "Prep" 5'),
					todo('START "task-9"'),
					todo('START "nosuch"'),
					todo('DONE PHASE "nope"'),
					todo('DONE ""'),
					todo('INIT "x" "y" "z"', 'PHASE "P"', 'ADD "g" "e" 1', 'START "ghost"'),
					say("Errors recorded."),
				],
			},
			{
				kind: "prompt",
				text: "Verify atomicity survived.",
				turns: [todo("VIEW"), say("Verified.")],
			},
			{ kind: "prompt", text: "Finish.", turns: [todo("DONE ALL"), say("Finished.")] },
		],
	},
	{
		name: "done-commit",
		expect: ["Model: parity/script", "Committed", "staged nothing", "uncommitted work", "committed nothing"],
		setup: "git init -q && printf 'one\\n' > a.txt && git add . && git commit -qm seed",
		steps: [
			{
				kind: "prompt",
				text: "Init and finish tasks in a repo.",
				turns: [
					todo(
						'INIT "Ship" "tests pass" "merged"',
						'PHASE "P"',
						'ADD "t1" "first" 1',
						'ADD "t2" "second" 1',
						'ADD "t3" "third" 1',
						'ADD "t4" "fourth" 1',
						'ADD "t5" "fifth" 1',
					),
					say("Planned."),
					say("Reminder turn."),
				],
			},
			{ kind: "shell", command: "printf 'x\\n' > a.txt && printf 'y\\n' > b.txt" },
			{
				kind: "prompt",
				text: "Try to finish t1 without a commit clause.",
				turns: [todo('DONE "t1"'), say("Refused."), say("Reminder turn.")],
			},
			{
				kind: "prompt",
				text: "Finish t1 committing only a.txt.",
				turns: [todo('DONE "t1" "a.txt" "feat: finish t1"'), say("Committed."), say("Reminder turn.")],
			},
			{
				kind: "prompt",
				text: "Finish t2 and t3.",
				turns: [todo('DONE "t2" "a.txt b.txt" "feat: finish t2"'), todo('DONE "t3" "feat: finish t3"'), say("Committed both.")],
			},
			{ kind: "shell", command: "printf 'z\\n' > c.txt" },
			{
				kind: "prompt",
				text: "Finish t4 with an unmatched scope, then the rest.",
				turns: [
					todo('DONE "t4" "zzz.txt" "feat: finish t4"'),
					todo('DONE "t5" "feat: finish t5"', 'START "ghost"'),
					todo("DONE ALL"),
					say("Wrapped."),
				],
			},
		],
	},
	{
		name: "done-commit-hook-fail",
		expect: ["git commit failed", "hook rejects"],
		setup:
			"git init -q && printf 'one\\n' > a.txt && git add . && git commit -qm seed && printf '#!/bin/sh\\necho hook rejects >&2\\nexit 1\\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit",
		steps: [
			{
				kind: "prompt",
				text: "Init in a repo whose hook fails.",
				turns: [INIT1, say("Planned."), say("Reminder turn.")],
			},
			{ kind: "shell", command: "printf 'x\\n' > a.txt" },
			{
				kind: "prompt",
				text: "Try to finish t1.",
				turns: [todo('DONE "Task A" "feat: t1"'), say("Refused by hook."), say("Reminder turn.")],
			},
			{ kind: "shell", command: "rm .git/hooks/pre-commit" },
			{
				kind: "prompt",
				text: "Finish t1 for real.",
				turns: [todo('DONE "Task A" "feat: t1"'), say("Committed.")],
			},
		],
	},
	{
		name: "done-no-repo",
		expect: ["No git repository here", "committed nothing"],
		steps: [
			{
				kind: "prompt",
				text: "Init and finish outside a repo.",
				turns: [INIT1, todo('DONE "Task A"'), say("Finished.")],
			},
			{
				kind: "prompt",
				text: "Add and finish with a clause outside a repo.",
				turns: [todo('PHASE "Q"', 'ADD "t2" "second" 1'), todo('DONE "t2" "feat: t2"'), say("Done.")],
			},
		],
	},

	// ---------- native writes, join, goal rules ----------
	{
		name: "native-writes",
		expect: ["user_todo_edit", "has no goal", "no time estimate", "no explanation yet", "The list has no goal"],
		steps: [
			{
				kind: "rpc",
				command: { type: "set_todos", phases: [{ name: "Ghost", tasks: [{ content: "Ghost task", status: "in_progress" }] }] },
				settle: false,
			},
			{ kind: "prompt", text: "/todo", turns: [] },
			{ kind: "prompt", text: "/todo append Build Task Alpha", turns: [] },
			{ kind: "prompt", text: "/todo append Build Task Beta", turns: [] },
			{ kind: "prompt", text: "/todo done Alpha", turns: [] },
			{
				kind: "prompt",
				text: "Try a mutation on the native list.",
				turns: [todo('START "Task Beta"'), todo('GOAL "Ship" "tests" "merged"'), say("Goal set."), say("Reminder turn.")],
			},
			{
				kind: "prompt",
				text: "Inspect and finish.",
				turns: [todo("VIEW"), todo('PHASE "Extra"', 'ADD "Gamma" "g work" 4'), todo("VIEW"), todo("DONE ALL"), say("Finished.")],
			},
		],
	},

	// ---------- reminders ----------
	{
		name: "stop-reminder",
		expect: ["session-stop-continuation", "1 incomplete todo - reminder 1/3", "(Reminder 1/3)"],
		steps: [
			{
				kind: "prompt",
				text: "Plan the work.",
				turns: [INIT1, say("Planned."), todo('DONE "Task A"'), say("Completed.")],
			},
		],
	},
	{
		name: "stop-reminder-max",
		todo: { remindersMax: 1 },
		expect: ["reminder 1/1", "session-stop-continuation"],
		steps: [
			{
				kind: "prompt",
				text: "Plan the work.",
				turns: [INIT1, say("Planned."), todo("VIEW"), say("Reminder turn.")],
			},
		],
	},
	{
		name: "stop-reminder-off",
		todo: { reminders: false },
		expect: ["Task A"],
		steps: [{ kind: "prompt", text: "Plan the work.", turns: [INIT1, say("Planned.")] }],
	},
	{
		name: "stop-reminder-question",
		expect: ["Should I continue?"],
		steps: [{ kind: "prompt", text: "Plan the work.", turns: [INIT1, say("Should I continue?")] }],
	},
	{
		name: "mid-run-nudge",
		expect: ["mid-run-nudge", "todo item still open"],
		// The nudge aside fires at turn_end; the request that would race it is the
		// next model turn, so a sleep isolates each nudge boundary before the next
		// batch starts. One bash call per turn: parallel calls finish in scheduler
		// order and, sharing one shell, some fall back to a temporary shell.
		steps: [
			{
				kind: "prompt",
				text: "Plan, then mutate a lot.",
				turns: [INIT1, say("Planned."), say("Reminder turn.")],
			},
			{
				kind: "prompt",
				text: "Run many mutations.",
				turns: [...Array.from({ length: 12 }, () => calls(bashTool("true"))), say("Mutations done.")],
			},
			{ kind: "sleep", ms: 1500 },
			{
				kind: "prompt",
				text: "Mutate some more.",
				turns: [...Array.from({ length: 12 }, () => calls(bashTool("true"))), say("Reminder turn.")],
			},
		],
	},
	{
		name: "eager-preferred",
		todo: { eager: "preferred" },
		expect: ["eager-prelude", "todo` first"],
		steps: [
			{
				kind: "prompt",
				text: "Plan the work.",
				turns: [INIT1, say("Planned."), say("Reminder turn.")],
			},
			{ kind: "prompt", text: "Second request.", turns: [say("Done work."), todo("DONE ALL"), say("Done for real.")] },
		],
	},
	{
		name: "eager-skip",
		todo: { eager: "preferred" },
		expect: ["Is this a question?"],
		steps: [{ kind: "prompt", text: "Is this a question?", turns: [say("It was.")] }],
	},
	{
		name: "eager-always",
		todo: { eager: "always" },
		expect: ["eager-prelude", '"toolChoice"', "MUST call"],
		steps: [
			{
				kind: "prompt",
				text: "Plan the work.",
				turns: [INIT1, say("Planned."), say("Reminder turn.")],
			},
			{ kind: "prompt", text: "Second request.", turns: [say("Worked."), todo("DONE ALL"), say("Done for real.")] },
		],
	},

	// ---------- planning ----------
	{
		name: "planning-edit-guard",
		expect: ["edit is blocked until the complete document succeeds", "Check that this todo matches your current plan"],
		setup: "printf 'hello\\n' > f.txt",
		steps: [
			{
				kind: "prompt",
				text: "Edit the file.",
				turns: [call("edit", { input: "[f.txt#DEAD]\nPUT 1.:\n+world", i: "edit file" }), say("Blocked.")],
			},
			{
				kind: "prompt",
				text: "Now plan then edit.",
				turns: [INIT1, call("edit", { input: "[f.txt#BEEF]\nPUT 1.:\n+world", i: "edit file" }), say("Edited."), say("Reminder turn.")],
			},
			{ kind: "prompt", text: "Wrap.", turns: [todo("DONE ALL"), say("Wrapped.")] },
		],
	},

	// ---------- timers ----------
	{
		name: "overtime",
		expect: ["todo-more.overtime", "has exceeded its estimated time", "elapsed"],
		steps: [
			{
				kind: "prompt",
				text: "Plan with a tight estimate.",
				turns: [
					todo('INIT "Ship" "tests" "merged"', 'PHASE "P"', 'ADD "Long task" "slow work" 1', 'START "Long task"'),
					say("Working."),
					say("Reminder turn."),
				],
			},
			{ kind: "sleep", ms: 63_000 },
			{ kind: "prompt", text: "Check in.", turns: [say("Still working."), say("Reminder turn.")] },
		],
	},
	{
		name: "cutoff-grace",
		config: { retry: { enabled: false } },
		expect: ["todo-more.reminder", "Reminder 1/3"],
		steps: [
			{
				kind: "prompt",
				text: "Plan the work.",
				turns: [INIT1, say("Planned."), say("Reminder turn.")],
			},
			{
				kind: "prompt",
				text: "Hit a provider error.",
				// A 400 is not retried by pi-ai, so the turn stops on the error at once.
				turns: [{ error: { status: 400, body: '{"error":{"message":"provider exploded","type":"invalid_request_error"}}' } }],
			},
			{ kind: "sleep", ms: 15_000, turns: [say("After nudge.")] },
			{ kind: "prompt", text: "Wrap.", turns: [todo("DONE ALL"), say("Wrapped.")] },
		],
	},
	{
		name: "quota-wait",
		config: { retry: { enabled: false } },
		// pi-ai transparently retries a 429 whose hint fits its retry budget, so the
		// usage-limit classification (cutOffWait quota path) never settles in RPC
		// streaming runs; the scenario still exercises the provider-error stop and
		// the stop reminder over it.
		expect: ["Reminder 1/3"],
		steps: [
			{
				kind: "prompt",
				text: "Plan the work.",
				turns: [INIT1, say("Planned."), say("Reminder turn.")],
			},
			{
				kind: "prompt",
				text: "Hit a quota error.",
				turns: [
					{
						error: {
							status: 429,
							// The hint must exceed pi-ai's 30 s retry budget so the 429
							// propagates as an error instead of being retried transparently.
							body: '{"error":{"message":"You have exhausted your capacity for this model; Please retry in 45s","type":"rate_limit_error"}}',
						},
					},
				],
			},
			{ kind: "sleep", ms: 120_000, turns: [say("After quota nudge.")] },
			{ kind: "prompt", text: "Wrap.", turns: [todo("DONE ALL"), say("Wrapped.")] },
		],
	},
	{
		name: "ask-wait",
		rpcUi: true,
		expect: ["extension_ui_request", '"select"', "estimated"],
		ui: async (request) => {
			if (request.method === "select") {
				await Bun.sleep(25_000);
				return { value: "alpha" };
			}
			return undefined;
		},
		steps: [
			{
				kind: "prompt",
				text: "Plan, ask, finish.",
				turns: [
					todo('INIT "Ship" "tests" "merged"', 'PHASE "P"', 'ADD "Task A" "work" 30', 'START "Task A"'),
					call("ask", { questions: [{ id: "q1", question: "Pick one", options: [{ label: "alpha" }, { label: "beta" }] }] }),
					todo('DONE "Task A"'),
					say("Finished."),
				],
			},
		],
	},

	// ---------- subagents ----------
	{
		name: "subagent-shared-worktree",
		expect: ["the parent agent integrates and commits these changes"],
		setup: "git init -q && printf 'one\\n' > a.txt && git add . && git commit -qm seed",
		steps: [
			{
				kind: "prompt",
				text: "Delegate finishing work.",
				turns: [
					call("task", {
						context: "Git repo here.",
						tasks: [{ agent: "task", name: "Closer", task: "Do the work.", solutionSpace: "one answer" }],
					}),
					say("Delegated."),
					say("Parent done."),
					child(
						todo(
							'INIT "Sub job" "done" "verified"',
							'PHASE "P"',
							'ADD "Task A" "work" 5',
							'ADD "Task B" "more work" 5',
							'DONE "Task A" "feat: sub done"',
						),
					),
					child(say("Sub part one done.")),
					child(say("Sub finished.")),
				],
			},
		],
	},
	{
		name: "subagent-reminder",
		expect: ["Reminder 1/3"],
		steps: [
			{
				kind: "prompt",
				text: "Delegate incomplete work.",
				turns: [
					call("task", {
						context: "Leave a todo open.",
						tasks: [{ agent: "task", name: "Leaver", task: "Start a list.", solutionSpace: "one answer" }],
					}),
					say("Delegated."),
					say("Parent done."),
					child(todo('INIT "Sub job" "done" "verified"', 'PHASE "P"', 'ADD "Task A" "work" 5')),
					child(say("Sub stopped early.")),
					child(say("Sub continued.")),
				],
			},
		],
	},

	// ---------- session navigation, compaction ----------
	{
		name: "compact",
		todo: { eager: "preferred" },
		// The mock reports 2 tokens per turn; without a tiny keep window the host
		// finds nothing to summarize.
		config: { compaction: { keepRecentTokens: 1 } },
		expect: ["todo-more.post-compact-ctx", "compaction"],
		steps: [
			{
				kind: "prompt",
				text: "Plan the work.",
				turns: [INIT1, say("Planned."), say("Reminder turn.")],
			},
			{ kind: "prompt", text: "Clear the list.", turns: [todo("DONE ALL"), say("Cleared.")] },
			{ kind: "rpc", command: { type: "compact", customInstructions: "Summarize" }, settle: false },
			{
				kind: "prompt",
				text: "Post compact work.",
				turns: [todo('INIT "Second" "tests" "merged"', 'PHASE "P"', 'ADD "Task B" "work" 10'), todo("DONE ALL"), say("Post compact.")],
			},
		],
	},
	{
		name: "branch-nav",
		expect: ["Todo list is empty."],
		steps: [
			{
				kind: "prompt",
				text: "Init and finish.",
				turns: [INIT1, todo("DONE ALL"), say("Finished.")],
			},
			{ kind: "rpc", command: { type: "branch", entryId: "$entry:Init and finish." }, settle: false },
			{
				kind: "prompt",
				text: "Check state on the branch.",
				turns: [todo("VIEW"), say("Empty on this branch.")],
			},
			{ kind: "rpc", command: { type: "fork" }, settle: false },
			{ kind: "prompt", text: "Check state on the fork.", turns: [say("Forked.")] },
			{ kind: "rpc", command: { type: "new_session" }, settle: false },
			{ kind: "prompt", text: "Fresh session check.", turns: [say("Fresh.")] },
		],
	},

	// ---------- ctx tool, slash commands, i18n ----------
	{
		name: "ctx-tool",
		expect: ["# Contexts", "# Context", "todo init:", "todo-more set:", "Unknown context", "requires an id"],
		steps: [
			{
				kind: "prompt",
				text: "Plan, delegate, inspect contexts.",
				turns: [
					INIT1,
					call("task", {
						context: "Probe.",
						tasks: [{ agent: "task", name: "Sidekick", task: "Say ok.", solutionSpace: "one answer" }],
					}),
					say("Child done."),
					ctxTool({ op: "list" }),
					ctxTool({ op: "list", all: true }),
					ctxTool({ op: "list", id: "Sidekick" }),
					ctxTool({ op: "show", id: "Sidekick" }),
					ctxTool({ op: "show", id: "Main" }),
					ctxTool({ op: "show" }),
					ctxTool({ op: "show", id: "nope" }),
					ctxTool({ op: "bogus" }),
					say("Inspected."),
					say("Reminder turn."),
				],
			},
			{ kind: "prompt", text: "Finish.", turns: [todo("DONE ALL"), ctxTool({ op: "show", id: "Main" }), say("Done.")] },
		],
	},
	{
		name: "slash-ui",
		expect: ["Todo More editor requires an interactive UI"],
		noUi: true,
		// The model prompt runs first: a slash prompt that spawns a custom message
		// (ui-unavailable) parks the input gate and the next model prompt never
		// admits, so slash prompts go last.
		steps: [
			{ kind: "prompt", text: "Plan.", turns: [INIT1, say("Done."), say("Reminder turn.")] },
			{ kind: "prompt", text: "/todo-more-cancel", turns: [] },
			{ kind: "prompt", text: "/todo-more", turns: [] },
		],
	},
	{
		name: "zh",
		lang: "zh",
		expect: ["个待办未完成 - 提醒", "没有待发的待办提醒", "session-stop-continuation"],
		steps: [
			{
				kind: "prompt",
				text: "计划工作。",
				turns: [INIT1, say("Planned."), say("Reminder turn.")],
			},
			{ kind: "prompt", text: "/todo-more-cancel", turns: [] },
			{ kind: "prompt", text: "完成。", turns: [todo("DONE ALL"), say("Finished.")] },
		],
	},
];
