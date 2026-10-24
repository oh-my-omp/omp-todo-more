import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { cutOffWait, QUOTA_RESET_MARGIN_MS, quotaDeadline } from "../src/quota-wait.ts";

const NOW = Date.UTC(2026, 9, 24, 14, 12, 44);

/** A settled main-session error stop, as the host hands it to `agent_end`. */
function errorStop(errorStatus: number | undefined, errorMessage: string | undefined): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "stub",
		model: "stub-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorStatus,
		errorMessage,
		timestamp: NOW,
	};
}

describe("the wait before a cut-off reminder", () => {
	test("an account quota 429 with a reset hint waits until a minute past that reset", () => {
		const wait = cutOffWait(errorStop(429, "429 You exceeded your current quota. Please retry in 360s."), NOW);
		expect(wait).toEqual({ kind: "quota", resetAt: NOW + 360_000, source: "hint" });
		if (wait.kind !== "quota") throw new Error("expected a quota wait");
		expect(quotaDeadline(wait)).toBe(NOW + 360_000 + QUOTA_RESET_MARGIN_MS);
	});

	test("an account quota 429 without a hint waits for omp's 30-minute quota estimate", () => {
		const wait = cutOffWait(errorStop(429, "429 You exceeded your current quota, please check your plan and billing details."), NOW);
		expect(wait).toEqual({ kind: "quota", resetAt: NOW + 30 * 60_000, source: "estimate" });
	});

	test("a Google RESOURCE_EXHAUSTED quota body takes the provider's retry delay", () => {
		const body = JSON.stringify({
			error: {
				code: 429,
				status: "RESOURCE_EXHAUSTED",
				message: "Individual quota reached. Resets in 30m52s.",
				details: [
					{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "QUOTA_EXHAUSTED" },
					{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "1852.47s" },
				],
			},
		});
		const wait = cutOffWait(errorStop(429, `Cloud Code Assist API error (429): ${body}`), NOW);
		expect(wait.kind).toBe("quota");
		if (wait.kind !== "quota") throw new Error("expected a quota wait");
		expect(wait.source).toBe("hint");
		expect(wait.resetAt).toBeGreaterThanOrEqual(NOW + 1_852_000);
	});

	test("a per-minute rate limit 429 keeps the grace window", () => {
		expect(cutOffWait(errorStop(429, "429 Rate limit reached for requests. Please try again in 600s."), NOW)).toEqual({ kind: "grace" });
	});

	test("quota wording on another status, or a 429 without a message, keeps the grace window", () => {
		expect(cutOffWait(errorStop(402, "You exceeded your current quota. Please retry in 360s."), NOW)).toEqual({ kind: "grace" });
		expect(cutOffWait(errorStop(429, undefined), NOW)).toEqual({ kind: "grace" });
	});
});
