import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "@oh-my-pi/omptype/zod";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "./errors.ts";
import { repositoryRoot } from "./git.ts";
import { formatIssues } from "./protocol.ts";
import { nonEmptyText } from "./state.ts";

export const PROJECT_CONFIG_FILE = path.join(".omp", "todo-ng.json");

export const TAIL_SCOPES = ["main", "isolated", "all"] as const;
export type TailScope = (typeof TAIL_SCOPES)[number];

export type TailCheck =
	| { readonly kind: "shell"; readonly command: string; readonly timeoutMs: number }
	| { readonly kind: "judge"; readonly prompt: string; readonly timeoutMs: number };

export type TailItemRule = {
	readonly id: string;
	readonly phase: string;
	readonly title: string;
	readonly detail: string;
	readonly minutes: number | null;
	readonly scope: TailScope;
	readonly protected: boolean;
	readonly check: TailCheck | null;
};

export type ProjectEffects = {
	readonly editGate: boolean;
	readonly commit: boolean;
	readonly overtime: boolean;
	readonly cutOff: boolean;
};

export type ProjectConfig = { readonly effects: ProjectEffects; readonly tailItems: readonly TailItemRule[] };

export type ProjectConfigState =
	| { readonly kind: "ok"; readonly config: ProjectConfig }
	| { readonly kind: "invalid"; readonly path: string; readonly reason: string };

const ALL_EFFECTS: ProjectEffects = { editGate: true, commit: true, overtime: true, cutOff: true };

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = { effects: ALL_EFFECTS, tailItems: [] };

export const DEFAULT_PROJECT: ProjectConfigState = { kind: "ok", config: DEFAULT_PROJECT_CONFIG };

const MAX_TAIL_MINUTES = 1440;

const timeoutSchema = (max: number, fallback: number) => z.number().int().positive().max(max).default(fallback);

const checkSchema = z.union([
	z.object({ kind: z.literal("shell"), command: nonEmptyText, timeoutMs: timeoutSchema(600_000, 120_000) }).strict(),
	z.object({ kind: z.literal("judge"), prompt: nonEmptyText, timeoutMs: timeoutSchema(300_000, 30_000) }).strict(),
]);

const tailItemSchema = z
	.object({
		id: nonEmptyText,
		phase: nonEmptyText.default("Verification"),
		title: nonEmptyText,
		detail: nonEmptyText,
		minutes: z.number().int().min(1).max(MAX_TAIL_MINUTES).optional(),
		scope: z.enum(TAIL_SCOPES).default("main"),
		protected: z.boolean().default(true),
		check: checkSchema.optional(),
	})
	.strict()
	.transform(
		(item): TailItemRule => ({
			id: item.id,
			phase: item.phase,
			title: item.title,
			detail: item.detail,
			minutes: item.minutes ?? null,
			scope: item.scope,
			protected: item.protected,
			check: item.check ?? null,
		}),
	);

const effectsSchema = z
	.object({
		editGate: z.boolean().default(true),
		commit: z.boolean().default(true),
		overtime: z.boolean().default(true),
		cutOff: z.boolean().default(true),
	})
	.strict();

function duplicates(items: readonly TailItemRule[], field: "id" | "title"): string[] {
	const first = new Map<string, number>();
	const found: string[] = [];
	for (const [index, item] of items.entries()) {
		const seen = first.get(item[field]);
		if (seen === undefined) first.set(item[field], index);
		else found.push(`tailItems.${index}.${field}: ${JSON.stringify(item[field])} repeats tailItems.${seen}.${field}`);
	}
	return found;
}

const projectConfigSchema = z
	.object({ effects: effectsSchema.default(() => ALL_EFFECTS), tailItems: z.array(tailItemSchema).default(() => []) })
	.strict();

export function projectConfigPath(cwd: string): string {
	return path.join(repositoryRoot(cwd) ?? cwd, PROJECT_CONFIG_FILE);
}

const isAbsent = (error: unknown): boolean =>
	error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");

function loadProjectConfig(file: string): ProjectConfigState {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if (isAbsent(error)) return DEFAULT_PROJECT;
		return { kind: "invalid", path: file, reason: `cannot be read: ${errorText(error)}` };
	}
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (error) {
		return { kind: "invalid", path: file, reason: `is not valid JSON: ${errorText(error)}` };
	}
	if (Array.isArray(json)) return { kind: "invalid", path: file, reason: "must be an object (was an array)" };
	if (typeof json === "object" && json !== null && "effects" in json && Array.isArray(json.effects)) {
		return { kind: "invalid", path: file, reason: "effects: must be an object (was an array)" };
	}
	const parsed = projectConfigSchema.safeParse(json);
	if (!parsed.success) return { kind: "invalid", path: file, reason: formatIssues(parsed.error) };
	const repeated = [...duplicates(parsed.data.tailItems, "id"), ...duplicates(parsed.data.tailItems, "title")];
	if (repeated.length > 0) return { kind: "invalid", path: file, reason: repeated.join("; ") };
	return { kind: "ok", config: parsed.data };
}

export function readProjectConfig(logger: Pick<ExtensionAPI["logger"], "warn">, cwd: string): ProjectConfigState {
	const state = loadProjectConfig(projectConfigPath(cwd));
	if (state.kind === "invalid") logger.warn("todo-ng project config is invalid", { path: state.path, reason: state.reason });
	return state;
}

export function projectConfigProblem(state: Extract<ProjectConfigState, { kind: "invalid" }>): string {
	return `Project config ${state.path} is invalid: ${state.reason}`;
}
