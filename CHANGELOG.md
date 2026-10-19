# Changelog

## Unreleased

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
