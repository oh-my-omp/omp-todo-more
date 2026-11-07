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
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { branchFacts, contextBranch, POST_COMPACT_SNAPSHOT_TYPE } from "../branch.ts";
import { errorText } from "../errors.ts";
import { buildInventory, renderCtxListText, renderCtxShowText } from "./inventory.ts";

/** Custom message type of the payload placed into each request. */
const CONTEXT_MESSAGE_TYPE = "todo-more.post-compact-ctx";

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
	pi.on("context", async (event, ctx) => {
		if (ctx.agent.kind !== "main") return undefined;
		try {
			// Sampled before any `await` in this handler.
			const boundary = branchFacts(contextBranch(ctx)).compaction;
			switch (boundary.kind) {
				case "none":
					return undefined;
				case "rendered":
					return { messages: withPayload(event.messages, boundary.text) };
				case "unrendered": {
					const snapshot = await renderSnapshot(ctx);
					if (snapshot === undefined) return undefined;
					pi.appendEntry(POST_COMPACT_SNAPSHOT_TYPE, { compactionId: boundary.compactionId, text: snapshot.text });
					pi.logger.info("Post-compaction ctx attached", { compactionId: boundary.compactionId, total: snapshot.total });
					return { messages: withPayload(event.messages, snapshot.text) };
				}
				default: {
					const unreachable: never = boundary;
					return unreachable;
				}
			}
		} catch (error) {
			pi.logger.warn("Post-compaction ctx attachment failed", { error: errorText(error) });
			return undefined;
		}
	});
}
