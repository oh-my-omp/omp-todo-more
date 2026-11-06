/**
 * ctx: read-only context recall. Registers the `ctx` tool and the post-compaction
 * hint (a `context` hook) that share its inventory and renderers. Registration
 * does no I/O. Requests read the agent registry, session transcripts, sidecar
 * summaries and local://task-log/<agent-id>.md; this module writes no files, and
 * the hint records one snapshot entry per compaction in the session. The tool
 * serves main and sub sessions; the hint runs only for the main session. Tool
 * errors reach the caller; hint failures are logged.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerCtxTool } from "./inventory.ts";
import { registerPostCompactHint } from "./post-compact-hint.ts";

export function registerCtx(pi: ExtensionAPI): void {
	registerCtxTool(pi);
	registerPostCompactHint(pi);
}
