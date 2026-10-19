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
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { TODO_MORE_ENTRY_TYPE, todoMoreSnapshotSchema } from "./state.ts";

/** A model as the trailer names it. */
export type ModelRef = { readonly provider: string; readonly id: string };

const modelText = (model: ModelRef): string => `${model.provider}/${model.id}`;

/** Commit shas a todo-more snapshot entry records; empty for every other entry. */
function commitShas(entry: SessionEntry): string[] {
	if (entry.type !== "custom" || entry.customType !== TODO_MORE_ENTRY_TYPE) return [];
	const parsed = todoMoreSnapshotSchema.safeParse(entry.data);
	if (!parsed.success) return [];
	return parsed.data.phases.flatMap((phase) => phase.items.flatMap((item) => (item.commit === undefined ? [] : [item.commit.sha])));
}

/** Distinct models since the session's previous todo commit, in order of first use, then the current one. */
export function participatingModels(entries: readonly SessionEntry[], current: ModelRef | undefined): string[] {
	const seen = new Set<string>();
	let models: string[] = [];
	for (const entry of entries) {
		const shas = commitShas(entry);
		if (shas.some((sha) => !seen.has(sha))) {
			for (const sha of shas) seen.add(sha);
			models = [];
			continue;
		}
		// A failed request produced nothing; an aborted one may already have acted through its tool calls.
		if (entry.type !== "message" || entry.message.role !== "assistant" || entry.message.stopReason === "error") continue;
		models.push(modelText({ provider: entry.message.provider, id: entry.message.model }));
	}
	if (current !== undefined) models.push(modelText(current));
	return [...new Set(models)];
}

/** The message git records: the completion's message, then one `Model` trailer per model. */
export function withModelTrailers(message: string, models: readonly string[]): string {
	if (models.length === 0) return message;
	return `${message.trimEnd()}\n\n${models.map((model) => `Model: ${model}`).join("\n")}`;
}
