# Todo document protocol

Batch Todo initialization and edits in one document; do not call once per task.
Input is plain text on custom-tool providers, otherwise {input: "the same document"}. Use uppercase commands, one per physical line, and JSON-quoted strings (escape newlines as \n):

```text
*** Begin Todo
INIT "Deliver feature" "Real user path passes" "Runtime verified"
PHASE "Implementation"
ADD "Implement feature" "Cover the requested behavior" 20
ADD "Verify feature" "Exercise the real entry and check the result" 10
*** End Todo
```

INIT replaces the list and goal, must be first and unique, and carries objective, measure, doneWhen. Following PHASE/ADD blocks form one init; ADD before PHASE uses "Tasks".

PHASE "name" followed by one or more ADD "title" "explanation" minutes appends outside INIT; each block needs ADD, and its scope ends at the first non-ADD. Status selectors never inherit PHASE.

Every ADD requires your own positive integer minute estimate, no fractions or defaults, at most the per-item limit (the leafMaxMinutes setting, 60 minutes by default). ESTIMATE "title" minutes supplies or revises a budget within the same limit, except on an item that already received an overtime warning: its estimate is closed and only new items can add time. EXPLAIN "title" "explanation" revises an explanation. Batch related edits in one document.

GOAL "objective" "measure" "doneWhen" replaces all goal fields on an existing nonempty list without normalizing task status; put GOAL first if the list lacks one.

START "title" selects the active task. DONE, DROP and RM take "title", PHASE "name", or ALL. RM ALL clears the list and goal.

A DONE carries the commit its completion owes: DONE "title" "<message>" commits this agent's changes (and its subagents') — the lines the host's change record attributes to them — and DONE "title" "<paths>" "<message>" commits every change in those whitespace-separated git pathspecs, resolved by git from the session directory like `git add -- <pathspec>` (an empty scope commits this agent's changes). Either form commits through the host's selective commit on a private index: another writer's staged or unstaged changes outside the commit stay exactly where they are. If HEAD moved meanwhile, the commit is built on the new HEAD when the selection still applies; otherwise DONE fails naming the move and the paths, and the task stays open. The tool records the commit on every task that DONE completes. Outside a git checkout, or with nothing uncommitted, the clause is inert and no commit happens; so it is when none of the uncommitted changes are this agent's. When this agent has uncommitted work, a DONE without a clause is rejected: commit the work through the clause, or discard it, before completing; another writer's changes never cause that rejection. A session that keeps no change record cannot tell whose changes are whose: the message-only form fails and a DONE without a clause in a dirty checkout is rejected, so name the paths. A subagent working in its parent agent's git worktree never commits: every DONE form completes without a commit or the uncommitted-work refusal, and the parent agent integrates and commits the changes.

VIEW must be the sole command; mutations already return the resulting list. Titles/phase names are unique and stable; NEVER use generated IDs or guess lost titles.

Partial input is an uncommitted preview. The complete document is validated in order and committed once; syntax, target or rule errors reject the entire batch.

Read xd://todo/lifecycle before planning work or changing task state.
