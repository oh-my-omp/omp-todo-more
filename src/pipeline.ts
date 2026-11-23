import type { BranchFacts } from "./branch.ts";
import { errorText } from "./errors.ts";
import type { WorktreeScope } from "./git.ts";
import {
	type Allowed,
	allow,
	type PlannedTransition,
	type Refusal,
	reject,
	type StatePatch,
	type SyncGuard,
	type Transition,
	type TransitionGuard,
} from "./guard.ts";
import { locate, planTodo } from "./kernel.ts";
import type { ProjectConfig } from "./project-config.ts";
import type { TodoParams } from "./protocol.ts";
import type { TodoNgState } from "./state.ts";
import { appendTailItems, tailLifecycleGuard } from "./tail.ts";

function overtimeLock(warned: ReadonlySet<string>): SyncGuard {
	return {
		name: "overtime-lock",
		run: ({ params, planned, leafMaxMinutes }) => {
			const byId = locate(planned.base);
			const locked = (params.estimate ?? []).flatMap((entry) => {
				const hit = byId.get(entry.id);
				const estimate = hit?.item.estimate;
				if (hit === undefined || estimate?.kind !== "estimated" || estimate.minutes === entry.minutes || !warned.has(estimate.budgetId))
					return [];
				return [
					`Task "${hit.item.title}" (${entry.id}) already received an overtime warning, so its ${estimate.minutes}-minute estimate is closed and estimate cannot change it. Find out why it overran, then add the remaining work as new items with add (phase ${JSON.stringify(hit.phase)}), each at most ${leafMaxMinutes} min`,
				];
			});
			return locked.length === 0 ? allow() : reject(locked.join("; "));
		},
	};
}

export type TransitionEnv = { readonly leafMaxMinutes: number; readonly project: ProjectConfig; readonly scope: WorktreeScope };

export type TransitionPlan =
	| { readonly kind: "rejected"; readonly errors: readonly string[]; readonly refusals: readonly Refusal[] }
	| {
			readonly kind: "planned";
			readonly transition: PlannedTransition;
			readonly notes: readonly string[];
			readonly patches: readonly StatePatch[];
	  };

export function planTransition(
	params: TodoParams,
	previous: TodoNgState,
	facts: Pick<BranchFacts, "waits" | "overtimeWarned">,
	env: TransitionEnv,
	now: number,
): TransitionPlan {
	const plan = planTodo(params, previous, env.leafMaxMinutes, now, facts.waits);
	if (plan.kind === "rejected") return { kind: "rejected", errors: plan.errors, refusals: [] };
	const transformed =
		plan.base.kind === "empty"
			? appendTailItems(plan, env.project.tailItems, env.scope, env.leafMaxMinutes)
			: ({ kind: "ok", planned: plan } as const);
	if (transformed.kind === "rejected") return { kind: "rejected", errors: transformed.errors, refusals: [] };
	const transition: PlannedTransition = {
		params,
		planned: transformed.planned,
		project: env.project,
		scope: env.scope,
		leafMaxMinutes: env.leafMaxMinutes,
	};
	const guards: SyncGuard[] = [tailLifecycleGuard, ...(env.project.effects.overtime ? [overtimeLock(facts.overtimeWarned)] : [])];
	const refusals: Refusal[] = [];
	const allowed: Allowed[] = [];
	for (const guard of guards) {
		const verdict = guard.run(transition);
		if (verdict.kind === "reject") refusals.push({ guard: guard.name, message: verdict.message });
		else allowed.push(verdict);
	}
	if (refusals.length > 0) return { kind: "rejected", errors: [], refusals };
	return {
		kind: "planned",
		transition,
		notes: allowed.flatMap((verdict) => (verdict.note === null ? [] : [verdict.note])),
		patches: allowed.flatMap((verdict) => (verdict.patch === null ? [] : [verdict.patch])),
	};
}

export type GuardOutcome =
	| { readonly kind: "allowed"; readonly notes: readonly string[]; readonly patches: readonly StatePatch[] }
	| { readonly kind: "refused"; readonly refusal: Refusal };

export async function runGuards(transition: Transition, guards: readonly TransitionGuard[]): Promise<GuardOutcome> {
	const notes: string[] = [];
	const patches: StatePatch[] = [];
	for (const guard of guards) {
		let verdict: Awaited<ReturnType<TransitionGuard["run"]>>;
		try {
			verdict = await guard.run(transition);
		} catch (error) {
			return { kind: "refused", refusal: { guard: guard.name, message: `Guard "${guard.name}" failed: ${errorText(error)}` } };
		}
		if (verdict.kind === "reject") return { kind: "refused", refusal: { guard: guard.name, message: verdict.message } };
		if (verdict.note !== null) notes.push(verdict.note);
		if (verdict.patch !== null) patches.push(verdict.patch);
	}
	return { kind: "allowed", notes, patches };
}
