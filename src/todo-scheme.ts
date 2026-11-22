import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, SchemeSpec } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { type BranchSource, branchFacts, foldBranch } from "./branch.ts";
import { liveState, type TodoSession } from "./commit.ts";
import { formatFullView, formatPhaseView } from "./format.ts";
import { sessionOf } from "./session.ts";
import { type AskWait, itemDisplayIds, joinHost, phaseSlug, type TodoMoreState } from "./state.ts";

function resolveTodoContext(context?: ResolveContext): { state: TodoMoreState; waits: readonly AskWait[] } {
	const toolSession = context?.session;
	const agentId = toolSession?.getAgentId?.() ?? undefined;
	const registered = (agentId ? (sessionOf(agentId) ?? context?.agentRegistry?.get(agentId)?.session) : undefined) as
		| Partial<TodoSession>
		| undefined
		| null;
	if (registered != null && typeof registered.getTodoPhases === "function" && registered.sessionManager !== undefined) {
		const session = registered as TodoSession;
		return {
			state: liveState(session),
			waits: branchFacts(session.sessionManager).waits,
		};
	}
	if (toolSession?.getTodoPhases && toolSession.sessionManager) {
		const manager = toolSession.sessionManager as Partial<BranchSource> & Pick<typeof toolSession.sessionManager, "getBranch">;
		const folded =
			typeof manager.getBranchView === "function" && typeof manager.getLeafId === "function"
				? branchFacts(manager as BranchSource)
				: foldBranch(manager.getBranch());
		return {
			state: joinHost(toolSession.getTodoPhases(), folded.notes),
			waits: folded.waits,
		};
	}
	throw new Error("todo:// requires an active session");
}

function textResource(url: string, content: string): InternalResource {
	return {
		url,
		content,
		contentType: "text/plain",
		size: Buffer.byteLength(content, "utf-8"),
	};
}

export const todoScheme: ProtocolHandler = {
	scheme: "todo",
	spec: {
		backing: "virtual",
		selectors: "lines",
		immutable: true,
	} satisfies SchemeSpec,

	promptDoc(): string {
		return "`todo://` / `todo://phase/<slug>` — Read current todo tree, phases, and task status.";
	},

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		if (url.search || url.hash) {
			throw new Error(`Invalid todo:// URL: ${url.href}. Use todo:// or todo://phase/<slug>.`);
		}
		const host = url.rawHost || url.hostname;
		const pathname = url.rawPathname ?? url.pathname;
		const segments = pathname.split("/").filter((segment) => segment.length > 0);
		const now = Date.now();

		if (host === "" && segments.length === 0) {
			const { state, waits } = resolveTodoContext(context);
			return textResource("todo://", formatFullView(state, now, waits));
		}

		if (host === "phase" && segments.length === 1) {
			let slug: string;
			try {
				slug = decodeURIComponent(segments[0]!);
			} catch {
				throw new Error(`Invalid phase slug in ${url.href}`);
			}
			const { state, waits } = resolveTodoContext(context);
			if (state.kind === "empty") {
				throw new Error("Todo list is empty.");
			}
			const lower = slug.toLowerCase();
			const normalized = phaseSlug(slug);
			const phase =
				state.phases.find((candidate) => candidate.name === slug || candidate.name.toLowerCase() === lower) ??
				state.phases.find((candidate) => phaseSlug(candidate.name) === normalized);
			if (phase === undefined) {
				const available = state.phases.map((candidate) => phaseSlug(candidate.name)).join(", ");
				throw new Error(`Phase "${slug}" not found. Available phases: ${available}.`);
			}
			const ids = itemDisplayIds(state.phases);
			return textResource(`todo://phase/${phaseSlug(phase.name)}`, formatPhaseView(phase, now, waits, ids));
		}

		throw new Error(`Invalid todo:// URL: ${url.href}. Use todo:// or todo://phase/<slug>.`);
	},
};
