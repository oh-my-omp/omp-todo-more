/**
 * The models a completion's commit names: the `Model` trailers of a `DONE` commit.
 *
 * Authority: the committing session's own branch. Each assistant message on it
 * carries the `provider` and `model` that produced it, and every commit todo-more
 * made lands there as a snapshot whose items carry the commit's sha. The window
 * runs from the latest snapshot that brought in a sha not seen before (the
 * session's previous todo commit) to the end of the branch. Subagents are not
 * read: a `task:*` worker commits its own work and names its own models.
 *
 * The session's current model is added as well: the host persists the assistant
 * message that issued this `DONE` asynchronously, so the branch may not hold it
 * yet when the commit runs.
 */
import type { BranchFacts } from "./branch.ts";

/** A model as the trailer names it. */
export type ModelRef = { readonly provider: string; readonly id: string };

/** Distinct models since the session's previous todo commit, in order of first use, then the current one. */
export function participatingModels(facts: BranchFacts, current: ModelRef | undefined): string[] {
	const models = current === undefined ? facts.modelsSinceCommit : [...facts.modelsSinceCommit, `${current.provider}/${current.id}`];
	return [...new Set(models)];
}

/** The message git records: the completion's message, then one `Model` trailer per model. */
export function withModelTrailers(message: string, models: readonly string[]): string {
	if (models.length === 0) return message;
	return `${message.trimEnd()}\n\n${models.map((model) => `Model: ${model}`).join("\n")}`;
}
