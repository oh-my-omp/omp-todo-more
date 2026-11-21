import type { Model } from "@oh-my-pi/pi-ai";
import type { BranchFacts } from "./branch.ts";

export type ModelRef = Pick<Model, "provider" | "id">;

export function participatingModels(facts: BranchFacts, current: ModelRef | undefined): string[] {
	const models = current === undefined ? facts.modelsSinceCommit : [...facts.modelsSinceCommit, `${current.provider}/${current.id}`];
	return [...new Set(models)];
}

export function commitMessage(message: string, models: readonly string[]): { readonly subject: string; readonly body: string } {
	const [subject = "", ...rest] = message.trim().split("\n");
	const trailers = models.map((model) => `Model: ${model}`);
	return { subject, body: [rest.join("\n").trim(), trailers.join("\n")].filter((part) => part.length > 0).join("\n\n") };
}
