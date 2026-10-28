/**
 * The git association of a completed item: the commit a completion owes.
 *
 * Authority: the repository, through the host's own git bindings
 * (`@oh-my-pi/pi-natives/vcs`). They decide whether the session's directory is
 * a checkout, whether anything is uncommitted, and they take the commit, so
 * nothing here reports a commit git did not make. Nothing is cached: every
 * completion asks git again, and the record it writes on the item is a copy of
 * git's answer, taken once.
 *
 * Outside a checkout, or with a clean working tree, a completion owes nothing
 * and a commit clause is inert — no commit, no error. A scoped clause names
 * pathspecs the way the model's own shell names them (relative to the session
 * directory); `all` covers the whole checkout. The scope is committed as
 * given: this module never checks that it covered everything that changed.
 *
 * A subagent working in its parent's worktree owes no commit at all: that
 * worktree holds the parent's and other sessions' changes too, and the parent
 * integrates them. Sharing is a comparison of the two working-tree roots git
 * reports (a linked worktree's own root, not its primary checkout).
 */
import { isAbsolute } from "node:path";
import type { VcsGitRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { errorText } from "./errors.ts";
import { withModelTrailers } from "./models.ts";
import type { CommitRecord, CommitScope } from "./state.ts";

/** What the repository says about the session's working tree. */
export type WorktreeState =
	| { readonly kind: "no-repository" }
	| { readonly kind: "clean"; readonly root: string }
	| { readonly kind: "dirty"; readonly root: string }
	| { readonly kind: "failed"; readonly message: string };

export type CommitOutcome =
	| { readonly kind: "committed"; readonly root: string; readonly commit: CommitRecord }
	/** Nothing to commit: no checkout, or nothing uncommitted. */
	| { readonly kind: "inert"; readonly because: "no-repository" | "clean" }
	| { readonly kind: "failed"; readonly message: string };

function repositoryAt(cwd: string): VcsGitRepo | null {
	try {
		return vcs.git(cwd);
	} catch {
		// A directory git cannot read is as good as one outside every checkout.
		return null;
	}
}

/** git's own words when it has them; the error text only as a fallback. */
function failureText(error: unknown): string {
	if (!vcs.isVcsError(error)) return errorText(error);
	return error.stderr.trim() || error.stdout.trim() || error.message.trim() || `exit code ${error.exitCode}`;
}

/** Whether the session's directory has uncommitted work, and where the checkout is. */
export async function worktreeState(cwd: string): Promise<WorktreeState> {
	const repo = repositoryAt(cwd);
	if (repo === null) return { kind: "no-repository" };
	const root = repo.primaryRoot();
	try {
		const dirty = await repo.isDirty();
		return dirty ? { kind: "dirty", root } : { kind: "clean", root };
	} catch (error) {
		return { kind: "failed", message: `Cannot read the working tree of ${root}: ${failureText(error)}` };
	}
}

/**
 * The working-tree root git reports for both directories when they lie in the
 * same working tree; `null` when either is outside every checkout or they lie
 * in different working trees (another linked worktree of the same repository
 * included).
 */
export function sharedWorktreeRoot(cwd: string, otherCwd: string): string | null {
	const root = repositoryAt(cwd)?.info().repoRoot;
	if (root === undefined) return null;
	return repositoryAt(otherCwd)?.info().repoRoot === root ? root : null;
}

/**
 * Stage a clause's scope and commit it; only a commit git accepted answers `committed`.
 * git records the clause's message followed by one `Model` trailer per entry of `models`.
 */
export async function commitCompletion(
	cwd: string,
	scope: CommitScope,
	message: string,
	models: readonly string[],
): Promise<CommitOutcome> {
	const repo = repositoryAt(cwd);
	if (repo === null) return { kind: "inert", because: "no-repository" };
	const root = repo.primaryRoot();
	const prefix = repo.prefixOf(cwd) ?? "";
	// Pathspecs are resolved against the checkout root, like the shell the model wrote them in.
	const files =
		scope.kind === "all" ? undefined : scope.files.map((file) => (isAbsolute(file) || prefix === "" ? file : `${prefix}${file}`));
	try {
		if (!(await repo.isDirty())) return { kind: "inert", because: "clean" };
		if (files === undefined) {
			await repo.stageFiles([]);
		} else {
			await repo.stageFiles([...files]);
			if ((await repo.changedFiles({ cached: true, files: [...files] })).length === 0) {
				return {
					kind: "failed",
					message: `The scope ${JSON.stringify(files.join(" "))} staged nothing in ${root}; name pathspecs that match the work, or omit the scope to commit every change.`,
				};
			}
		}
		const commit: CommitRecord = {
			sha: await repo.commitCreate(withModelTrailers(message, models), files === undefined ? {} : { files: [...files] }),
			message,
			scope: files === undefined ? scope : { kind: "paths", files },
		};
		return { kind: "committed", root, commit };
	} catch (error) {
		return { kind: "failed", message: `git commit failed in ${root}: ${failureText(error)}` };
	}
}
