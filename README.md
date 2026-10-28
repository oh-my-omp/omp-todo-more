# omp-todo-more

English | [简体中文](README.zh-CN.md)

A rich Todo plugin for OMP. It replaces the native `todo` while keeping
title-based addressing, phase progress, reminders, planning checks and
`task:*` subagent behavior; the list carries a goal, an explanation and a
model-estimated time budget per item.

## Install and enable

```sh
omp install https://github.com/oh-my-omp/omp-todo-more
```

The plugin entry is the package-root `index.ts`, declared by `omp.extensions`
in `package.json`. Turn off the native Todo in the OMP config before using the
plugin:

```yaml
todo:
  enabled: false
```

Do not load the old local `extensions/todo-more/` at the same time. Existing
omp-config machines retire the old modules through the gated retirement in
omp-config's updater, after the independent plugin is installed and verified
at runtime.

For local development use `omp plugin link <package-directory>`. Runtime
verification should use a source copy under `/tmp` with no development
`node_modules`; type-checking cannot prove that the OMP binary can load the
host imports.

## UI language

Todo More localizes its human-facing labels, cards, reminders, editor and
notifications. `OMOMP_LANG=en` or `OMOMP_LANG=zh` selects the language
(case-insensitive); when it is unset, the plugin reads `omomp-lang.language`
from the single `omomp.yml`, `omomp.yaml`, `omomp.json` or `omomp.toml` in the
OMP agent directory, then falls back to `LC_ALL`, `LC_MESSAGES`, `LANG` and
English. Configuration changes apply on the next process start. Command names,
configuration keys, protocol values, model-facing prompts and tool-result
content remain unchanged.

## Tool and state

The model sends one Todo document per call. OMP providers with custom-tool
support use an edit-style Lark grammar; function-tool providers send
`{input: "<the same document>"}`. Both use the same parser and executor.

Initialize the entire plan in one call:

```text
*** Begin Todo
INIT "Deliver streaming todos" "The real user path passes" "Implementation and runtime verification are complete"
PHASE "Implementation"
ADD "Implement the parser" "Accept complete documents and preserve exact titles" 20
ADD "Render the preview" "Display intent without changing saved state" 10
PHASE "Verification"
ADD "Exercise the installed tool" "Check the real tool and restored result" 15
*** End Todo
```

Batch related edits in the next call:

```text
*** Begin Todo
DONE "Implement the parser"
START "Render the preview"
EXPLAIN "Render the preview" "Check ANSI and native call previews"
ESTIMATE "Render the preview" 12
PHASE "Verification"
ADD "Inspect task history" "Confirm accepted operation order" 5
*** End Todo
```

Each uppercase command occupies one physical line. String arguments use JSON
quoting; `\"`, `\\` and `\n` preserve quotes, backslashes and multiline text
without trimming the task's complete title.

| Command | Meaning |
|---|---|
| `INIT "objective" "measure" "doneWhen"` | Replace the list and goal; first and unique. Following phase/add lines form one initialization. |
| `PHASE "name"` followed by `ADD "title" "explanation" minutes` | Append one or more explicitly estimated tasks, creating the phase if needed. Every append block requires its own phase. |
| `ESTIMATE "title" minutes` | Supply or revise the existing task's total budget without resetting elapsed work. |
| `GOAL "objective" "measure" "doneWhen"` | Replace all goal fields on a nonempty list without changing task status or clocks. |
| `START "title"` | Select the active task. |
| `EXPLAIN "title" "explanation"` | Replace the task's explanation. |
| `DONE target`, `DROP target`, `RM target` | Complete, abandon or remove the quoted title, `PHASE "name"`, or `ALL`. |
| `DONE target "message"`, `DONE target "paths" "message"` | Complete and commit: every change, or only the listed pathspecs. |
| `BLOCK target ["reason"]`, `UNBLOCK target` | Block or unblock the quoted title or `PHASE "name"`; neither accepts `ALL`. |
| `VIEW` | Read the list; it must be the document's sole command. |

Every ADD needs a model-provided positive integer estimate, with no default
or rounding. The maximum is `Math.floor(Number.MAX_SAFE_INTEGER / 60_000)`.
Missing or invalid estimates reject the complete document. PHASE scopes only
immediately following ADD lines, not status selectors; empty phase blocks are
invalid. INIT without a first PHASE uses `"Tasks"`. Titles and initialization
phase names must be unique. `"ALL"` is a title, whereas bare `ALL` is a selector.

ANSI and native call cards preview completed command lines and the unfinished
tail as uncommitted intent. A card is the call's pending view: the result view
replaces it once the execution returns, so one call paints one card and the
preview never stacks above the list it previews. Generating or canceling a
prefix never writes Todo state. The executor reads the current branch, strictly
validates the complete document, applies logical operations in order to a
working copy, and commits once. A syntax, target or rule error rejects the
entire batch.

Logical task operations retain progress normalization and `transitionTime`.
All transitions in one accepted batch share one wall-clock anchor, so a task
that is only temporarily active within the working copy accrues no artificial
command-processing time. GOAL and VIEW do not normalize or change task clocks.

An empty list carries no goal. Put GOAL first when an imported list lacks one.
RM ALL or removing the last task drops the goal in the working copy; later
additions cannot inherit it. Use INIT to create the next list.

The current session branch is the only authority. A successful changing batch
appends one complete `mouriya.omp.todo-more` snapshot and updates the host
TodoTracker projection once. Results retain `todoMore: true`, `details.more`,
native-compatible phases, storage and completion transitions.
`details.op` identifies the operation or `"batch"`; `details.operations`
lists operation names. Only successful mutations return `details.changes`,
the ordered structured operations actually applied, including ADD budgets,
ESTIMATE values and each `DONE`'s commit clause. VIEW and rejected calls do not
emit accepted changes.

The reader joins the host's `user_todo_edit` entries and old native tool
results by title: known titles keep their explanation and timing metadata;
new titles lack both. A native empty snapshot breaks inheritance of earlier
goal, explanation and timing metadata. The
plugin's own marked tool results are not read again as state records. The
existing reader ignores malformed records; this migration does not change that
compatibility behavior.

A synchronous append confirms that the current branch accepted the record, not
that it was durably written to disk. File writes, flushes and disk-failure
handling belong to the OMP SessionManager lifecycle; resuming after an exit is
how the normal persistence path is verified.

### Estimates and overtime warnings

`ESTIMATE "title" minutes` supplies or revises an item's total time budget.
Old snapshots and native-created items have `time.kind: "missing"`; the model
must explicitly estimate them rather than invent historical time. The first
estimate starts at the accepted batch's anchor if the item is already active.

| Item transition | Clock behavior |
|---|---|
| Enter `in_progress` | Start a wall-clock interval. |
| Leave `in_progress` for pending, blocked or a closed status | Accumulate the interval and pause. |
| Resume or explicitly reopen the same item | Keep accumulated time and start another interval. |
| Repeat `start`, `view`, or edit an explanation/goal | Keep the existing clock. |
| Revise the estimate | Keep accumulated time and the running interval; a changed value creates a new budget identity. An unchanged value is a no-op. |
| Delete and recreate an item | Create a new budget without inheriting the removed item's time. |

An item that remains `in_progress` continues to accrue wall time while its
session is idle or the process is stopped; this is not CPU-time accounting.
Native status changes use the corresponding session entry's timestamp.

The plugin maintains one one-shot timeout for the nearest active budget's
deadline. Todo-related journal appends and session/branch changes re-arm it;
there is no periodic polling and no end-hook deadline check. Native `/todo`,
delayed native tool results and accepted rich commits are observed at their
journal write methods, even when the host projection fails. Ordinary messages
do not trigger branch reads, and the collaboration append callback is untouched.
At the deadline the callback re-reads the current branch before requesting
injection. Large delays are split only at the platform timeout limit.

Each overdue active budget receives one system warning in the normal delivery
path. A changed estimate gets its own warning if its preserved elapsed time
exceeds the new budget. A queued message is only a delivery intent; an actual
`mouriya.omp.todo-more.overtime` custom-message entry is the notification fact.
Compaction retains those facts in the branch journal. Warnings are not copied
into item snapshots, and reloading reconstructs the timeout from the branch.

At the deadline, a running session receives an aside injection request; the
host makes it available to the model at the next safe step boundary without
cancelling the tool batch. Detection and enqueueing do not wait for the step
to end. When idle, the warning is appended to the transcript and context without
starting a model turn, so it does not undo a human stop. Shutdown cancels the
timeout and restores the observed journal methods; reopening an overdue
active item checks it again.

The warning identifies the item, estimate and elapsed time, and tells the agent
to preserve the expected outcome, acceptance criteria and quality; verify the
overrun's cause; consider changing approach; and keep advancing the full task.
It recommends discussing the cause and approach with a subagent, or the parent
when running as a subagent. The plugin does not spawn agents, change task
status or relax the goal. Estimates are forecasts, not hard deadlines; agents
must not reset the list or inflate budgets merely to hide an overrun.

### Git association of a completion

`DONE` can carry the commit its completion owes. The tool stages and commits
through the host's own git bindings
(`@oh-my-pi/pi-natives/vcs`, whole-file staging from the session's directory),
so nothing in the list reports a commit git did not make:

```text
DONE "Implement the parser" "Accept complete documents"           # every change
DONE "Render the preview" "src/render.ts" "Show streamed intent"  # one pathspec scope
```

One string is the message and commits every uncommitted change; an empty scope
string, `DONE "title" "" "message"`, means the same. Two strings are a
whitespace-separated scope and its message; pathspecs resolve against the
session's directory, exactly like its shell. Every task this `DONE` completes
records the accepted commit — sha, message and resolved scope — and summaries,
native cards, the snapshot and the ctx task log show it.

git records the message followed by one `Model: <provider>/<model-id>` trailer
per model the committing session ran since its previous todo commit — the
assistant turns on its branch after the last snapshot that brought in a new
commit, failed requests excluded, plus the session's current model — each once,
in order of first use. Only the committing session's own models are named: a
`task:*` worker in its own worktree commits its own work and names its own models. The item keeps
the message as given; `git log --format='%(trailers:key=Model,valueonly)'`
reads the models back. With no model on record the message is committed alone.

Outside a checkout, or with a clean working tree, the clause is inert: no commit
is made and its parameters are ignored, whether or not they were given. In a
checkout with uncommitted work, a `DONE` without a clause is rejected and asks
for one; it is the completion that is refused, not the check. The scope is
committed as given — the tool never verifies that it covered everything
uncommitted — and a scope that stages nothing is refused with git's own answer.
Each `DONE` in a batch commits the work still uncommitted at that point, so a
later clause in the same batch finds a clean tree and stays inert.

A `task:*` subagent whose working tree is its parent agent's commits nothing:
that worktree also holds the parent's and other sessions' uncommitted changes,
and the parent integrates and commits them. Every `DONE` form — no clause, a
message, or a scope and message — completes the task without a commit or the
uncommitted-work refusal, and the result says the parent integrates the
changes. Sharing means the parent's live session (found through the agent
registry by the subagent's `parentId`) and the subagent resolve to the same git
working-tree root; a linked worktree counts by its own root, so an isolated
subagent keeps the rules above. When the parent's registry entry or live
session is gone, or either directory is outside a checkout, the rules above
apply too.

## Subagents and reminders

Every session holds its own list. In `before_agent_start` the plugin restores
the todo tool that the host strips from `task:high/mid/low/free`;
tool-restricted sessions get it through the host tool slot. Stop reminders,
mid-run nudges, the eager prelude, goal-mode context and request-only user
reminders are kept. A human interruption is not resumed automatically.

A todo belongs to the work phase only: a request that changes files, config,
git or external state. Discussion, investigation, explanation and answering
questions are the non-work phase and get no todo. The tool description, the
empty-list reminder on each user message and the `preferred` eager prelude all
carry this split; only the `edit` guard enforces it, since `edit` is work.

When the main session stops mid-work without a text answer — a provider error,
a run that ended with tool calls outstanding, or an abort nobody asked for —
the reminder is sent after a 10-second grace window, unless a turn, a queued
message or an editor draft appeared meanwhile. An account usage-limit 429
waits until one minute past the account reset instead: the provider's retry
hint when the error carries one, otherwise omp's estimate for the limit (30
minutes for an exhausted quota, marked as estimated). While it waits, a
one-line notice above the editor shows the send time and the reason without
taking focus; a draft still in the editor at that time holds the reminder
until it is cleared. `Ctrl+N` or `/todo-more-cancel` cancels the pending
reminder; submitting a message, switching sessions or branches, and
shutting down cancel it too. The pending reminder does not survive the
process.

The planning guard reads the current branch when an edit actually executes,
not when the tool batch is pre-checked; a Todo INIT/edit or RM/edit sequence
therefore uses the accepted document's state at edit execution time.

## Read-only review protocol

The same session's `ExtensionAPI.events` offers the synchronous channel
`omp-todo-more:read`. A request is `{agentId, reply(value)}`; the owner reads
that agent's current branch and replies before `emit` returns:

```ts
type TodoMoreReadResponse =
  | {
      kind: "ok";
      goal: { objective: string; measure: string; doneWhen: string } | null;
      openItems: readonly { phase: string; title: string; explanation: string | null }[];
      counts: { pending: number; in_progress: number; completed: number; abandoned: number; blocked: number };
    }
  | { kind: "unavailable" };
```

`openItems` holds only pending/in_progress items; a missing goal or explanation
is `null`. `counts` gives the number of items in each status over the whole
list, all zero for an empty list, so a consumer can tell an empty list, one
with blocked items left and one whose items are all closed apart. No session or
a read error is `unavailable`, not an empty Todo. The
channel writes no state, offers no watch, installs nothing into Tern and
exports no internal reader. The listener is removed on the instance's
`session_shutdown`; subagents use their own bus.

A completion judge should request once before building the model prompt and
again after the model returns, before checking `openItems`; when unavailable
it keeps its warning + fail-open behavior. The ctx history consumer records
accepted logical operations from successful `details.changes`, including each
explicit goal replacement; it is not the current Todo state.

## Editing and commits

The GUI has only two edit intents, `set_goal` and `explain` by complete title;
it does not generate model tool calls. Saving re-reads the target session's current
branch and overwrites only the target field; the task's latest
phase/status/blocker/order, time budget and clock, and every other field are kept. An empty list
rejects edits, a missing goal must be set first, and a deleted or renamed task
is not brought back by an old draft.

Tool mutations and GUI saves both call `commitTodoState`. After the
synchronous append it re-reads the same branch to confirm acceptance, then
updates the host projection. Failures distinguish branch acceptance from
projection: a projection failure does not roll back the accepted record; the
tool returns an error with the latest authoritative details, and the GUI keeps
the draft and the error. Equal values append no snapshot; re-projecting can
repair an earlier partial projection failure. `view` stays a pure read.

## Native display and editing

In Tern, Todo More keeps the terminal's actual `checklist` HUD as the
visual source for the pill, ring, title, count, typography and skin treatment.
The replacement occupies the original native activity track and retains its
`omp.hud.todo` sizing and alignment. Objective, Measure, Done when, every
phase/task, all five statuses, time estimates, explanations and blockers
remain separate rich content; goal fields are not fake tasks and do not
affect progress.

A native bare-card disclosure head is the sole interactive control. Its
native toggle event and controlled `collapsed` prop drive one session-bound
disclosure state. The visual-only checklist's button stays hidden and
unfocusable; only its noninteractive ring, title and count are drawn. Its
terminal-local HUD popover is never activated. Escape, opening the editor,
an empty list, a viewed-session change or widget disposal closes the rich
disclosure and removes its input listener.

The native-sized Todo wrapper contains the disclosure and its sibling rich
popover. Hovering the popover therefore does not highlight the pill. The
popover follows the original `.sf-ck-pop` positioning: right-aligned, above
the pill with an 8px gap, a 360px width, 420px maximum height and 12px/14px padding. It also retains
the native conditional clearance for a preceding HUD row, glass, shadow and
motion. The popover itself is the only scroll area; the inner details keep
their natural height, so content exceeding the native ceiling scrolls from
the goal fields through the final task and edit button. There is no generic
portal, direction flip, below-pill tray or independent viewport/composer
height calculation.

Appearance changes, named themes and the selected program-palette variant
apply through the native renderer and inherited variables, including while
the popover is open. The plugin stores no theme copy and retains native pill
sizing and typography rather than freezing theme colors or font metrics.

`INIT` and `VIEW` tool cards display the full list; incremental CRUD tool cards
display only the items or goal changed in that call while collapsed, and
restore the full `details.more` snapshot when expanded. Stop reminder notices
render only the reminder event header without listing todo items. Historical
tool cards render their own `details.more`; neither tool cards nor reminders
become an edit source or change when the current list is edited.

In Tern's main-session composer, `/todo` and `/todo edit` open the rich
`/todo-more` editor. A focused child view keeps the host's slash-command
restrictions; its popover's Edit button opens that child's rich editor.
Other `/todo` subcommands, including `expand` and `collapse`, retain their
host behavior; Todo More's native disclosure head controls its rich popover.
Task changes are joined by title as described above. Plain ANSI OMP keeps
the host command and HUD; the replacement widget emits no ANSI rows.

`/todo-more` opens the main-session editor in OMP or Tern.
Tab/Shift+Tab or the up/down arrows select an action, the current action is
marked in the accent color, and Enter opens it. When a task is deleted, the
selection settles on the current list. The progress popover's edit button
opens this same editor rather than another editing implementation.

`Edit goal` uses three labeled host Editor drafts; Tab/Shift+Tab switches the
current field. Tern describes only the current field as a live editor at a
time; the other fields stay visible and can be clicked to activate, and
editing and undo are handled by the existing Editor/FormField. `Edit
explanation` opens a multiline Editor for the target title. Plain Enter keeps
the newline, Ctrl+Enter or Save saves, Escape/Cancel discards the draft;
closing the panel commits nothing. A save error keeps the draft and shows the
reason; a successful save re-reads the current branch. Editing itself starts
no model turn.

The progress widget follows the session being viewed, including focused task
subagents and nested subagents, and reads that session's current branch on
each native render. Session switch, branch and tree transitions reinstall
the widget. The editor is bound to the session it was opened in: changing
the viewed session, switching, branching, navigating the tree or shutting
down cancels its old draft. Save checks that owner again and appends to the
target session's own branch before updating its host projection. An empty
list has no progress card. Without an interactive UI, the edit command
reports that it is unavailable and leaves the Todo unchanged.

## Tern asset lifecycle

The package ships `tern/plugin.toml`, `todo-more.css` and `window.luau`.
OMP native components provide the pill visuals, disclosure, full checklist
and editing; the window entry satisfies the stylesheet manifest contract
and creates no domain-state store or editor. The stylesheet only changes the
`omp.session` surface. It makes the original Todo invisible but retains its
layout box and real host projection.

The current OMP native dock has thirteen source slots. A CSS grid adapter
preserves those slots and places Todo More in the existing activity track;
other below-editor widgets remain in normal order. The popover is an
absolutely positioned sibling of the disclosure inside its native-sized
Todo wrapper, not a separate layer with an anchor or allocation canvas. The
adapter also preserves original conditional HUD clearance, skin variables and Spine's widget
spacing, padding and background band. It depends on OMP's dock topology and
Tern's checklist visuals and card head/body structure: upgrades must re-check
geometry, focus, other widgets and live theme switching.
Neither host source nor binaries are patched.

The Tern stylesheet and OMP extension must be enabled together. The
stylesheet hides the native HUD while the Tern plugin is enabled, including
in an OMP session that did not load this extension. Disabling or removing
the Tern plugin restores the original HUD. Tern's supported CSS has no
`:has()` conditional, so there is no automatic native-HUD fallback when the
OMP extension is absent.

The async factory first awaits `initializeTernPlugin`, then registers the tool
and UI. The asset directory is located relative to the module; the owner is
asked through the real `tern plugin dir/list/install --json`, and the catalog
and the three-file normal copy are checked. A matching ready/disabled copy is
not reinstalled; an update uses `install --force`, then re-checks identity,
version, destination, catalog and file contents. A user's disabled setting is
kept; nothing is unlinked or enabled automatically.

This module graph has a single initialization promise that prepared child
factories reuse, while every session still registers its own tool, hooks and
read listener. When Tern is not on PATH, ANSI OMP may use the plugin, which
does not mean the GUI is accepted. When Tern is present, a CLI, parse, install,
linked-conflict or re-check failure rejects factory initialization; a machine
with native todo turned off then gets no tool from this plugin, so a warning
must not be taken as success. An on-disk install check also does not replace
verifying the CSS and edit paths in a real window.

For headless native UI verification, Tern's `serve` does not automatically
load installed plugins. Load the bundled stylesheet into that isolated test
document through its control endpoint, or use a real Tern window; verify
the actual progress card, popover and editor, not just the plugin catalog.

## Development

```sh
bun install
bun run format
bunx tsc --noEmit
bun test
```

Host peer dependencies use `*` and development dependencies use `latest`; no
bundler or build output is needed. Runtime state, credentials, development
dependencies and lock files are not part of the shipped package.
