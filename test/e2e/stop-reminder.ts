/**
 * End-to-end check for oh-my-omp/omp-todo-more#38: a main-session stop reminder
 * reaches the human as an info notification and leaves no `reminder-notice`
 * message in the session file.
 *
 * Runs the real `omp` in rpc mode with only this checkout's extension loaded,
 * asks the model to create one todo and stop without doing it, waits for the
 * stop reminder's `notify` UI request, then reads the session file.
 *
 * Usage: bun test/e2e/stop-reminder.ts
 * Models are tried in order; one that fails before the reminder is skipped.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "@oh-my-pi/pi-coding-agent";

const MODELS = ["opencode-go/deepseek-v4.1-flash", "openai-codex/gpt-6-luna", "anthropic/claude-haiku-5-5"];
const TIMEOUT_MS = 180_000;
const EXTENSION = path.resolve(import.meta.dir, "../../index.ts");
const PROMPT = [
	"Call the todo tool exactly once with this document, verbatim:",
	"*** Begin Todo",
	'INIT "Stop reminder e2e" "hello.txt exists" "File written"',
	'PHASE "Work"',
	'ADD "Write hello.txt" "Create the file with the word hello" 5',
	"*** End Todo",
	"After the tool result, reply with the single word STOP and end your turn. Do not write the file.",
].join("\n");

const responseSchema = z.object({
	type: z.literal("response"),
	id: z.string().optional(),
	command: z.string(),
	success: z.boolean(),
	error: z.string().optional(),
	data: z.unknown().optional(),
});
const notifySchema = z.object({
	type: z.literal("extension_ui_request"),
	method: z.literal("notify"),
	message: z.string(),
	notifyType: z.string().optional(),
});
const stateSchema = z.object({ sessionFile: z.string() });
const entrySchema = z.object({ customType: z.string().optional() });

type Notify = z.infer<typeof notifySchema>;
type Response = z.infer<typeof responseSchema>;
type Outcome = { kind: "notified"; notify: Notify; sessionFile: string } | { kind: "unavailable"; reason: string };

function parseLine(line: string): unknown {
	try {
		return JSON.parse(line);
	} catch {
		return undefined;
	}
}

async function runWith(model: string): Promise<Outcome> {
	const cwd = mkdtempSync(path.join(tmpdir(), "todo-more-e2e-"));
	const proc = Bun.spawn(["omp", "--mode", "rpc", "--no-extensions", "-e", EXTENSION, "--model", model], {
		cwd,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "ignore",
	});
	const pending = new Map<string, (response: Response) => void>();
	const send = (command: Record<string, unknown>) => {
		proc.stdin.write(`${JSON.stringify(command)}\n`);
		proc.stdin.flush();
	};
	const request = (command: Record<string, unknown>): Promise<Response> => {
		const { promise, resolve } = Promise.withResolvers<Response>();
		const id = crypto.randomUUID();
		pending.set(id, resolve);
		send({ ...command, id });
		return promise;
	};
	let notify: Notify | undefined;
	let failure: string | undefined;
	const done = Promise.withResolvers<void>();
	const reader = (async () => {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of proc.stdout) {
			buffer += decoder.decode(chunk, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				const value = parseLine(line);
				const response = responseSchema.safeParse(value);
				if (response.success) {
					if (response.data.id !== undefined) pending.get(response.data.id)?.(response.data);
					if (!response.data.success) {
						failure = `${response.data.command}: ${response.data.error}`;
						done.resolve();
					}
				}
				if (line.includes('"stopReason":"error"')) {
					failure = `model error: ${line.slice(0, 300)}`;
					done.resolve();
				}
				const notification = notifySchema.safeParse(value);
				if (notification.success && notification.data.message.includes("reminder")) {
					notify = notification.data;
					done.resolve();
				}
			}
		}
		done.resolve();
	})();
	const timer = setTimeout(() => {
		failure ??= "timed out waiting for the stop reminder";
		done.resolve();
	}, TIMEOUT_MS);
	try {
		send({ type: "prompt", message: PROMPT });
		await done.promise;
		if (notify === undefined) return { kind: "unavailable", reason: failure ?? "omp exited before the stop reminder" };
		await request({ type: "abort" });
		const state = stateSchema.safeParse((await request({ type: "get_state" })).data);
		if (!state.success) return { kind: "unavailable", reason: "get_state returned no sessionFile" };
		return { kind: "notified", notify, sessionFile: state.data.sessionFile };
	} finally {
		clearTimeout(timer);
		proc.kill();
		await reader.catch(() => {});
	}
}

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
	if (!condition) failures++;
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${detail === "" ? "" : ` — ${detail}`}`);
}

let outcome: Outcome = { kind: "unavailable", reason: "no model tried" };
for (const model of MODELS) {
	outcome = await runWith(model);
	if (outcome.kind === "notified") {
		console.log(`model ${model}`);
		break;
	}
	console.log(`model ${model} unavailable: ${outcome.reason}`);
}

if (outcome.kind === "notified") {
	const { notify, sessionFile } = outcome;
	console.log(`notify ${JSON.stringify({ message: notify.message, notifyType: notify.notifyType })}`);
	console.log(`session ${sessionFile}`);
	check("notify is info", notify.notifyType === "info");
	check("notify text is the reminder header", /\d+ incomplete todos? - reminder 1\/\d+/.test(notify.message), notify.message);
	const lines = (await Bun.file(sessionFile).text()).split("\n").filter((line) => line.trim() !== "");
	const customTypes = lines.map((line) => {
		const entry = entrySchema.safeParse(parseLine(line));
		return entry.success ? entry.data.customType : undefined;
	});
	const notices = customTypes.filter((type) => type === "mouriya.omp.todo-more.reminder-notice").length;
	const continuations = customTypes.filter((type) => type === "session-stop-continuation").length;
	console.log(`session entries=${lines.length} reminder-notice=${notices} session-stop-continuation=${continuations}`);
	check("session has no reminder-notice", notices === 0);
	check("session has the stop continuation", continuations >= 1);
} else {
	check("stop reminder notified", false, outcome.reason);
}
process.exit(failures === 0 ? 0 : 1);
