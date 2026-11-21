import { isAbsolute, relative } from "node:path";
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

function repoRelative(spec: string, root: string, prefix: string): string {
	if (isAbsolute(spec)) return relative(root, spec);
	return `${prefix}${spec}`.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
}

function pathsOf(draft: Draft, specs: readonly string[], prefix: string): { matched: Set<string>; resolved: string[] } {
	const resolved = specs.map((spec) => repoRelative(spec, draft.root, prefix));
	const matched = new Set<string>();
	for (const spec of resolved) {
		const glob = /[*?[{]/.test(spec) ? new Bun.Glob(spec) : undefined;
		for (const path of draft.paths) {
			if (path === spec || path.startsWith(`${spec}/`) || glob?.match(path) === true) matched.add(path);
		}
	}
	return { matched, resolved };
}

function selectScope(
	draft: Draft,
	scope: CommitScope,
	prefix: string,
): { kind: "ok"; scope: CommitScope } | { kind: "empty"; files: string[] } {
	if (scope.kind === "all") return { kind: "ok", scope };
	const { matched, resolved } = pathsOf(draft, scope.files, prefix);
	if (matched.size === 0) return { kind: "empty", files: resolved };
	for (const path of draft.paths) {
		if (matched.has(path)) draft.take({ path });
		else draft.drop({ path });
	}
	return { kind: "ok", scope: { kind: "paths", files: resolved } };
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
				message: `This session keeps no change record, so none of the changes in ${root} can be attributed to this agent: re-issue DONE "title" "<paths>" "<message>" to commit named paths.`,
			};
		}
		if (draft.selection().length === 0) return { kind: "inert", because: "foreign" };
	}
	const prefix = repositoryAt(cwd)?.prefixOf(cwd) ?? "";
	const selected = selectScope(draft, scope, prefix);
	if (selected.kind === "empty") {
		return {
			kind: "failed",
			message: `The scope ${JSON.stringify(selected.files.join(" "))} matches no changed path in ${root}; name pathspecs that match the work, or omit the scope to commit this agent's changes.`,
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
