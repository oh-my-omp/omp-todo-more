# Work lifecycle and time budgets

Work phase: the request changes files, config, git or external state. Before its first change, INIT the entire requested plan with a goal, explanation and estimate for EVERY requested item; NEVER omit work or remember leftovers. Update the goal, steps, explanations, estimates and statuses with material scope changes.

Non-work phase: discussion, investigation, explanation, answering questions; nothing changes. NEVER create or extend a todo for it. Investigation that ends in a decided change enters the work phase at that change.

After each logical task operation, no active means earliest pending starts in phase order; only the earliest active remains; blocked never starts automatically. Completion can return the pointer to earlier open work without reopening completed items.

BLOCK external waits (user, agent, service) with an optional reason to suppress stop reminders; UNBLOCK returns pending. Append a clearing task for an agent-actionable blocker.

Only in_progress time counts; pending/blocked/closed pause it. Repeated START, VIEW and EXPLAIN do not reset elapsed time. ESTIMATE preserves elapsed time and gives a changed budget one new overtime warning. Never re-init or inflate estimates to hide overruns.

A time budget is a forecast, not permission to reduce scope, quality or stop. On an overtime warning, verify the cause, reconsider the approach, consult a subagent (or parent) where useful, and keep advancing the full task.

NEVER call todo alone: initialize with first work and update with the next action.

Read xd://todo/protocol for the document grammar, selectors, validation and completion commits.
