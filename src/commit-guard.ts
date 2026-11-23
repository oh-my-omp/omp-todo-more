import { branchFacts } from "./branch.ts";
import type { TodoSession } from "./commit.ts";
import { type AgentRef, commitCompletion, type WorktreeScope, workState } from "./git.ts";
import { allow, reject, type TransitionGuard, type Verdict } from "./guard.ts";
import type { Completion } from "./kernel.ts";
import { participatingModels } from "./models.ts";
import { commitClauseOf, type TodoCommitClause } from "./protocol.ts";
import { type CommitRecord, commitRecordText, commitScopeText, type TodoNgState } from "./state.ts";

const INERT_NOTES = {
	"no-repository": "No git repository here: the commit committed nothing.",
	clean: "Nothing to commit: the working tree is clean, so the commit committed nothing.",
	foreign: "Nothing to commit: none of the uncommitted changes are this agent's, so the commit committed nothing.",
} as const;

const COMMITS_OFF =
	"The project config turns completion commits off (effects.commit is false): the commit clause was ignored and nothing was committed.";

function withCommit(id: string, commit: CommitRecord): (state: TodoNgState) => TodoNgState {
	return (state) => {
		if (state.kind === "empty") return state;
		return {
			...state,
			phases: state.phases.map((phase) => ({
				...phase,
				items: phase.items.map((item) => (item.id === id ? { ...item, commit } : item)),
			})),
		};
	};
}

async function completeWithCommit(
	session: TodoSession,
	clause: TodoCommitClause | null,
	completed: Completion,
	scope: WorktreeScope,
	agent: AgentRef,
): Promise<Verdict> {
	if (scope.kind === "shared") {
		return allow(
			`Shared worktree with the parent agent (${scope.root}): this completion committed nothing; the parent agent integrates and commits these changes.`,
		);
	}
	const cwd = session.sessionManager.getCwd();
	const artifactsDir = session.sessionManager.getArtifactsDir();
	const named = `Task ${JSON.stringify(completed.title)} (${completed.id})`;
	if (clause === null) {
		const state = await workState(cwd, artifactsDir, agent);
		switch (state.kind) {
			case "failed":
				return reject(state.message);
			case "no-repository":
			case "clean":
			case "foreign":
				return allow();
			case "own":
				return reject(
					`${named} would leave this agent's uncommitted work in ${state.root}: call todo again with commit ({ message }) to commit this agent's changes, or with commit.paths to commit a scope.`,
				);
			case "unattributed":
				return reject(
					`${named} would leave uncommitted work in ${state.root}, and this session keeps no change record to tell whose it is: call todo again with commit ({ message, paths }) to commit named paths.`,
				);
			default: {
				const unreachable: never = state;
				throw new Error(`Unexpected work state: ${String(unreachable)}`);
			}
		}
	}
	const outcome = await commitCompletion(
		cwd,
		artifactsDir,
		agent,
		clause.scope,
		clause.message,
		participatingModels(branchFacts(session.sessionManager), session.model),
	);
	switch (outcome.kind) {
		case "committed":
			return allow(
				`Committed ${commitRecordText(outcome.commit)} (${commitScopeText(outcome.commit.scope)}) in ${outcome.root}.`,
				withCommit(completed.id, outcome.commit),
			);
		case "inert":
			return allow(INERT_NOTES[outcome.because]);
		case "failed":
			return reject(outcome.message);
		default: {
			const unreachable: never = outcome;
			throw new Error(`Unexpected commit outcome: ${String(unreachable)}`);
		}
	}
}

export const commitGuard: TransitionGuard = {
	name: "commit",
	run: ({ params, planned, project, scope, session, agent }) => {
		const completion = planned.completion;
		if (completion === null) return allow();
		const clause = params.commit === undefined ? null : commitClauseOf(params.commit);
		if (!project.effects.commit) return allow(clause === null ? null : COMMITS_OFF);
		return completeWithCommit(session, clause, completion, scope, agent);
	},
};
