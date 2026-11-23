import { z } from "@oh-my-pi/omptype/zod";
import { type AssistantMessage, completeSimple, type Model } from "@oh-my-pi/pi-ai";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { resolveRoleChain } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { MODEL_ROLE_IDS, roleCandidatePool } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { kindOf } from "@oh-my-pi/pi-coding-agent/judgment";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { Shell } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import { errorText } from "./errors.ts";
import { formatFullView } from "./format.ts";
import { repositoryRoot } from "./git.ts";
import { allow, reject, type Transition, type TransitionGuard, type Verdict } from "./guard.ts";
import { type Completion, locate } from "./kernel.ts";
import type { TailCheck, TailItemRule } from "./project-config.ts";

export const JUDGE_ROLES = ["omp-todo-ng", "default"] as const;

const OUTPUT_TAIL_CHARS = 4000;
const GIT_SECTION_CHARS = 4000;
const judgeEffort = (): Effort | undefined => THINKING_EFFORTS.find((effort) => effort === "low");

type ShellCheck = Extract<TailCheck, { kind: "shell" }>;
type JudgeCheck = Extract<TailCheck, { kind: "judge" }>;

export type CheckTarget = { readonly completion: Completion; readonly rule: TailItemRule; readonly check: TailCheck };

type Settings = AgentSession["settings"];
type Level = "off" | Effort;
type Candidate = { readonly model: Model; readonly level: Level | undefined };

export type JudgeReply =
	| { readonly kind: "text"; readonly text: string; readonly model: string; readonly failures: readonly string[] }
	| { readonly kind: "no-model" }
	| { readonly kind: "deadline" }
	| { readonly kind: "cancelled" }
	| { readonly kind: "all-failed"; readonly failures: readonly string[] }
	| { readonly kind: "error"; readonly error: string };

const judgeAnswerSchema = z.object({ verdict: z.enum(["pass", "fail"]), reason: z.string().trim().min(1) });

export type JudgeAnswer = z.infer<typeof judgeAnswerSchema>;

const JUDGE_SYSTEM_PROMPT = [
	"You are the acceptance judge for one todo item of a coding agent.",
	"Decide from the evidence in the user message whether the acceptance condition holds; when the evidence does not show it, it does not hold.",
	'Answer with only one JSON object and nothing else: {"verdict":"pass","reason":"…"} or {"verdict":"fail","reason":"…"}.',
	"The reason is one or two sentences naming the evidence you relied on.",
].join("\n");

function checkTarget({ planned, project }: Transition): CheckTarget | null {
	const completion = planned.completion;
	if (completion === null) return null;
	const ruleId = locate(planned.base).get(completion.id)?.item.tailRule?.ruleId;
	if (ruleId === undefined) return null;
	const rule = project.tailItems.find((candidate) => candidate.id === ruleId);
	return rule === undefined || rule.check === null ? null : { completion, rule, check: rule.check };
}

function refused({ completion, rule }: CheckTarget, why: string): Verdict {
	return reject(
		`Task ${JSON.stringify(completion.title)} (${completion.id}) stays open: the check of project rule "${rule.id}" did not pass: ${why}`,
	);
}

function outputTail(output: string): string {
	const text = output.trim();
	return text === "" ? " It printed nothing." : `\nLast output:\n${text}`;
}

export async function runShellCheck(
	target: CheckTarget,
	check: ShellCheck,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<Verdict> {
	const command = `\`${check.command}\``;
	const started = Date.now();
	let output = "";
	try {
		const result = await new Shell().run({ command: check.command, cwd, timeoutMs: check.timeoutMs, signal }, (error, chunk) => {
			if (error === null) output = (output + chunk).slice(-OUTPUT_TAIL_CHARS);
		});
		const durationMs = Date.now() - started;
		logger.info("todo-ng shell check finished", {
			rule: target.rule.id,
			command: check.command,
			cwd,
			exitCode: result.exitCode,
			timedOut: result.timedOut,
			cancelled: result.cancelled,
			durationMs,
		});
		if (result.timedOut) return refused(target, `${command} timed out after ${check.timeoutMs} ms in ${cwd}.${outputTail(output)}`);
		if (result.cancelled) return refused(target, `${command} was cancelled before it finished in ${cwd}.${outputTail(output)}`);
		if (result.exitCode === 0)
			return allow(`Check of project rule "${target.rule.id}" passed: ${command} exited 0 after ${durationMs} ms.`);
		return refused(target, `${command} exited with ${result.exitCode ?? "no exit status"} in ${cwd}.${outputTail(output)}`);
	} catch (error) {
		logger.warn("todo-ng shell check could not run", { rule: target.rule.id, command: check.command, cwd, error: errorText(error) });
		return refused(target, `${command} could not run in ${cwd}: ${errorText(error)}`);
	}
}

export function parseJudgeAnswer(text: string): JudgeAnswer | null {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	let value: unknown;
	try {
		value = JSON.parse(text.slice(start, end + 1));
	} catch {
		return null;
	}
	const parsed = judgeAnswerSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

export function judgeVerdict(target: CheckTarget, check: JudgeCheck, reply: JudgeReply): Verdict {
	switch (reply.kind) {
		case "text": {
			const answer = parseJudgeAnswer(reply.text);
			if (answer === null)
				return refused(
					target,
					`the judge ${reply.model} answered in a form that could not be parsed: ${JSON.stringify(reply.text.trim().slice(0, 300))}`,
				);
			if (answer.verdict === "fail") return refused(target, `the judge ${reply.model} found the condition not met: ${answer.reason}`);
			return allow(`Check of project rule "${target.rule.id}" passed: the judge ${reply.model} found the condition met: ${answer.reason}`);
		}
		case "no-model":
			return refused(target, `no online model is bound to the model role @${JUDGE_ROLES[0]} or ${JUDGE_ROLES[1]}; bind one in /model`);
		case "deadline":
			return refused(target, `the judge did not answer within ${check.timeoutMs} ms`);
		case "cancelled":
			return refused(target, "the judge was cancelled before it answered");
		case "all-failed":
			return refused(target, `every judge model failed: ${reply.failures.join("; ")}`);
		case "error":
			return refused(target, `the judge could not run: ${reply.error}`);
		default: {
			const unreachable: never = reply;
			throw new Error(`unknown judge reply ${String(unreachable)}`);
		}
	}
}

const label = (model: Model): string => `${model.provider}/${model.id}`;

function textOf(content: AssistantMessage["content"]): string {
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

function candidates(settings: Settings, registry: ExtensionContext["modelRegistry"]): Candidate[] {
	const out: Candidate[] = [];
	const seen = new Set<string>();
	for (const role of JUDGE_ROLES) {
		const builtIn = MODEL_ROLE_IDS.some((id) => id === role);
		for (const candidate of resolveRoleChain(role, settings, roleCandidatePool(role, settings, registry))) {
			if (!builtIn && !candidate.explicit) continue;
			if (kindOf(candidate) !== "online") continue;
			const key = label(candidate.model);
			if (seen.has(key)) continue;
			seen.add(key);
			const level = candidate.thinkingLevel;
			out.push({ model: candidate.model, level: level === "off" ? "off" : THINKING_EFFORTS.find((effort) => effort === level) });
		}
	}
	return out;
}

async function askJudge(
	host: ExtensionContext,
	settings: Settings,
	prompt: string,
	timeoutMs: number,
	cancel: AbortSignal | undefined,
): Promise<JudgeReply> {
	const failures: string[] = [];
	const deadline = AbortSignal.timeout(timeoutMs);
	const signal = cancel === undefined ? deadline : AbortSignal.any([cancel, deadline]);
	const stopped = (): JudgeReply | null => (cancel?.aborted ? { kind: "cancelled" } : deadline.aborted ? { kind: "deadline" } : null);
	try {
		const models = candidates(settings, host.modelRegistry);
		if (models.length === 0) return { kind: "no-model" };
		for (const { model, level } of models) {
			const halt = stopped();
			if (halt !== null) return halt;
			try {
				const apiKey = host.modelRegistry.resolver(model);
				const reply = await completeSimple(
					model,
					{ systemPrompt: [JUDGE_SYSTEM_PROMPT], messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
					level === "off" ? { apiKey, disableReasoning: true, signal } : { apiKey, reasoning: level ?? judgeEffort(), signal },
				);
				switch (reply.stopReason) {
					case "stop":
						return { kind: "text", text: textOf(reply.content), model: label(model), failures };
					case "length":
					case "toolUse":
						failures.push(`${label(model)}: ${reply.stopReason}`);
						continue;
					case "error":
						failures.push(`${label(model)}: ${reply.errorMessage ?? "error"}`);
						continue;
					case "aborted":
						return stopped() ?? { kind: "all-failed", failures: [...failures, `${label(model)}: aborted`] };
					default: {
						const unreachable: never = reply.stopReason;
						throw new Error(`unknown stop reason: ${String(unreachable)}`);
					}
				}
			} catch (error) {
				const halt = stopped();
				if (halt !== null) return halt;
				failures.push(`${label(model)}: ${errorText(error)}`);
			}
		}
		return { kind: "all-failed", failures };
	} catch (error) {
		return stopped() ?? { kind: "error", error: errorText(error) };
	}
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
	const child = Bun.spawn(["git", "--no-optional-locks", "-C", cwd, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	const text = (code === 0 ? stdout : `git ${args.join(" ")} failed: ${stderr}`).trim();
	return text === "" ? "(none)" : text.slice(0, GIT_SECTION_CHARS);
}

async function gitSummary(cwd: string): Promise<string> {
	const root = repositoryRoot(cwd);
	if (root === null) return `${cwd} is not in a git repository.`;
	const [status, diff, log] = await Promise.all([
		git(cwd, ["status", "--short"]),
		git(cwd, ["diff", "--stat", "HEAD"]),
		git(cwd, ["log", "--oneline", "-5"]),
	]);
	return [
		`Repository: ${root}`,
		`Uncommitted changes (git status --short):\n${status}`,
		`Diff against HEAD (git diff --stat HEAD):\n${diff}`,
		`Recent commits:\n${log}`,
	].join("\n\n");
}

async function judgePrompt({ completion, rule }: CheckTarget, check: JudgeCheck, transition: Transition, cwd: string): Promise<string> {
	return [
		`Acceptance condition:\n${check.prompt}`,
		`Todo item being completed: ${JSON.stringify(completion.title)} (${completion.id}), appended by project rule "${rule.id}". Its detail: ${rule.detail}`,
		`Todo list before this completion:\n${formatFullView(transition.planned.base, Date.now())}`,
		`Git state:\n${await gitSummary(cwd)}`,
	].join("\n\n");
}

async function runJudgeCheck(target: CheckTarget, check: JudgeCheck, transition: Transition, settings: Settings): Promise<Verdict> {
	const host = transition.host;
	if (host === undefined) return judgeVerdict(target, check, { kind: "error", error: "this todo call carries no extension context" });
	const cwd = transition.session.sessionManager.getCwd();
	const started = Date.now();
	const reply = await askJudge(host, settings, await judgePrompt(target, check, transition, cwd), check.timeoutMs, transition.signal);
	logger.info("todo-ng judge check finished", {
		rule: target.rule.id,
		outcome: reply.kind,
		model: reply.kind === "text" ? reply.model : undefined,
		failures: reply.kind === "text" || reply.kind === "all-failed" ? reply.failures : undefined,
		durationMs: Date.now() - started,
	});
	return judgeVerdict(target, check, reply);
}

export function acceptanceGuard(settings: Settings): TransitionGuard {
	return {
		name: "acceptance",
		run: (transition) => {
			const target = checkTarget(transition);
			if (target === null) return allow();
			const { check } = target;
			switch (check.kind) {
				case "shell":
					return runShellCheck(target, check, transition.session.sessionManager.getCwd(), transition.signal);
				case "judge":
					return runJudgeCheck(target, check, transition, settings);
				default: {
					const unreachable: never = check;
					throw new Error(`unknown check ${String(unreachable)}`);
				}
			}
		},
	};
}
