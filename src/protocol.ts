import { z } from "@oh-my-pi/omptype/zod";
import { estimatedMinutesSchema } from "./state.ts";

const nonEmpty = z.string().refine((value) => value.trim().length > 0, "must not be empty");

export const goalParamSchema = z.object({
	title: nonEmpty.describe("Objective title"),
	summary: nonEmpty.describe("How progress is measured"),
	acceptance: nonEmpty.describe("Concrete done criteria"),
});

export const addItemParamSchema = z.object({
	phase: z.string().optional().describe('Phase name (defaults to "Tasks")'),
	title: nonEmpty.describe("Concise 5-10 word task title"),
	detail: nonEmpty.describe("Scope and completion criteria"),
	minutes: estimatedMinutesSchema.describe("Positive integer estimate in minutes (<= leafMaxMinutes, default 60)"),
});

export const explainParamSchema = z.object({
	id: nonEmpty.describe("Task ID"),
	note: nonEmpty.describe("Updated explanation"),
});

export const estimateParamSchema = z.object({
	id: nonEmpty.describe("Task ID"),
	minutes: estimatedMinutesSchema.describe("New positive integer minutes (<= leafMaxMinutes; rejected after overtime)"),
});

export const parametersSchema = z.object({
	goal: goalParamSchema.optional().describe("Initialize or update the goal (required when creating a new list)"),
	add: z.array(addItemParamSchema).min(1).optional().describe("Add tasks; split work over 60 min into multiple items"),
	start_id: nonEmpty.optional().describe("Task ID to mark in_progress"),
	explain: z.array(explainParamSchema).min(1).optional().describe("Update explanations for existing tasks by ID"),
	estimate: z.array(estimateParamSchema).min(1).optional().describe("Revise estimates by ID before an overtime warning"),
	done_ids: z.array(nonEmpty).min(1).optional().describe("Task IDs to mark completed"),
	drop_ids: z.array(nonEmpty).min(1).optional().describe("Task IDs to mark abandoned"),
	view: nonEmpty.optional().describe('Inspect without mutating: "all" (default on empty call), "current", or a phase name/slug'),
});

export type GoalParam = z.infer<typeof goalParamSchema>;
export type AddItemParam = z.infer<typeof addItemParamSchema>;
export type ExplainParam = z.infer<typeof explainParamSchema>;
export type EstimateParam = z.infer<typeof estimateParamSchema>;
export type TodoParams = z.infer<typeof parametersSchema>;

export type ParsedTodoParams = { kind: "ok"; params: TodoParams } | { kind: "invalid"; message: string };

function formatIssues(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string {
	return error.issues
		.map((issue) => {
			const field = issue.path.map(String).join(".");
			return field === "" ? issue.message : `${field}: ${issue.message}`;
		})
		.join("; ");
}

export function hasTodoMutation(params: TodoParams): boolean {
	return (
		params.goal !== undefined ||
		params.add !== undefined ||
		params.start_id !== undefined ||
		params.explain !== undefined ||
		params.estimate !== undefined ||
		params.done_ids !== undefined ||
		params.drop_ids !== undefined
	);
}

const strictParametersSchema = parametersSchema.strict();

export function parseTodoParams(raw: unknown): ParsedTodoParams {
	const parsed = strictParametersSchema.safeParse(raw);
	if (!parsed.success) {
		return { kind: "invalid", message: `Invalid todo arguments: ${formatIssues(parsed.error)}` };
	}
	if (parsed.data.view !== undefined && hasTodoMutation(parsed.data)) {
		return {
			kind: "invalid",
			message: "Cannot combine view with todo updates (call todo({}) or todo({ view }) alone to inspect)",
		};
	}
	return { kind: "ok", params: parsed.data };
}

export type TodoPreview = {
	goal?: Partial<GoalParam>;
	add: { phase?: string; title?: string; detail?: string; minutes?: number }[];
	start_id?: string;
	explain: { id?: string; note?: string }[];
	estimate: { id?: string; minutes?: number }[];
	done_ids: string[];
	drop_ids: string[];
	view?: string;
	complete: boolean;
	error?: string;
};

const partialGoalSchema = z.object({
	title: z.string().optional(),
	summary: z.string().optional(),
	acceptance: z.string().optional(),
});

const partialAddSchema = z.object({
	phase: z.string().optional(),
	title: z.string().optional(),
	detail: z.string().optional(),
	minutes: z.number().optional(),
});

const partialExplainSchema = z.object({
	id: z.string().optional(),
	note: z.string().optional(),
});

const partialEstimateSchema = z.object({
	id: z.string().optional(),
	minutes: z.number().optional(),
});

const partialParamsSchema = z.object({
	goal: partialGoalSchema.optional(),
	add: z.array(partialAddSchema).optional(),
	start_id: z.string().optional(),
	explain: z.array(partialExplainSchema).optional(),
	estimate: z.array(partialEstimateSchema).optional(),
	done_ids: z.array(z.string()).optional(),
	drop_ids: z.array(z.string()).optional(),
	view: z.string().optional(),
});

export function previewTodoArgs(raw: unknown): TodoPreview {
	const empty: TodoPreview = {
		add: [],
		explain: [],
		estimate: [],
		done_ids: [],
		drop_ids: [],
		complete: false,
	};
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ...empty, error: "Expected todo arguments object" };
	}
	const partial = partialParamsSchema.safeParse(raw);
	if (!partial.success) {
		return { ...empty, error: formatIssues(partial.error) };
	}
	const parsed = parseTodoParams(raw);
	return {
		...(partial.data.goal === undefined ? {} : { goal: partial.data.goal }),
		add: partial.data.add ?? [],
		...(partial.data.start_id === undefined ? {} : { start_id: partial.data.start_id }),
		explain: partial.data.explain ?? [],
		estimate: partial.data.estimate ?? [],
		done_ids: partial.data.done_ids ?? [],
		drop_ids: partial.data.drop_ids ?? [],
		...(partial.data.view === undefined ? {} : { view: partial.data.view }),
		complete: parsed.kind === "ok",
		...(parsed.kind === "invalid" ? { error: parsed.message } : {}),
	};
}
