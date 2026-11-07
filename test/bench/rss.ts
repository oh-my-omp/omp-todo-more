/**
 * Real-process RSS for the #24 tree (oh-my-omp/omp-todo-more#32, row 3): one
 * `omp -p --continue` model call on a session of §4 shape, the checkout's
 * extension loaded alone, peak resident set size from `/usr/bin/time -l`.
 *
 * Everything runs in a throwaway root (HOME, PI_CODING_AGENT_DIR,
 * --session-dir, cwd) against the parity mock provider, which answers every
 * request with "ok"; the machine's ~/.omp is never read or written.
 * `--variant baseline` runs with `todo.enabled: false` (what 0.1.32 needs),
 * `candidate` with the default `true`.
 *
 *   bun test/bench/rss.ts --src <checkout> --variant <baseline|candidate> [--entries 5000] [--runs 5]
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SCRIPT_MODEL, startMockProvider } from "../parity/mock-provider.ts";
import { fillBranch } from "../ui-fixture.ts";

const args = new Map<string, string>();
for (let i = 2; i < Bun.argv.length; i += 2) args.set(Bun.argv[i] ?? "", Bun.argv[i + 1] ?? "");
const src = path.resolve(args.get("--src") ?? path.join(import.meta.dir, "../.."));
const variant = args.get("--variant");
if (variant !== "baseline" && variant !== "candidate") throw new Error("--variant baseline|candidate");
const entries = Number(args.get("--entries") ?? "5000");
const runs = Number(args.get("--runs") ?? "5");

const root = mkdtempSync(path.join(tmpdir(), "todo-more-rss-"));
const home = path.join(root, "home");
const agentDir = path.join(home, ".omp", "agent");
const sessionDir = path.join(root, "sessions");
const cwd = path.join(root, "work");
for (const dir of [agentDir, sessionDir, cwd, path.join(root, "tmp")]) mkdirSync(dir, { recursive: true });

const provider = startMockProvider(path.join(root, "requests.jsonl"));
try {
	const model = {
		id: SCRIPT_MODEL,
		name: SCRIPT_MODEL,
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 4096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
	};
	writeFileSync(
		path.join(agentDir, "models.yml"),
		Bun.YAML.stringify({
			providers: {
				parity: {
					baseUrl: `http://127.0.0.1:${provider.port}/v1`,
					api: "openai-completions",
					auth: "none",
					authHeader: false,
					models: [model],
				},
			},
		}),
	);
	const role = `parity/${SCRIPT_MODEL}`;
	writeFileSync(
		path.join(agentDir, "config.yml"),
		Bun.YAML.stringify({
			modelRoles: { default: role, smol: role, slow: role, plan: role, commit: role, title: role, task: role },
			skills: { enabled: false },
			todo: { enabled: variant === "candidate" },
		}),
	);
	const manager = SessionManager.create(cwd, sessionDir);
	fillBranch(manager, entries);
	await manager.flush();

	const env = { PATH: process.env.PATH ?? "", HOME: home, PI_CODING_AGENT_DIR: agentDir, TMPDIR: path.join(root, "tmp"), OMOMP_LANG: "en" };
	const peaks: number[] = [];
	for (let i = 0; i < runs; i++) {
		const proc = Bun.spawn(
			[
				"/usr/bin/time",
				"-l",
				"omp",
				"-p",
				"--continue",
				"--session-dir",
				sessionDir,
				"--no-extensions",
				"-e",
				path.join(src, "index.ts"),
				"--model",
				role,
				"Say ok.",
			],
			{ cwd, env, stdout: "pipe", stderr: "pipe" },
		);
		const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		const code = await proc.exited;
		const rss = /(\d+)\s+maximum resident set size/.exec(err)?.[1];
		if (code !== 0 || rss === undefined) throw new Error(`omp run failed (${code}): ${out}\n${err}`);
		peaks.push(Number(rss));
	}
	peaks.sort((a, b) => a - b);
	const mib = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1);
	console.log(
		`${variant} ${src} entries=${entries} runs=${runs} peak RSS MiB: median ${mib(peaks[Math.floor(runs / 2)] ?? 0)} [${peaks.map(mib).join(", ")}]`,
	);
} finally {
	provider.stop();
	rmSync(root, { recursive: true, force: true });
}
