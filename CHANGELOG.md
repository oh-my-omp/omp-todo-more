# Changelog

## [Unreleased]

## [0.4.2] - 2026-11-28

### Changed

- `todo` treats an empty value in an optional field as omitting the field: a blank `view`, `start_id` or `done_id`, an empty `add`, `explain`, `estimate` or `drop_ids` array, and an empty `goal` or `commit` object no longer fail validation, and a call whose fields are all empty shows the whole list like `todo({})`. A blank `add[].phase` goes to `"Tasks"` like an omitted phase. An array holding an empty element (for example a blank string inside `commit.paths` or `drop_ids`) is refused with the element index and changes nothing, and a blank required text (`goal.title`, `add[].title` and the like) is still rejected.
- When the todo list is empty at compaction, `omp-todo-ng` emits an empty-state `harness-provided` exclusion claim so summaries do not copy planning reminder rules or invent todo items, and syncs `omomp-shared/compact-handoff.ts` to `COMPACT_HANDOFF_REVISION = 3` ([#126](https://github.com/oh-my-omp/omp-todo-ng/issues/126)).

### Fixed

- Appended idle overtime warnings without rebuilding the chat or starting a new turn ([#130](https://github.com/oh-my-omp/omp-todo-ng/issues/130))

## [0.4.1] - 2026-11-26

### Fixed

- Todo NG loads on omp 19.2: it no longer fails with `Failed to load extension … Cannot find package '@oh-my-pi/pi-tui'`, so the `todo` the model sees is this plugin's again instead of the host built-in.

### Changed

- The `todo` card body, the reminder card, the `todo-ng.hud` widget and the `/todo-ng` panel are drawn as pi-tui 19.2 nodes; the card head is the host's `Todo closed/total`. The panel edits the goal and explanations through a host form (`formDialog`, or one `editor` dialog per field) and reopens on the saved list.

### Removed

- The rewrite of interactive `/todo` and `/todo edit` input to `/todo-ng`, and the HUD and panel following a viewed subagent's session: omp 19.2 exposes neither the composer's viewed session nor native-rendering state to extensions. The HUD and the panel show the session the extension runs in; open the editor with `/todo-ng`.

## [0.4.0] - 2026-11-24

### Added

- `todo` reads a project config file `.omp/todo-ng.json` at the git root (or the session directory outside git) on every call: `effects` switches and `tailItems` tail-item rules, strictly parsed with defaults for omitted fields. An unreadable, malformed or invalid file refuses every `todo` change with the file path and the reason; `todo({})` and `todo({ view })` still answer and append the same reason.
- A call that starts a list or a new round appends the project's `tailItems` that reach the agent (`main`, `isolated`, `all`) after its own items, each estimated at its `minutes` or the smaller of 15 and `leafMaxMinutes`, and records the rule in the notes; an `add` repeating a tail title is refused. A protected tail item cannot be dropped, and a tail item whose rule has a `check` cannot be completed while other work is open; once its rule leaves the config it completes with a note. Views mark tail items `project rule "<id>"`.
- `effects.commit: false` lets `done_id` complete without committing or the uncommitted-work refusal, ignoring a `commit` clause with a note; `effects.overtime: false` lets `estimate` change an item that already received an overtime warning.
- `effects.editGate: false` lets `edit` run on an empty or finished list and stops putting `todo` back into editing subagents; `effects.overtime: false` stops the overtime deadline timer and its warnings; `effects.cutOff: false` stops the deferred cut-off nudge and the quota-429 wait. An invalid project config blocks every `edit` with the file path and the reason, and keeps overtime warnings and the cut-off nudge off, each logged as a warning.
- Completing a tail item whose rule has a `check` runs it before the completion commit and keeps the item open unless it passes: a `shell` check runs through omp's native shell in the session directory and passes only on exit 0 (non-zero exit, timeout and cancel refuse with the output tail); a `judge` check asks the `@omp-todo-ng` model role, then `default`, and passes only when its answer holds a JSON `{"verdict":"pass"}` object, refusing on no model, an unparsable answer, model failures, the deadline or a cancel.

### Changed

- Every `todo` change runs through one pipeline — structural planning, the tail-item transform, synchronous guards, acceptance guards, then the completion-commit guard — and the first refusal or exception rejects the whole call before the list, the notes or git change. The edit-gate preview runs the same planning, transform and synchronous guards.

## [0.3.1] - 2026-11-24

### Changed

- Updated the shared copy of `todo-read.ts` to oh-my-omp/shared@e84938e.

### Fixed

- In Tern, a long working status on the activity line no longer runs under the Todo NG pill: while the pill is shown the status ends with an ellipsis before it, which on a phone with background agents used to print the status and the pill over each other.

## [0.3.0] - 2026-11-23

### Breaking Changes

- The plugin is renamed from `omp-todo-more` to `omp-todo-ng`: install it as `omp-todo-ng` from https://github.com/oh-my-omp/omp-todo-ng, configure it with `omp plugin config omp-todo-ng`, open the editor with `/todo-ng` and cancel a pending reminder with `/todo-ng-cancel`; the Tern plugin id is `omp-todo-ng`, its stylesheet is `todo-ng.css`, the `<system-reminder>` sources are `omp-todo-ng/planning` and `omp-todo-ng/overtime`. Session data written by earlier versions still loads.
- `todo` takes `done_id` (one task ID) instead of `done_ids`: one completion owes at most one commit, and a commit cannot be split across several completions. Close several items with several calls.

### Added

- `todo` commits the work a completion owes again: `{ done_id, commit: { message } }` commits the changes the host's change record attributes to this agent and its subagents, and `commit.paths` commits every change in those git pathspecs resolved from the session directory, both through the host's selective commit on a private index, with one `Model: <provider>/<id>` trailer per model used since the previous todo commit. The commit runs only after the rest of the call validated; a failed commit rejects the call and leaves the item open. `commit` without `done_id`, or on an item that is already completed, is rejected.
- A `done_id` without `commit` is rejected again while this agent has uncommitted work (or the checkout is dirty in a session without a change record); a subagent working in its parent agent's git worktree completes without committing or that refusal, and the parent commits.

### Changed

- Updated the shared copy of `compact-handoff.ts` to oh-my-omp/shared@db9dde4.
- Each item's progress is recorded in a shape fixed by its status (pending: first start and pause time; in progress: first start and running clock; completed or abandoned: first start and close time). The clock now runs for items without an estimate too, so an estimate added later counts the time already spent. The notes entry stores item IDs, estimates and progress; notes written by earlier versions still load.
- Items are identified by ID everywhere after the host list is joined with the notes: the `/todo-ng` editor edits explanations by ID, and planning highlights and card deltas follow IDs.
- The planning reminder records each delivery as a `mouriya.omp.todo-more.planning` session entry and decides what the model last saw from the branch fold, instead of scanning its own reminder text and rebuilding the session context on every tool result.
- The `/todo-ng` panel and the HUD read the live host list, as the `todo` tool does.
- The `todo` description and parameter hints name the `leafMaxMinutes` setting instead of a fixed 60 minutes.

### Removed

- Todo result cards no longer read results written by earlier versions; those show as invalid result details.

### Fixed

- A todo list written by calling `todo` from eval (`await tool.todo(…)`) now shows in the `/todo-ng` panel, the Tern HUD pill and the reminders, and survives resume: omp records such a call as a `user_todo_edit` entry instead of a `todo` result, and the plugin now reads that entry as the host list; before, the panel showed "Todo list is empty." while omp's own Todo HUD listed the items.
- A todo list whose items are all completed or abandoned no longer lets `edit` through: the `edit` gate blocks it with a reminder that the round is over, the planning reminder says the same instead of asking to check the finished list, and the next `todo` call with `add` starts a new round from its own `goal` without the finished goal and items; `add` without `goal` on such a list is rejected. Before, the finished list stayed open to edits and `add` reopened it under the old goal.
- Rewriting the host's todo reminders in the context hook folds the branch once per model call instead of once per reminder: on a 32000-entry branch with 704 stop reminders the first call after a resume or branch switch drops from about 515 ms to about 3 ms, and later calls from about 41 ms to about 3 ms. The rewritten text is unchanged.

## [0.2.5] - 2026-11-23

### Changed

- Added `omomp-shared/compact-handoff.ts` from `oh-my-omp/shared@8f2c5e520126` and registered `omp-todo-more` as a `StatefulHarnessHandoff` (`delivery: "plugin-managed"`, `source="omp-todo-more/planning"`) so compaction prompts preserve active todo ownership without summarizing todo items, time budgets, or todo rules while staying silent when the list is empty.
- Guarded `overtime` deadline rescheduling and `reminders` cut-off timer delivery with the shared compaction barrier (`isCompacting` / `deferDuringCompaction`) so neither calls `pi.sendMessage` while compaction is in flight.

## [0.2.4] - 2026-11-22

### Changed

- Migrated `todo` tool documentation topic pointers and topic cross-references from `xd://todo/*` to `help://todo/*` for omp 19.1.0 compatibility
- Updated the shared copies of `context-delta.ts`, `tern-plugin.ts` to oh-my-omp/shared@3d09cd4.
- The empty-list `edit` gate now blocks the call from the host's `tool_call` event instead of replacing the host `edit` tool's `execute`, so the plugin no longer touches the host tool object or re-installs it after tool-registry refreshes. An `edit` that follows a `todo` in the same assistant message runs only when that `todo` document passes `todo`'s own parse and rule checks and leaves a non-empty list; otherwise it is blocked with the init reminder.
- `DONE` now commits through the host's selective commit on a private index instead of staging the shared index. `DONE "title" "<message>"` commits only the changes the host's change record attributes to this agent and its subagents; `DONE "title" "<paths>" "<message>"` commits every change in the named git pathspecs, resolved by git from the session directory as `git add -- <pathspec>` would. Neither takes another writer's staged or unstaged changes outside the commit. A `DONE` without a clause is rejected only when this agent has uncommitted work (another writer's changes no longer trigger it). When HEAD moves while the commit is built, the commit lands on the new HEAD if the selection still applies; otherwise `DONE` fails naming the move and the paths and the task stays open. In a session that keeps no change record, the message-only form fails and asks for paths, and a clause-less `DONE` in a dirty checkout is rejected with the path form alone.
- Updated the shared copy of `todo-read.ts` to oh-my-omp/shared@dcbf622.
- Subagents get `todo` back with the enabled tools in the shared canonical order (builtins in registry order, the rest by Unicode code point), the same order other omomp plugins write; the repository declares `omomp-shared/active-tools.ts`, so the check compares it with oh-my-omp/shared.
- Todo card rendering, collapsed-row selection, phase numbering, text sanitizing and the session-exit/tool-start entry types now come from the host's exports instead of in-repo copies; the card looks the same.
- Todo items now have four statuses: `pending`, `in_progress`, `completed`, `abandoned`. Items saved as `blocked` by earlier versions load as `pending` without their blocker text; earlier todo results that contain `BLOCK`/`UNBLOCK` changes still load, without those changes.
- A todo list's phases, titles, order and statuses are now recorded only in omp's own list. The plugin keeps its goal, item explanations, timers and commit records in a `mouriya.omp.todo-more.notes` session entry attached to the list's items by phase name and title, and no longer writes a second copy of the whole list or fails a `todo` call or `/todo-more` save on that copy. The `todo` tool and the `/todo-more` editor behave as before: a `/todo-more` save still writes the host list (its content unchanged by a goal or explanation edit) together with the notes. The empty-list `edit` gate, the planning snapshot delivered with a tool result, the review read, the stop-time reminder check and the content of a host reminder that is not persisted yet read the host list, which is current as soon as a `todo` call returns, instead of the branch, which receives the call's result a moment later. Sessions saved by earlier versions keep their lists but their goal, explanations, timers and commit records are no longer restored.
- Todo reminders now follow omp's own `todo.*` settings: when the stop reminder, the mid-run nudge (`todo.midRunNudges`) and the eager prelude (`todo.eager`) appear, and how many stop reminders are sent (`todo.remindersMax`), is decided by omp for the main session and subagents alike. They still reach the model with this plugin's content: open items with explanations and estimates, the goal, the `EXPLAIN` hint, the Todo-document syntax for the eager prelude, and the goal-mode todo snapshot. The reminder after a turn that ended in a server error, unfinished tool calls or a non-human abort is sent only while `todo.reminders` is on and at most `todo.remindersMax` times since the latest user message.

### Removed

- Removed the `BLOCK` and `UNBLOCK` commands and the item blocker text.
- Removed the handling of list changes made outside the plugin's `todo` tool and `/todo-more` editor: the plugin no longer reads `user_todo_edit` entries or other `todo` results written by someone else, and the overtime timer no longer wraps `session.commitTodoPhases`.
- Removed the plugin settings `reminders`, `remindersMax` and `eager`; the plugin no longer switches off omp's `todo.reminders` and `todo.eager` in each session, so the values set in `/settings` apply. Set them there instead (`leafMaxMinutes` stays a plugin setting).

### Fixed

- A `todo` document rejected for a syntax, target or rule error no longer leaves behind the git commit of a `DONE` clause earlier in the same document: every step is checked before any `DONE` commits, so the rejected document's changes stay uncommitted and the item stays open, as the error says.
- In Tern on omp 19.x the Todo More pill sits on omp's activity line again instead of a row of its own above it, the host's own todo pill no longer shows beside it, and the Tern dock keeps its own flex layout, so a tall dock on a phone no longer pushes the composer's model and send row under the key bar. The HUD widget now mounts above the editor, and the stylesheet no longer rebuilds the dock as a fourteen-slot grid ([oh-my-omp/omp-config#408](https://github.com/oh-my-omp/omp-config/issues/408)).

## [0.2.3] - 2026-11-21

### Changed

- Updated the shared copies of `context-delta.ts`, `todo-read.ts` to oh-my-omp/shared@80068ad.

## [0.2.2] - 2026-11-20

### Changed

- Reported a blocked todo item as `pending` in the host projection (`details.phases`, TodoTracker and HUD) and stopped carrying its blocker there, while `details.more` keeps the plugin's five statuses and blockers

### Removed

- Removed the `ctx` tool with its `xd://ctx/recall` topic, the task log that `todo` and `goal` calls appended to `local://task-log/<agent-id>.md`, and the `<post-compact-ctx>` block placed after the compaction summary. Requests no longer carry the `ctx` tool or that block, and `todo`/`goal` calls write no task log. Existing `todo-more.post-compact-ctx` session entries and task log files stay where they are and are no longer read ([#67](https://github.com/oh-my-omp/omp-todo-more/issues/67))

## [0.2.1] - 2026-11-19

### Changed

- Updated the shared copy of `i18n.ts` to oh-my-omp/shared@33dbe00.
- The plan-check reminder and the overtime warning are delivered through the shared context-delta stream: reminders carry `source="omp-todo-more/<id>"`, a snapshot that matches the context is not re-sent, and the plan-check reminder now rides the hidden reminder channel at `before_agent_start` and the tool-result `additionalContext` instead of being appended to every stored user message. The shared `i18n`, `todo-read` and `tern plugin` files are consumed as copies, and CI runs `omomp-check`.

### Fixed

- Stop reminders work again on omp 18.21 and later: they were silently skipped on every stop because the check for pending background work called `hasPendingAsyncWork()`, which the host removed, and now reads the host's `wakeSources` instead ([#53](https://github.com/oh-my-omp/omp-todo-more/issues/53))

## [0.2.0] - 2026-11-18

### Added

- Plugin setting `leafMaxMinutes` (default `60`, 1–1440) caps the estimate of one todo item: an `ADD` or `ESTIMATE` above it rejects the whole document with an error asking to split the work into several items. The `todo` tool reads the setting on every call.

### Changed

- A todo item's budget is closed once it receives its overtime warning: an `ESTIMATE` that would change it rejects the document, and the error names the item's phase so the remaining work is added as new items with `PHASE` and `ADD`. Estimates revised before the warning behave as before.
- The overtime warning now marks the overrun as a serious problem and requires the agent, before any other step on the task, to check the evidence for the cause, decide whether the approach must change, and state the cause and next approach in its next message; it says the estimate is closed and names the phase for the new items. It no longer says the warning is no reason to stop or that the estimate is only a forecast.

## [0.1.37] - 2026-11-14

### Fixed

- Fixed Todo More dock placement and spacing against the fourteen-slot OMP native dock

## [0.1.36] - 2026-11-12

### Changed

- The plugin joins the omomp daily release channel: merges to `main` no longer change the version, and `.github/workflows/omomp-release.yml` promotes `## [Unreleased]` to a version section on the `release` branch with a tag and GitHub Release every day at 02:00 GMT+9. `package.json` declares `omomp.changelog`, ships `CHANGELOG.md` in `files`, and the install command uses `#release`.

## [0.1.35] - 2026-11-12

- An empty Todo branch keeps the HUD's hidden placeholder on every frame, not only the first: `TodoHud` now caches the node it returns, placeholder included, so a hit on an unchanged empty branch no longer returns `null` where a fresh derivation returns the hidden slot (the slot the host keeps identifiable while it shows no pill). Non-empty nodes keep their identity reuse and `describeTodoHud` still returns `null` for an empty snapshot.
- An editing subagent keeps `todo` when another plugin re-applies the active tool set after the plugin restored it (omp-remote-build's per-turn sync in `before_agent_start`, for one). The host filters `todo` out of every extension-driven `setActiveTools` in a subagent, so whenever such a hook ran after this plugin's, the subagent lost the tool for the whole prompt while the `edit` guard still demanded a Todo document. The restore now runs before each model call of the subagent session (a before-model-call hook registered once per session at its first `before_agent_start`), so the tool is present whatever order plugins run their hooks in. It writes the whole set in the shared canonical order (builtins in registry order, then the rest sorted) instead of appending `todo`, so a forked or rebuilt session lists the same tools in the same order.
- todo-more now runs on top of the native todo instead of replacing it: keep `todo.enabled` on (the default). The plugin's `todo` tool shadows the built-in one; the native stop reminder, mid-run nudge and eager prelude are switched off for the process with runtime overrides of `todo.reminders` and `todo.eager` (never persisted), and the plugin's own are configured by its plugin settings `reminders` (default `true`), `remindersMax` (default `3`) and `eager` (default `default`) instead of the host `todo.*` keys. In goal mode the host's own `<todo_context>` block is removed from the request and the plugin's richer one appended, so the model sees one snapshot.
- Every branch reader (tool, reminders, planning annotations, edit guard, overtime, HUD, editor, review API, `DONE` model trailers, post-compaction hint) reads one forward fold of the session branch, kept per session manager and extended by the entries appended since the last read; a leaf that moved off the folded path folds the new branch from its root. Requests no longer rescan the branch per user message, and an unchanged branch is served without reading entries.
- The overtime timer no longer replaces the session manager's `appendCustomEntry`, `appendMessage`, `appendCustomMessageEntry` and `ingestReplicatedEntry`: it re-arms on tool, message, turn, run, prompt and session events, and on the host's out-of-tool writes through `session.commitTodoPhases`. An entry replicated from a collaboration host is picked up at the next of those events.
- Sessions are looked up as in-process `AgentSession` instances; a remote session handle from the agent registry is left alone.
- A main-session stop reminder now shows its event header (`N incomplete todos - reminder a/m`) as an info notification (`ctx.ui.notify`) instead of writing a `todo-more.reminder-notice` custom message into the session. The notice had no reader, yet it entered model input, so the `context` hook scanned every request's messages to strip it; that scan is gone, and with goal mode off the hook returns without reading the messages. Notices already written to older sessions are no longer stripped or specially rendered.
- The factory registers `todo`, `ctx`, hooks and UI before the Tern initialization await, so a restart keeps the prompt cache; the review API subscribes after that await, so a factory rejected by Tern initialization leaves no event-bus listener behind.
- UI language resolution no longer reads the agent-directory omomp file: `omomp-lang` sections in `omomp.{yml,yaml,json,toml}` are ignored, and language comes only from `OMOMP_LANG`, then `LC_ALL`/`LC_MESSAGES`/`LANG`, then English. The configuration-file lookup and its per-process cache are gone; explicit and locale behavior is unchanged.

- The post-compaction `<post-compact-ctx>` block no longer arrives as a user message, which started a model turn of its own when idle and, queued as steer during a mid-turn compaction, landed after the final answer, so the model repeated that answer. A `context` hook now places it right after the compaction summary in every request of the main session; the snapshot is rendered on the first request after a compaction and recorded once as a `todo-more.post-compact-ctx` custom entry keyed by the compaction entry id, so later requests reuse it byte-for-byte until the next compaction and after resume.
- Restore `todo` for every subagent with enabled `edit`, replacing the four-name `task:*` whitelist so custom editing agents can satisfy the same Todo edit precondition themselves. Read-only subagents do not gain the tool.
- Publish the full Todo protocol/work lifecycle and ctx recall instructions as packaged native `docTopics`, linked from the tool descriptions via `xd://todo/protocol`, `xd://todo/lifecycle` and `xd://ctx/recall`; task-agent Todo installation shares the same topics. The `todo` description itself states the rules that reject a call or make `DONE` commit (document envelope, INIT/ADD shape, exact selectors, VIEW alone, the commit clause in a dirty checkout), so a model that has not read a topic still writes a valid document; topics carry the elaboration.
- Keep Todo preview parser diagnostics structured until ANSI/native call-card rendering, so human-facing errors follow the current English/Chinese UI language while model-facing execution errors remain English.
- Time spent waiting on the user in `ask` no longer counts as work time: every `in_progress` interval leaves out the spans from the host's `tool_execution_start` record of an `ask` call to that call's tool result (or to the `session_exit` record when the process ended while it was open), read from the branch. Transitions write elapsed time without those spans, the overtime timer runs no deadline while an `ask` is open, and an `ask` result re-arms it, so a long discussion in `ask` does not raise an overtime warning.
- Todo now applies only to the work phase (a request that changes files, config, git or external state); discussion, investigation, explanation and answering questions are the non-work phase and get no todo. The tool description defines both phases, the empty-list user-message reminder asks for INIT only before the first change of work, the list reminder says non-work messages add no items, and the `preferred` eager prelude scopes its suggestion to work. The `edit` guard and the forced (`always`) eager prelude are unchanged.
- A `task:*` subagent working in its parent agent's git worktree no longer commits on `DONE`: every form (no clause, message, scope and message) completes without a commit and without the uncommitted-work refusal, and the result says the parent agent integrates the changes. Sharing is decided at completion time by comparing the git working-tree roots of the subagent and of its parent's live session (`ctx.agent.parentId` through the agent registry); isolated subagents, the main session, and subagents whose parent cannot be resolved keep the existing commit and refusal behavior.
- The `omp-todo-more:read` reply now carries `counts`, the number of items per status (`pending`, `in_progress`, `completed`, `abandoned`, `blocked`) over the whole list, so consumers such as omp-unified-exec's stop gate can tell an empty list and blocked items from a list whose items are all closed. Existing fields are unchanged.
- A main-session stop on an account usage-limit 429 (`isUsageLimitOutcome`) no longer sends its Todo reminder after the 10-second grace: the reminder waits until one minute past the account reset (the provider's retry hint, otherwise omp's quota estimate, marked as estimated), measured by the wall clock in timer segments of at most an hour. A one-line notice above the editor shows the send time without taking focus; `Ctrl+N` or `/todo-more-cancel` cancels the pending reminder, and a submitted message, a session/branch switch or shutdown cancels it too. A draft in the editor at the deadline holds the reminder, rechecked every 10 seconds, until it clears. Other cut-off stops, including per-minute rate-limit 429s, keep the grace window.
- Fixed the Tern composer showing only the last character of its draft with Todo More's stylesheet loaded, after an edit followed by a relayout such as opening Settings or resizing the window: the dock grid's column is a definite `100%` track instead of `1fr`, so Tern no longer lays the composer text out at its min-content width.
- `DONE` commits now end with one `Model: <provider>/<model-id>` git trailer per model the committing session ran since its previous todo commit (failed requests excluded, the current model included), each once in order of first use. A `task:*` worker's commits name its own models; the item's recorded message stays as given.
- Incremental CRUD `todo` cards (`ADD`, `DONE`, `START`, `RM`, `DROP`, `BLOCK`, `UNBLOCK`, `EXPLAIN`, `ESTIMATE`, `GOAL`) now render only the delta of changed items/goal while collapsed in both ANSI and native views (`INIT` and `VIEW` still render the full list, and expanding any card restores the full snapshot); stop reminders now render only the reminder event header without listing todo items.
- Native result cards now carry the `Todo` header with `closed/total` progress (`tool.target`, `targetKind: "text"`) and the bare `Todo` title for empty and error results, matching the upstream native `todo`; `TOOL_FIELDS` now shares the ANSI `renderCall`/`renderResult` hooks with the host-tool install, so `task:*` subagents get the same card.
- Render one card per `todo` call: the registered tool merges its call and result views, so the streaming preview is the pending card and the result view replaces it in both ANSI and native transcripts instead of the preview body stacking above the same list in one block.
- Gave `DONE` a git association: `DONE "title" "<message>"` commits every change and `DONE "title" "<paths>" "<message>"` commits only those pathspecs, staged and committed by the tool itself through `@oh-my-pi/pi-natives/vcs`. Every task a `DONE` completes records the accepted sha, message and resolved scope, shown in summaries, native cards, snapshots and the ctx task log. Outside a checkout or with a clean tree the clause is inert and its parameters are ignored; with uncommitted work a `DONE` without a clause is rejected and asks for one, while a scope that stages nothing is refused with git's own answer. `runTodo` is async to reach git, and scoped pathspecs resolve against the session directory like its shell.
- Compacted the Todo result card to native shape: a batch expands only the phases it touches, untouched phases fold to one summary line, and each task is one row with its estimate, missing-explanation flag and blocker inline. Collapsed native-view results show only the objective; expanding restores Measure, Done when and each explanation. Field content is unchanged, only its layout.
- Retained Tern's actual checklist HUD visuals in the native activity track, preserving pill sizing, long-title truncation, ring, typography and live theme switching. Used one supported native-card disclosure control with session-bound state instead of duplicating the checklist's local open state.
- Restored the original above-pill positioning, 360px width, 420px maximum height, internal scrolling, popup material and motion in a native-sized Todo wrapper. Kept the popup beside the disclosure so pill hover follows the trigger without leaking into popup interactions. Removed the generic portal, height-allocation canvas, direction-flip path and below-pill tray. Preserved Spine's native widget spacing, padding and background band through the dock adapter.
- Unified native tool results, progress details and reminder snapshots around goal fields and the native checklist, preserving explanations alongside blockers and keeping real task counts.
- Routed Tern's `/todo` and `/todo edit` to the rich editor while preserving other host subcommands and the ANSI HUD; every editor entry closes the session-bound progress disclosure before opening the editor.
- Followed the host composer's live viewed-agent lineage for child/nested-session progress and edits; commits append through the target session's own manager rather than an extension-bound main-session writer.
- Shared the domain snapshot schema directly across persisted, tool-result and reminder boundaries so packaged extensions load on the managed OMP runtime without schema introspection.
- Add edit-style single-document Todo initialization and batch editing, with readonly streaming previews and one final commit.
- Preserve explicit minute estimates, active clocks and deadline warnings in batches; return ordered accepted changes for history consumers.
- Require a model-provided positive integer `estimatedMinutes` for every new Todo item, reject fractions without rounding, and add `estimate` to supply or revise budgets without erasing elapsed work.
- Persist active wall-clock intervals through status changes, native edits and session reloads; explicitly mark historical/native items as unestimated.
- Schedule overtime injection with a single nearest-deadline timeout re-armed by relevant journal writes and session/branch changes, without periodic polling or end-hook deadline checks. Each budget gets one warning preserving outcome and quality, asking agents to investigate, reconsider their approach, continue and consult subagents or their parent; idle delivery does not start a turn.
- Show estimates in ANSI/native tool cards and the Todo overlay, and update eager/planning guidance to require estimates.

## 0.1.0

- Extracted the rich Todo domain, tool, ANSI rendering, reminders and planning guard from omp-config into an independent OMP package.
- Preserved `todo` operations, snapshot/result protocol and title-based joins with native host edits and historical sessions.
- Preserved per-session list ownership and `task:*` tool restoration, including restricted child tool registries.
- Added a synchronous, read-only `omp-todo-more:read` wire projection for completion-review consumers without internal module imports.
- Unified tool mutations and latest-branch edit intents through one synchronous commit path, with explicit branch-acceptance and projection failure diagnostics.
- Added rich native tool cards and the session-bound `/todo-more` goal/explanation overlay using host Editor/FormField components, with visible keyboard action selection and current-list selection bounds.
- Added awaited, owner-CLI Tern stylesheet installation, preserving disabled state and rejecting linked-target conflicts without unlinking.
