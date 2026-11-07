/**
 * Parity runner: drives a real `omp --mode rpc` session against the scripted
 * mock provider, with exactly one todo-more implementation loaded, inside a
 * throwaway root (HOME, PI_CODING_AGENT_DIR, cwd) so the machine's ~/.omp is
 * never read or written.
 *
 * Usage: bun test/parity/run.ts <baseline|candidate> <extension index.ts> <scenario name|all> <out dir>
 *
 * Writes per scenario under <out dir>/<scenario>/:
 *   requests.jsonl  every provider request body (mock-provider.ts)
 *   events.jsonl    every RPC frame omp printed
 *   session/        the session file and its subagent transcripts
 *   git.txt         `git log` with stats of the scenario's cwd (when it is a repository)
 *   git-shas.txt    the repo's commit ids, for normalizing shas into placeholders
 *   result.json     outcome and timings
 * Exit 0 when every scenario completed, 1 otherwise.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AUX_MODEL, CHILD_MODEL, SCRIPT_MODEL, startMockProvider } from "./mock-provider.ts";
import { SCENARIOS, type Scenario, type Step, type TodoSettings, type Variant } from "./scenarios.ts";

const STEP_TIMEOUT_MS = 90_000;

type Frame = Record<string, unknown>;

function isFrame(value: unknown): value is Frame {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelEntry(id: string): Frame {
	return {
		id,
		name: id,
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		contextWindow: 200_000,
		maxTokens: 4096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
	};
}

/**
 * Settings each variant runs with. The baseline replaces native todo and reads
 * reminder settings from host `todo.*`; the candidate keeps native todo on (the
 * extension silences its reminders itself) and reads todo-more's plugin settings.
 */
function variantSettings(variant: Variant, todo: TodoSettings): { config: Frame; plugin: Frame } {
	switch (variant) {
		case "baseline":
			return { config: { todo: { enabled: false, ...todo } }, plugin: {} };
		case "candidate":
			return { config: { todo: { enabled: true } }, plugin: { ...todo } };
		default: {
			const unreachable: never = variant;
			return unreachable;
		}
	}
}

function deepMerge(base: Frame, over: Frame): Frame {
	const out: Frame = { ...base };
	for (const [key, value] of Object.entries(over)) {
		const current = out[key];
		out[key] = isFrame(current) && isFrame(value) ? deepMerge(current, value) : value;
	}
	return out;
}

function prepareRoot(variant: Variant, scenario: Scenario, port: number): { root: string; env: Record<string, string>; cwd: string } {
	const root = mkdtempSync(path.join(tmpdir(), `todo-more-parity-${variant}-`));
	const home = path.join(root, "home");
	const agentDir = path.join(home, ".omp", "agent");
	const cwd = path.join(root, "work");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	writeFileSync(
		path.join(agentDir, "models.yml"),
		Bun.YAML.stringify(
			{
				providers: {
					parity: {
						baseUrl: `http://127.0.0.1:${port}/v1`,
						api: "openai-completions",
						auth: "none",
						authHeader: false,
						models: [modelEntry(SCRIPT_MODEL), modelEntry(CHILD_MODEL), modelEntry(AUX_MODEL)],
					},
				},
			},
			null,
			2,
		),
	);
	const aux = `parity/${AUX_MODEL}`;
	const settings = variantSettings(variant, scenario.todo ?? {});
	const config = deepMerge(
		deepMerge(
			{
				modelRoles: {
					default: `parity/${SCRIPT_MODEL}`,
					smol: aux,
					slow: aux,
					plan: aux,
					commit: aux,
					title: aux,
					task: `parity/${CHILD_MODEL}`,
				},
				skills: { enabled: false },
			},
			settings.config,
		),
		scenario.config ?? {},
	);
	writeFileSync(path.join(agentDir, "config.yml"), Bun.YAML.stringify(config, null, 2));
	const pluginsDir = path.join(home, ".omp", "plugins");
	mkdirSync(pluginsDir, { recursive: true });
	writeFileSync(
		path.join(pluginsDir, "omp-plugins.lock.json"),
		JSON.stringify({ plugins: {}, settings: { "omp-todo-more": settings.plugin } }, null, 2),
	);
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		HOME: home,
		PI_CODING_AGENT_DIR: agentDir,
		TMPDIR: path.join(root, "tmp"),
		OMOMP_LANG: scenario.lang ?? "en",
		GIT_AUTHOR_NAME: "parity",
		GIT_AUTHOR_EMAIL: "parity@example.invalid",
		GIT_COMMITTER_NAME: "parity",
		GIT_COMMITTER_EMAIL: "parity@example.invalid",
		GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
		GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
	};
	mkdirSync(env.TMPDIR ?? "", { recursive: true });
	return { root, env, cwd };
}

async function shell(command: string, cwd: string, env: Record<string, string>): Promise<{ code: number; out: string }> {
	const proc = Bun.spawn(["sh", "-c", command], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	return { code: await proc.exited, out: out + err };
}

type Session = {
	send(command: Frame): void;
	request(command: Frame): Promise<Frame>;
	/** Resolves on the next frame `match` accepts, or rejects after the step timeout. */
	next(match: (frame: Frame) => boolean, label: string): Promise<Frame>;
	frames: Frame[];
	close(): Promise<number>;
};

function startOmp(
	extension: string,
	cwd: string,
	env: Record<string, string>,
	eventsFile: string,
	uiReply: Scenario["ui"],
	mode: "rpc" | "rpc-ui",
	noUi: boolean,
): Session {
	const args = ["omp", "--mode", mode, "--no-extensions", "-e", extension, "--model", `parity/${SCRIPT_MODEL}`];
	if (noUi) args.push("--no-ui");
	const proc = Bun.spawn(args, {
		cwd,
		env,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const frames: Frame[] = [];
	// A waiter resolves only on frames that arrive after it was registered: a frame
	// emitted for a finished step (e.g. its late `session_settled`) must not settle
	// the next step's wait, or the runner skips that step under load.
	const waiters: { from: number; match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }[] = [];
	const pending = new Map<string, (frame: Frame) => void>();
	const send = (command: Frame): void => {
		proc.stdin.write(`${JSON.stringify(command)}\n`);
		proc.stdin.flush();
	};
	const onFrame = (frame: Frame): void => {
		frames.push(frame);
		writeFileSync(eventsFile, `${JSON.stringify(frame)}\n`, { flag: "a" });
		if (frame.type === "response" && typeof frame.id === "string") pending.get(frame.id)?.(frame);
		if (frame.type === "extension_ui_request" && typeof frame.id === "string") {
			void Promise.resolve(uiReply?.(frame)).then((reply) => {
				if (reply !== undefined) send({ type: "extension_ui_response", id: frame.id, ...reply });
			});
		}
		for (let i = waiters.length - 1; i >= 0; i--) {
			const waiter = waiters[i];
			if (waiter !== undefined && frames.length > waiter.from && waiter.match(frame)) {
				waiters.splice(i, 1);
				waiter.resolve(frame);
			}
		}
	};
	const reader = (async () => {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of proc.stdout) {
			buffer += decoder.decode(chunk, { stream: true });
			for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line === "") continue;
				try {
					const value: unknown = JSON.parse(line);
					if (isFrame(value)) onFrame(value);
				} catch {
					// A non-JSON stdout line is recorded as-is: an extension printed directly.
					onFrame({ type: "stdout", line });
				}
			}
		}
	})();
	const stderr = new Response(proc.stderr).text();
	return {
		send,
		frames,
		request(command) {
			// An in-command `id` (prompt steps pre-compute one for their settle
			// waiter) is honored so the frames echo the id the waiter matches.
			const id = typeof command.id === "string" ? command.id : crypto.randomUUID();
			const { promise, resolve } = Promise.withResolvers<Frame>();
			pending.set(id, resolve);
			send({ ...command, id });
			return promise;
		},
		next(match, label) {
			const { promise, resolve, reject } = Promise.withResolvers<Frame>();
			const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), STEP_TIMEOUT_MS);
			waiters.push({
				from: frames.length,
				match,
				resolve: (frame) => {
					clearTimeout(timer);
					resolve(frame);
				},
			});
			return promise;
		},
		async close() {
			proc.stdin.end();
			const timer = setTimeout(() => proc.kill(), 10_000);
			const code = await proc.exited;
			clearTimeout(timer);
			await reader.catch(() => {});
			writeFileSync(`${eventsFile}.stderr.txt`, await stderr);
			return code;
		},
	};
}

function field(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Frame)[key] : undefined;
}

const settled = (frame: Frame): boolean =>
	frame.type === "session_settled" || (frame.type === "prompt_result" && frame.sessionSettled === true);

/**
 * `get_entries` reply, fetched lazily: marker strings inside an rpc command resolve
 * from it. "$leaf" → the current leaf entry id; "$entry:<text>" → the id of the one
 * entry whose JSON contains <text> (exactly one match required).
 */
async function entryIndex(session: Session): Promise<{ entries: Frame[]; leafId: string | undefined }> {
	const reply = await session.request({ type: "get_entries" });
	const data = isFrame(reply.data) ? reply.data : {};
	const raw = Array.isArray(data.entries) ? data.entries : [];
	return { entries: raw.filter(isFrame), leafId: typeof data.leafId === "string" ? data.leafId : undefined };
}

function containsMarker(value: unknown): boolean {
	if (typeof value === "string") return value.startsWith("$");
	if (Array.isArray(value)) return value.some(containsMarker);
	if (isFrame(value)) return Object.values(value).some(containsMarker);
	return false;
}

async function resolveMarkers(command: Frame, session: Session): Promise<Frame> {
	if (!containsMarker(command)) return command;
	const { entries, leafId } = await entryIndex(session);
	const resolve = (value: unknown): unknown => {
		if (typeof value === "string") {
			if (value === "$leaf") {
				if (leafId === undefined) throw new Error("get_entries returned no leafId for $leaf");
				return leafId;
			}
			const marker = /^\$entry:(.+)$/s.exec(value);
			if (marker !== null) {
				const needle = marker[1]!;
				const hits = entries.filter((entry) => JSON.stringify(entry).includes(needle));
				if (hits.length !== 1) throw new Error(`marker ${JSON.stringify(needle)} matched ${hits.length} entries`);
				const id = hits[0]!.id;
				if (typeof id !== "string") throw new Error(`marker ${JSON.stringify(needle)} matched an entry without an id`);
				return id;
			}
			return value;
		}
		if (Array.isArray(value)) return value.map(resolve);
		if (isFrame(value)) {
			const out: Frame = {};
			for (const [k, v] of Object.entries(value)) out[k] = resolve(v);
			return out;
		}
		return value;
	};
	return resolve(command) as Frame;
}

async function runStep(
	step: Step,
	session: Session,
	enqueue: (turns: Step["turns"]) => void,
	cwd: string,
	env: Record<string, string>,
): Promise<void> {
	enqueue(step.turns);
	switch (step.kind) {
		case "prompt": {
			// Settle is keyed to this prompt's own `prompt_result` frame (same id as its
			// response), so a duplicate or late settlement of a finished step can never
			// satisfy this wait. The waiter registers before the send: a local-command
			// prompt can report `prompt_result` before its response frame arrives.
			// A builtin-handled message (e.g. `/todo`) reports `agentInvoked: false`
			// in the response and owes no settlement frame: that response ends the step.
			const id = crypto.randomUUID();
			let ownPromptResult = false;
			const done = session.next((frame: Frame): boolean => {
				if (frame.type === "prompt_result" && frame.id === id) {
					// Our prompt's result: settled means done; unsettled (subagent
					// background work still closing) defers to the settle frame that
					// follows this very prompt_result.
					if (frame.sessionSettled === true) return true;
					ownPromptResult = true;
					return false;
				}
				return ownPromptResult && frame.type === "session_settled";
			}, "prompt to settle (prompt_result id)");
			const reply = await session.request({ type: "prompt", message: step.text, id });
			if (field(reply.data, "agentInvoked") === false) {
				done.catch(() => {});
				return;
			}
			await done;
			return;
		}
		case "steer":
		case "follow_up": {
			// No prompt_result owes to these; settle on the session-level frames.
			await session.request({ type: step.kind, message: step.text });
			await session.next(settled, `${step.kind} to settle`);
			return;
		}
		case "rpc": {
			const done = step.settle ? session.next(settled, "rpc command to settle") : undefined;
			await session.request(await resolveMarkers(step.command, session));
			await done;
			return;
		}
		case "sleep":
			await Bun.sleep(step.ms);
			return;
		case "shell": {
			const result = await shell(step.command, cwd, env);
			if (result.code !== 0) throw new Error(`shell step failed (${result.code}): ${result.out}`);
			return;
		}
		default: {
			const unreachable: never = step;
			return unreachable;
		}
	}
}

async function runScenario(variant: Variant, extension: string, scenario: Scenario, outDir: string): Promise<boolean> {
	const dir = path.join(outDir, scenario.name);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const provider = startMockProvider(path.join(dir, "requests.jsonl"));
	const { root, env, cwd } = prepareRoot(variant, scenario, provider.port);
	const started = Date.now();
	let error: string | undefined;
	let exitCode: number | undefined;
	try {
		if (scenario.setup !== undefined) {
			const result = await shell(scenario.setup, cwd, env);
			if (result.code !== 0) throw new Error(`setup failed: ${result.out}`);
		}
		const session = startOmp(
			extension,
			cwd,
			env,
			path.join(dir, "events.jsonl"),
			scenario.ui,
			scenario.rpcUi === true ? "rpc-ui" : "rpc",
			scenario.noUi === true,
		);
		try {
			await session.next((frame) => frame.type === "ready", "ready");
			for (const step of scenario.steps) await runStep(step, session, (turns) => provider.enqueue(turns ?? []), cwd, env);
			// Let trailing asynchronous work (a custom message a slash prompt spawned,
			// a late settlement frame) land before the final state request: get_state
			// queues behind it, and a tight request can otherwise never answer.
			await Bun.sleep(500);
			const state = await session.request({ type: "get_state" });
			const data = isFrame(state.data) ? state.data : {};
			const file = typeof data.sessionFile === "string" ? data.sessionFile : undefined;
			if (file !== undefined && existsSync(file)) {
				mkdirSync(path.join(dir, "session"), { recursive: true });
				cpSync(file, path.join(dir, "session", "main.jsonl"));
				const children = file.slice(0, -".jsonl".length);
				if (existsSync(children)) cpSync(children, path.join(dir, "session", "children"), { recursive: true });
			}
		} finally {
			exitCode = await session.close();
		}
		if (existsSync(path.join(cwd, ".git"))) {
			const log = await shell("git log --format='%s%n%b' --stat && git status --short && git rev-list --all", cwd, env);
			writeFileSync(path.join(dir, "git.txt"), log.out);
			const shas = await shell("git rev-list --all", cwd, env);
			if (shas.code === 0) writeFileSync(path.join(dir, "git-shas.txt"), shas.out);
		}
	} catch (caught) {
		error = caught instanceof Error ? caught.message : String(caught);
	} finally {
		provider.stop();
		rmSync(root, { recursive: true, force: true });
	}
	const result = {
		variant,
		scenario: scenario.name,
		error: error ?? null,
		exitCode: exitCode ?? null,
		unconsumedTurns: provider.pending(),
		ms: Date.now() - started,
	};
	writeFileSync(path.join(dir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
	console.log(`${scenario.name}: ${error === undefined ? "ok" : `ERROR ${error}`} (${result.ms} ms, unconsumed ${result.unconsumedTurns})`);
	return error === undefined;
}

const [variantArg, extensionArg, which, outArg] = process.argv.slice(2);
if (
	(variantArg !== "baseline" && variantArg !== "candidate") ||
	extensionArg === undefined ||
	which === undefined ||
	outArg === undefined
) {
	console.error("usage: bun test/parity/run.ts <baseline|candidate> <extension index.ts> <scenario name|all> <out dir>");
	process.exit(2);
}
const selected = which === "all" ? SCENARIOS : SCENARIOS.filter((scenario) => which.split(",").includes(scenario.name));
if (selected.length === 0) {
	console.error(`no scenario named ${which}`);
	process.exit(2);
}
let ok = true;
for (const scenario of selected) ok = (await runScenario(variantArg, path.resolve(extensionArg), scenario, path.resolve(outArg))) && ok;
process.exit(ok ? 0 : 1);
