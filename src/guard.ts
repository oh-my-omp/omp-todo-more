import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { TodoSession } from "./commit.ts";
import type { AgentRef, WorktreeScope } from "./git.ts";
import type { Planned } from "./kernel.ts";
import type { ProjectConfig } from "./project-config.ts";
import type { TodoParams } from "./protocol.ts";
import type { TodoNgState } from "./state.ts";

export type StatePatch = (state: TodoNgState) => TodoNgState;

export type Allowed = { readonly kind: "allow"; readonly note: string | null; readonly patch: StatePatch | null };

export type Verdict = Allowed | { readonly kind: "reject"; readonly message: string };

export const allow = (note: string | null = null, patch: StatePatch | null = null): Allowed => ({ kind: "allow", note, patch });

export const reject = (message: string): Verdict => ({ kind: "reject", message });

export type PlannedTransition = {
	readonly params: TodoParams;
	readonly planned: Planned;
	readonly project: ProjectConfig;
	readonly scope: WorktreeScope;
	readonly leafMaxMinutes: number;
};

export type SyncGuard = { readonly name: string; readonly run: (transition: PlannedTransition) => Verdict };

export type Transition = PlannedTransition & {
	readonly session: TodoSession;
	readonly agent: AgentRef;
	readonly signal: AbortSignal | undefined;
	readonly host: ExtensionContext | undefined;
};

export type TransitionGuard = { readonly name: string; readonly run: (transition: Transition) => Verdict | Promise<Verdict> };

export type Refusal = { readonly guard: string; readonly message: string };
