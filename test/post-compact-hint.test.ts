/**
 * Behavior regression for the post-compact-hint bounded read
 * (oh-my-omp/omp-todo-more#27): the offset/suffix-scan derivation must be
 * indistinguishable from the pre-fix full-scan derivation — same returned
 * messages, same appended snapshot entries, step by step.
 */

import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	appendCompactionWithSnapshot,
	type Fixture,
	fillBranch,
	fixture,
	messageEntry,
	referenceCall,
	SNAPSHOT_ENTRY_TYPE,
} from "./post-compact-hint-fixture.ts";

const DIR = "/tmp/pch-test";

function messagesOf(fx: Fixture): AgentMessage[] {
	const messages: AgentMessage[] = [];
	if (fx.raw.getBranchView().some((entry) => entry.type === "compaction")) {
		messages.push({ role: "compactionSummary", summary: "compacted", tokensBefore: 100_000, timestamp: 0 } as AgentMessage);
	}
	messages.push({ role: "user", content: [{ type: "text", text: "step" }], timestamp: 0 } as AgentMessage);
	return messages;
}

/** Deterministic PRNG (mulberry32). */
function prng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const SNAPSHOT_TEXT = "<post-compact-ctx>\nsynthetic rendered snapshot\n</post-compact-ctx>";

/**
 * Compare the observable outcome: handler result equals the reference, and
 * when it renders a snapshot the appended entry matches it byte-for-byte.
 * The unrendered arm is unobservable for the reference (it cannot re-render),
 * so a payload is checked structurally and the next call must match.
 */
async function step(fx: Fixture, random: () => number): Promise<void> {
	const roll = random();
	if (roll < 0.05) {
		fx.raw.appendCompaction("summary", undefined, fx.raw.getLeafId() ?? "", 100_000);
	} else if (roll < 0.12) {
		// Snapshot entry: sometimes for the latest compaction, sometimes a
		// foreign or malformed one — the combine rules must match exactly.
		const latest = fx.raw.getBranchView().findLast((entry) => entry.type === "compaction");
		const data =
			latest !== undefined && random() < 0.7
				? { compactionId: latest.id, text: `${SNAPSHOT_TEXT}${Math.floor(random() * 1000)}` }
				: random() < 0.5
					? { compactionId: "foreign-id", text: "other" }
					: { wrong: true };
		fx.raw.appendCustomEntry(SNAPSHOT_ENTRY_TYPE, data);
	} else if (roll < 0.15) {
		// Branch off mid-history: navigation forces re-derivation.
		const view = fx.raw.getBranchView();
		const back = Math.max(1, Math.floor(random() * Math.min(view.length, 50)));
		fx.raw.branchWithSummary(view.at(-back)?.id ?? null, "sibling");
	} else {
		const n = 1 + Math.floor(random() * 7);
		for (let i = 0; i < n; i++) messageEntry(fx.raw, Math.floor(random() * 1_000_000));
	}
	const messages = messagesOf(fx);
	const event = { type: "context" as const, messages };
	const reference = referenceCall(fx, event);
	const before = fx.raw.getBranchView().length;
	const result = await fx.call(messages);
	const appended = fx.raw.getBranchView().slice(before);
	if (reference !== undefined || result === undefined) {
		expect(result).toEqual(reference);
	} else {
		// Reference says unrendered (undefined); the real handler rendered.
		// One snapshot entry, keyed by the latest compaction, payload after it.
		expect(appended.filter((entry) => entry.type === "custom" && entry.customType === SNAPSHOT_ENTRY_TYPE)).toHaveLength(1);
		const summaryAt = (result?.messages ?? []).findIndex((message) => message.role === "compactionSummary");
		const payloadAt = (result?.messages ?? []).findIndex((message) => message.role === "custom");
		expect(payloadAt).toBe(summaryAt + 1);
	}
}

describe("post-compact-hint bounded read", () => {
	test("incremental derivation equals full-scan reference on a randomized branch", async () => {
		const fx = fixture(`${DIR}/randomized`);
		fillBranch(fx.raw, 2_000);
		const random = prng(0x27);
		for (let stepIndex = 0; stepIndex < 300; stepIndex++) await step(fx, random);
		expect(fx.warnings.filter((warning) => !warning.includes("Post-compaction ctx attachment failed"))).toEqual([]);
	});

	test("an unchanged branch is served with zero entry reads", async () => {
		const fx = fixture(`${DIR}/unchanged`);
		fillBranch(fx.raw, 500);
		await fx.call();
		const messages = messagesOf(fx);
		const reference = referenceCall(fx, { type: "context", messages });
		fx.resetCounters();
		const result = await fx.call(messages);
		expect(fx.counters).toEqual({ reads: 0, copies: 0 });
		expect(result).toEqual(reference);
	});

	test("a session switch re-derives on the new session's branch", async () => {
		const fxA = fixture(`${DIR}/switch-a`);
		const fxB = fixture(`${DIR}/switch-b`);
		// Same registered module? No — each fixture registers its own pi; the
		// sessionId discriminator is what matters, verified on real ids.
		fillBranch(fxA.raw, 500);
		fillBranch(fxB.raw, 300);
		appendCompactionWithSnapshot(fxB.raw);
		expect(fxA.raw.getSessionId()).not.toBe(fxB.raw.getSessionId());
		await fxA.call();
		const messages = messagesOf(fxB);
		const reference = referenceCall(fxB, { type: "context", messages });
		const result = await fxB.call(messages);
		expect(result).toEqual(reference);
	});

	test("rendered payloads stay byte-identical across an appended suffix", async () => {
		const fx = fixture(`${DIR}/rendered-tail`);
		fillBranch(fx.raw, 500);
		appendCompactionWithSnapshot(fx.raw);
		const messages = messagesOf(fx);
		const first = await fx.call(messages);
		for (let i = 0; i < 50; i++) messageEntry(fx.raw, i);
		const messages2 = messagesOf(fx);
		const reference = referenceCall(fx, { type: "context", messages: messages2 });
		const second = await fx.call(messages2);
		expect(second).toEqual(reference);
		expect(second?.messages?.filter((m) => m.role === "custom")).toEqual(first?.messages?.filter((m) => m.role === "custom"));
	});
});
