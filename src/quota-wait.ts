/**
 * When a main-session cut-off reminder may go out (`reminders.ts`, `armCutOff`).
 *
 * An account usage-limit 429 (`isUsageLimitOutcome`) is not retried by omp once
 * the provider's wait exceeds `retry.maxDelayMs`, and a reminder sent before the
 * account resets only hits the same 429 again. Such a stop waits until one
 * minute past the reset: the provider's own hint (`extractRetryHint`) when the
 * error carries one, otherwise omp's estimate for the classified reason
 * (`calculateRateLimitBackoffMs`, 30 min for an exhausted quota). Every other
 * cut-off stop keeps the short grace window.
 */
import { type AssistantMessage, calculateRateLimitBackoffMs, isUsageLimitOutcome, parseRateLimitReason } from "@oh-my-pi/pi-ai";
import { extractRetryHint } from "@oh-my-pi/pi-utils";
import { tr } from "./i18n.ts";

/** Margin after the account reset before the reminder is sent. */
export const QUOTA_RESET_MARGIN_MS = 60_000;

/** How the account reset time is known. */
export type QuotaResetSource = "hint" | "estimate";

/** Account usage-limit stop: the reminder waits until `resetAt` plus the margin. */
export type QuotaWait = { readonly kind: "quota"; readonly resetAt: number; readonly source: QuotaResetSource };

/** The wait before a cut-off reminder: the plain grace window, or past an account reset. */
export type CutOffWait = { readonly kind: "grace" } | QuotaWait;

const GRACE: CutOffWait = { kind: "grace" };

/** The wait for a cut-off stop that settled on `message` at wall-clock `now`. */
export function cutOffWait(message: AssistantMessage, now: number): CutOffWait {
	const errorMessage = message.errorMessage;
	if (message.stopReason !== "error" || message.errorStatus !== 429 || errorMessage === undefined) return GRACE;
	if (!isUsageLimitOutcome(429, errorMessage)) return GRACE;
	// The hint is the remaining time as of this call, so it is added to `now`, not to the message timestamp.
	const hint = extractRetryHint(undefined, errorMessage);
	return hint === undefined
		? { kind: "quota", resetAt: now + calculateRateLimitBackoffMs(parseRateLimitReason(errorMessage)), source: "estimate" }
		: { kind: "quota", resetAt: now + hint, source: "hint" };
}

/** The wall-clock time the reminder is due. */
export const quotaDeadline = (wait: QuotaWait): number => wait.resetAt + QUOTA_RESET_MARGIN_MS;

/** Local `HH:MM`. */
function clock(ms: number): string {
	const date = new Date(ms);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** The single-line notice shown above the editor while the reminder waits. */
export function quotaNoticeLine(wait: QuotaWait, cancelKey: string, cancelCommand: string): string {
	const reason =
		wait.source === "hint"
			? tr(`account quota 429, resets ${clock(wait.resetAt)}`, `账户配额 429，将于 ${clock(wait.resetAt)} 重置`)
			: tr(`account quota 429, reset estimated ${clock(wait.resetAt)}`, `账户配额 429，预计于 ${clock(wait.resetAt)} 重置`);
	return tr(
		`Todo reminder scheduled for ${clock(quotaDeadline(wait))} (${reason}) · ${cancelKey} or /${cancelCommand} to cancel`,
		`待办提醒计划于 ${clock(quotaDeadline(wait))} 发送（${reason}）· 按 ${cancelKey} 或 /${cancelCommand} 取消`,
	);
}
