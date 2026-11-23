import type { WorktreeScope } from "./git.ts";
import { allow, reject, type SyncGuard } from "./guard.ts";
import { type AddedItem, locate, type Planned } from "./kernel.ts";
import type { TailItemRule, TailScope } from "./project-config.ts";
import { FRESH, idAllocator, isOpen, stateOf, type TodoItem, type TodoNgState } from "./state.ts";

const DEFAULT_TAIL_MINUTES = 15;

function reaches(scope: TailScope, worktree: WorktreeScope): boolean {
	switch (worktree.kind) {
		case "main":
			return true;
		case "isolated":
			return scope !== "main";
		case "shared":
			return scope === "all";
		default: {
			const unreachable: never = worktree;
			throw new Error(`Unexpected worktree scope: ${String(unreachable)}`);
		}
	}
}

export type Transformed = { readonly kind: "ok"; readonly planned: Planned } | { readonly kind: "rejected"; readonly errors: string[] };

export function appendTailItems(
	planned: Planned,
	rules: readonly TailItemRule[],
	worktree: WorktreeScope,
	leafMaxMinutes: number,
): Transformed {
	const next = planned.next;
	const tails = rules.filter((rule) => reaches(rule.scope, worktree));
	if (next.kind === "empty" || tails.length === 0) return { kind: "ok", planned };
	const items = next.phases.flatMap((phase) => phase.items);
	const titles = new Set(items.map((item) => item.title));
	const clashes = tails
		.filter((rule) => titles.has(rule.title))
		.map((rule) => `Task "${rule.title}" is appended automatically by project tail rule "${rule.id}": remove it from add`);
	if (clashes.length > 0) return { kind: "rejected", errors: clashes };
	const allocate = idAllocator(items.map((item) => item.id));
	const phases = next.phases.map((phase) => ({ name: phase.name, items: [...phase.items] }));
	const groups = new Map<string, AddedItem[]>();
	for (const rule of tails) {
		const id = allocate();
		const minutes = rule.minutes ?? Math.min(DEFAULT_TAIL_MINUTES, leafMaxMinutes);
		const item: TodoItem = {
			id,
			title: rule.title,
			explanation: { kind: "explained", text: rule.detail },
			estimate: { kind: "estimated", budgetId: crypto.randomUUID(), minutes },
			progress: FRESH,
			commit: null,
			tailRule: { ruleId: rule.id, protected: rule.protected },
		};
		let phase = phases.find((candidate) => candidate.name === rule.phase);
		if (phase === undefined) {
			phase = { name: rule.phase, items: [] };
			phases.push(phase);
		}
		phase.items.push(item);
		const group = groups.get(rule.phase) ?? [];
		group.push({ id, title: rule.title, explanation: rule.detail, estimatedMinutes: minutes });
		groups.set(rule.phase, group);
	}
	const changes = [...planned.changes, ...[...groups].map(([phase, added]) => ({ op: "add" as const, phase, items: added }))];
	return { kind: "ok", planned: { ...planned, next: stateOf(next.goal, phases), changes } };
}

function openWorkItems(state: TodoNgState): TodoItem[] {
	if (state.kind === "empty") return [];
	return state.phases.flatMap((phase) => phase.items.filter((item) => item.tailRule === null && isOpen(item.progress.status)));
}

export const tailLifecycleGuard: SyncGuard = {
	name: "tail-lifecycle",
	run: ({ params, planned, project }) => {
		const byId = locate(planned.base);
		const protectedDrops = (params.drop_ids ?? []).flatMap((id) => {
			const item = byId.get(id)?.item;
			return item?.tailRule?.protected === true ? [{ item, ruleId: item.tailRule.ruleId }] : [];
		});
		if (protectedDrops.length > 0) {
			return reject(
				protectedDrops
					.map(
						({ item, ruleId }) =>
							`Task "${item.title}" (${item.id}) is a protected tail item from project rule "${ruleId}": it cannot be dropped, complete it instead`,
					)
					.join("; "),
			);
		}
		const completion = planned.completion;
		const tailRule = completion === null ? null : (byId.get(completion.id)?.item.tailRule ?? null);
		if (completion === null || tailRule === null) return allow();
		const rule = project.tailItems.find((candidate) => candidate.id === tailRule.ruleId);
		if (rule === undefined) {
			return allow(
				`Project rule "${tailRule.ruleId}" behind task "${completion.title}" (${completion.id}) is no longer in the project config, so nothing checks this completion.`,
			);
		}
		if (rule.check === null) return allow();
		const open = openWorkItems(planned.next);
		if (open.length === 0) return allow();
		return reject(
			`Task "${completion.title}" (${completion.id}) carries the check of project rule "${rule.id}", which runs after all other work: complete or drop ${open.map((item) => `${item.id} "${item.title}"`).join(", ")} first`,
		);
	},
};
