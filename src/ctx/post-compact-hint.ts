/**
 * Post-compaction hint: after a compaction boundary, every model call of
 * the main session carries the rendered `ctx list` output plus the main
 * session's `ctx show` (handoff + goal + per-task timeline), so the model
 * sees pre-compaction context without spending tool calls to fetch it.
 *
 * Rationale. Compaction replaces the working transcript with a short
 * digest. Per-context handoff, task log, and subagent history stay on
 * disk and are exactly what `ctx list` and `ctx show` surface. Nudging
 * the model to call them costs round trips and is easy to skip; this
 * plugin builds one ctx inventory and renders it through the tool's own
 * helpers (`renderCtxListText`, `renderCtxShowText`), so list and show
 * describe the same snapshot.
 *
 * Delivery. The payload is context, not a message: sending it as a user
 * message starts a model turn of its own (idle) or lands after the final
 * answer (queued steer), and the model then repeats that answer. Instead
 * the `context` hook places it right after the compaction summary in each
 * request. The snapshot is rendered on the first request after a
 * compaction and persisted as a custom session entry keyed by the
 * compaction entry id, so the payload stays byte-identical for every later
 * request until the next compaction, and survives resume.
 *
 * Scope. Main session only, mirroring tool-policy-nag: subagents run
 * short, decomposed slices and do not benefit from a post-compaction
 * ctx dump.
 */

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type ExtensionAPI, type ExtensionContext, type SessionEntry, z } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../errors.ts";
import { buildInventory, renderCtxListText, renderCtxShowText } from "./inventory.ts";

/** Custom session entry holding one compaction's rendered snapshot; never sent to the model itself. */
const SNAPSHOT_ENTRY_TYPE = "todo-more.post-compact-ctx";
/** Custom message type of the payload placed into each request. */
const CONTEXT_MESSAGE_TYPE = "todo-more.post-compact-ctx";

const snapshotSchema = z.object({ compactionId: z.string(), text: z.string() });

type MessagePayload = {
	readonly listText: string;
	readonly total: number;
	readonly showText: string | undefined;
	readonly showId: string | undefined;
};

const buildMessage = (payload: MessagePayload): string => {
	// Delimited block so the model treats the payload as an
	// auto-attached artifact, not as a fresh user instruction that
	// must be acted on.
	const { listText, total, showText, showId } = payload;
	const lines: string[] = [
		"<post-compact-ctx>",
		`Auto-attached after compaction. Same output as \`ctx list\` (${total} context(s)).`,
		"Sibling contexts: `ctx show <id>` for their handoff + goal + per-task timeline;",
		"read `history://<id>` only when the timeline is not enough.",
		"",
		"## List",
		"",
		listText,
	];
	if (showText !== undefined) {
		lines.push("", `## Current session (\`ctx show ${showId ?? ""}\`)`.trimEnd(), "", showText);
	}
	lines.push("</post-compact-ctx>");
	return lines.join("\n");
};

/** The latest compaction on the branch and the snapshot recorded for it, if any. */
type BoundaryState =
	| { readonly kind: "none" }
	| { readonly kind: "unrendered"; readonly compactionId: string }
	| { readonly kind: "rendered"; readonly compactionId: string; readonly text: string };

/**
 * Backward scan over `branch[from..end)`; returns early at the first
 * compaction. `state` is fully decided by the scanned range when defined;
 * `snapshot` is the latest valid snapshot entry inside the range.
 */
function scanBranch(
	branch: readonly SessionEntry[],
	from: number,
): { readonly state: BoundaryState | undefined; readonly snapshot: { readonly compactionId: string; readonly text: string } | undefined } {
	let snapshot: { compactionId: string; text: string } | undefined;
	for (let index = branch.length - 1; index >= from; index--) {
		const entry = branch[index];
		if (entry === undefined) continue;
		if (entry.type === "compaction") {
			if (snapshot?.compactionId === entry.id)
				return { state: { kind: "rendered", compactionId: entry.id, text: snapshot.text }, snapshot };
			return { state: { kind: "unrendered", compactionId: entry.id }, snapshot };
		}
		if (snapshot === undefined && entry.type === "custom" && entry.customType === SNAPSHOT_ENTRY_TYPE) {
			const parsed = snapshotSchema.safeParse(entry.data);
			if (parsed.success) snapshot = parsed.data;
		}
	}
	return { state: undefined, snapshot };
}

/**
 * Boundary state from the suffix `[from, end)` plus `previous`, the state of
 * the prefix `[0, from)`. Equivalent to scanning the whole branch: a
 * compaction in the suffix decides alone; otherwise the suffix contributes
 * only its latest valid snapshot against the prefix's latest compaction.
 */
function boundaryState(branch: readonly SessionEntry[], from: number, previous: BoundaryState | undefined): BoundaryState {
	const scan = scanBranch(branch, from);
	if (scan.state !== undefined) return scan.state;
	if (previous === undefined || previous.kind === "none") return { kind: "none" };
	if (scan.snapshot === undefined) return previous;
	if (scan.snapshot.compactionId === previous.compactionId)
		return { kind: "rendered", compactionId: previous.compactionId, text: scan.snapshot.text };
	return { kind: "unrendered", compactionId: previous.compactionId };
}

/** `SessionManager.getBranchView()` exists on the concrete manager but the `ReadonlySessionManager` pick exposed to extensions omits it. */
type BranchViewSource = {
	getBranchView(): readonly SessionEntry[];
};

async function renderSnapshot(ctx: ExtensionContext): Promise<{ text: string; total: number } | undefined> {
	const inventory = await buildInventory(ctx);
	const list = await renderCtxListText(inventory);
	if (!list) return undefined;
	const show = await renderCtxShowText(inventory);
	const text = buildMessage({ listText: list.text, total: list.total, showText: show?.text, showId: show?.id });
	return { text, total: list.total };
}

/** `messages` with the payload placed right after the last compaction summary (start of the list when none). */
function withPayload(messages: AgentMessage[], text: string): AgentMessage[] {
	const payload: AgentMessage = {
		role: "custom",
		customType: CONTEXT_MESSAGE_TYPE,
		content: text,
		display: false,
		attribution: "agent",
		timestamp: 0,
	};
	const at = messages.findLastIndex((message) => message.role === "compactionSummary") + 1;
	return [...messages.slice(0, at), payload, ...messages.slice(at)];
}

export function registerPostCompactHint(pi: ExtensionAPI): void {
	// The only cross-call memory (contract §7): where the last read ended on
	// the branch — session id, leaf id and length — plus the BoundaryState
	// derived at that position. It is not a cached result keyed by input:
	// every call still derives state, the offset only bounds the scan.
	let offset: { sessionId: string; leafId: string | null; length: number; state: BoundaryState } | undefined;
	pi.on("session_shutdown", (_event, ctx) => {
		if (offset?.sessionId === ctx.sessionManager.getSessionId()) offset = undefined;
	});
	pi.on("context", async (event, ctx) => {
		if (ctx.agent.kind !== "main") return undefined;
		try {
			const sessionManager = ctx.sessionManager;
			// Read-only path: §6 requires the zero-copy view. The view is the
			// manager's live array, so length and the ancestor probe below are
			// sampled before any `await` in this handler.
			const view = (sessionManager as unknown as BranchViewSource).getBranchView();
			const sessionId = sessionManager.getSessionId();
			const leafId = sessionManager.getLeafId();
			const previous = offset;
			let state: BoundaryState;
			if (previous !== undefined && previous.sessionId === sessionId && view.length === previous.length && leafId === previous.leafId) {
				// Unchanged branch (same leaf): reuse the derived state, no reads.
				state = previous.state;
			} else if (
				previous !== undefined &&
				previous.sessionId === sessionId &&
				view.length > previous.length &&
				(previous.length === 0 || view[previous.length - 1]?.id === previous.leafId)
			) {
				// Old leaf is an ancestor of the new leaf: same prefix, scan the
				// appended suffix only (one probe read for the ancestor check).
				state = boundaryState(view, previous.length, previous.state);
			} else {
				// Session switch, branch/tree navigation, or a non-append change:
				// full re-derivation.
				state = boundaryState(view, 0, undefined);
			}
			offset = { sessionId, leafId, length: view.length, state };
			switch (state.kind) {
				case "none":
					return undefined;
				case "rendered":
					return { messages: withPayload(event.messages, state.text) };
				case "unrendered": {
					const snapshot = await renderSnapshot(ctx);
					if (snapshot === undefined) return undefined;
					pi.appendEntry(SNAPSHOT_ENTRY_TYPE, { compactionId: state.compactionId, text: snapshot.text });
					pi.logger.info("Post-compaction ctx attached", { compactionId: state.compactionId, total: snapshot.total });
					return { messages: withPayload(event.messages, snapshot.text) };
				}
				default: {
					const unreachable: never = state;
					return unreachable;
				}
			}
		} catch (error) {
			pi.logger.warn("Post-compaction ctx attachment failed", { error: errorText(error) });
			return undefined;
		}
	});
}
