import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { commitSelection } from "@oh-my-pi/pi-coding-agent/commit/selective/apply";
import { createDraft, type Draft } from "@oh-my-pi/pi-coding-agent/commit/selective/draft";
import { ChangeJournal } from "@oh-my-pi/pi-coding-agent/commit/selective/journal";
import type { VcsGitRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { errorText } from "./errors.ts";
import { commitMessage } from "./models.ts";
import type { CommitRecord, CommitScope } from "./state.ts";

export type AgentRef = Pick<ExtensionContext["agent"], "id" | "parentId">;

export type WorkState =
	| { readonly kind: "no-repository" }
	| { readonly kind: "failed"; readonly message: string }
	| { readonly kind: "clean"; readonly root: string }
	| { readonly kind: "foreign"; readonly root: string }
	| { readonly kind: "own"; readonly root: string }
	| { readonly kind: "unattributed"; readonly root: string };

export type CommitOutcome =
	| { readonly kind: "committed"; readonly root: string; readonly commit: CommitRecord }
	| { readonly kind: "inert"; readonly because: "no-repository" | "clean" | "foreign" }
	| { readonly kind: "failed"; readonly message: string };

type DraftOutcome =
	| { readonly kind: "no-repository" }
	| { readonly kind: "failed"; readonly message: string }
	| { readonly kind: "drafted"; readonly draft: Draft; readonly journal: ChangeJournal | null };

function repositoryAt(cwd: string): VcsGitRepo | null {
	try {
		return vcs.git(cwd);
	} catch {
		return null;
	}
}

function failureText(error: unknown): string {
	if (!vcs.isVcsError(error)) return errorText(error);
	return error.stderr.trim() || error.stdout.trim() || error.message.trim() || `exit code ${error.exitCode}`;
}

async function draftOf(cwd: string, artifactsDir: string | null, agent: AgentRef): Promise<DraftOutcome> {
	if (repositoryAt(cwd) === null) return { kind: "no-repository" };
	const journal = artifactsDir === null ? null : ChangeJournal.at(artifactsDir);
	try {
		return { kind: "drafted", draft: await createDraft({ cwd, journal, caller: agent.id }), journal };
	} catch (error) {
		return { kind: "failed", message: `Cannot read the working tree of ${cwd}: ${failureText(error)}` };
	}
}

export async function workState(cwd: string, artifactsDir: string | null, agent: AgentRef): Promise<WorkState> {
	const drafted = await draftOf(cwd, artifactsDir, agent);
	if (drafted.kind !== "drafted") return drafted;
	const { draft } = drafted;
	if (draft.paths.length === 0) return { kind: "clean", root: draft.root };
	if (!draft.journaled) return { kind: "unattributed", root: draft.root };
	return draft.selection().length > 0 ? { kind: "own", root: draft.root } : { kind: "foreign", root: draft.root };
}

export function sharedWorktreeRoot(cwd: string, otherCwd: string): string | null {
	const root = repositoryAt(cwd)?.info().repoRoot;
	if (root === undefined) return null;
	return repositoryAt(otherCwd)?.info().repoRoot === root ? root : null;
}

type PathspecOutcome =
	| { readonly kind: "matched"; readonly paths: ReadonlySet<string> }
	| { readonly kind: "failed"; readonly message: string };

async function pathspecMatches(cwd: string, specs: readonly string[]): Promise<PathspecOutcome> {
	const child = Bun.spawn(
		["git", "--no-optional-locks", "-C", cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", ...specs],
		{ stdin: "ignore", stdout: "pipe", stderr: "pipe" },
	);
	const [stdout, stderr, exitCode] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
	if (exitCode !== 0) return { kind: "failed", message: stderr.trim() || `git status exited with ${exitCode}` };
	const paths = new Set<string>();
	for (const entry of stdout.split("\0")) if (entry.length > 3) paths.add(entry.slice(3));
	return { kind: "matched", paths };
}

type ScopeSelection =
	| { kind: "ok"; scope: CommitScope }
	| { kind: "empty"; files: readonly string[] }
	| { kind: "failed"; message: string };

async function selectScope(draft: Draft, scope: CommitScope, cwd: string): Promise<ScopeSelection> {
	if (scope.kind === "all") return { kind: "ok", scope };
	const named = await pathspecMatches(cwd, scope.files);
	if (named.kind === "failed") return { kind: "failed", message: `Cannot resolve the scope in ${draft.root}: ${named.message}` };
	const matched = new Set(draft.paths.filter((path) => named.paths.has(path)));
	if (matched.size === 0) return { kind: "empty", files: scope.files };
	for (const path of draft.paths) {
		if (matched.has(path)) draft.take({ path });
		else draft.drop({ path });
	}
	return { kind: "ok", scope };
}

export async function commitCompletion(
	cwd: string,
	artifactsDir: string | null,
	agent: AgentRef,
	scope: CommitScope,
	message: string,
	models: readonly string[],
): Promise<CommitOutcome> {
	const drafted = await draftOf(cwd, artifactsDir, agent);
	if (drafted.kind === "no-repository") return { kind: "inert", because: "no-repository" };
	if (drafted.kind === "failed") return drafted;
	const { draft, journal } = drafted;
	const root = draft.root;
	if (draft.paths.length === 0) return { kind: "inert", because: "clean" };
	if (scope.kind === "all") {
		if (!draft.journaled) {
			return {
				kind: "failed",
				message: `This session keeps no change record, so none of the changes in ${root} can be attributed to this agent: name the work in commit.paths.`,
			};
		}
		if (draft.selection().length === 0) return { kind: "inert", because: "foreign" };
	}
	const selected = await selectScope(draft, scope, cwd);
	if (selected.kind === "failed") return selected;
	if (selected.kind === "empty") {
		return {
			kind: "failed",
			message: `commit.paths ${JSON.stringify(selected.files.join(" "))} matches no changed path in ${root}; name pathspecs that match the work, or omit commit.paths to commit this agent's changes.`,
		};
	}
	try {
		const outcome = await commitSelection(draft, commitMessage(message, models), {
			journal,
			agent: { agent: agent.id, parent: agent.parentId },
		});
		return { kind: "committed", root, commit: { sha: outcome.sha, message, scope: selected.scope } };
	} catch (error) {
		return { kind: "failed", message: `git commit failed in ${root}: ${failureText(error)}` };
	}
}
