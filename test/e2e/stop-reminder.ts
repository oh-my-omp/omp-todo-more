import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "@oh-my-pi/omptype/zod";

const MODELS = [
	"futureppo-pool/gpt-6.2-sol",
	"futureppo-pool/gpt-6-luna",
	"futureppo-pool/nemotron-3-ultra-550b-a55b",
	"anthropic/claude-haiku-5-5",
];
const SILENCE_MS = 30_000;
const EXTENSION = path.resolve(import.meta.dir, "../../index.ts");
const PROMPT = [
	"Call the todo tool exactly once with these JSON arguments:",
	JSON.stringify({
		goal: { title: "Stop reminder e2e", summary: "hello.txt exists", acceptance: "File written" },
		add: [{ phase: "Work", title: "Write hello.txt", detail: "Create the file with the word hello", minutes: 5 }],
	}),
	"After the tool result, reply with the single word STOP and end your turn. Do not write the file.",
].join("\n");

const eventSchema = z.object({ type: z.string() });
const reminderEventSchema = z.object({
	type: z.literal("todo_reminder"),
	attempt: z.number(),
	maxAttempts: z.number(),
});
const commandOutputSchema = z.object({ type: z.literal("command_output"), text: z.string() });
const requestSchema = z.object({
	messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
});

type Reminder = z.infer<typeof reminderEventSchema>;
type Outcome =
	| { kind: "reminded"; reminder: Reminder; stopReminders: string[]; dumpFile: string }
	| { kind: "unavailable"; reason: string };

function parseLine(line: string): unknown {
	try {
		return JSON.parse(line);
	} catch {
		return undefined;
	}
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const text = z.object({ text: z.string() }).safeParse(part);
			return text.success ? text.data.text : "";
		})
		.join(" ");
}

async function runWith(model: string): Promise<Outcome> {
	const cwd = mkdtempSync(path.join(tmpdir(), "todo-ng-e2e-"));
	const proc = Bun.spawn(
		["omp", "--mode", "rpc", "--no-extensions", "-e", EXTENSION, "--model", model, "--no-rules", "--no-title", "--no-session"],
		{ cwd, env: { ...process.env, OMOMP_LANG: "en" }, stdin: "pipe", stdout: "pipe", stderr: "ignore" },
	);
	const send = (command: Record<string, unknown>) => {
		proc.stdin.write(`${JSON.stringify(command)}\n`);
		proc.stdin.flush();
	};
	let reminder: Reminder | undefined;
	let dumpText: string | undefined;
	let assistantsAfterReminder = 0;
	let aborted = false;
	let failure: string | undefined;
	const done = Promise.withResolvers<void>();
	let silence = setTimeout(() => {
		failure ??= `no output for ${SILENCE_MS / 1000}s`;
		done.resolve();
	}, SILENCE_MS);
	const reader = (async () => {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of proc.stdout) {
			clearTimeout(silence);
			silence = setTimeout(() => {
				failure ??= `no output for ${SILENCE_MS / 1000}s`;
				done.resolve();
			}, SILENCE_MS);
			buffer += decoder.decode(chunk, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				const value = parseLine(line);
				if (line.includes('"stopReason":"error"')) {
					failure = `model error: ${line.slice(0, 300)}`;
					done.resolve();
				}
				const found = reminderEventSchema.safeParse(value);
				if (found.success && reminder === undefined) reminder = found.data;
				const type = eventSchema.safeParse(value);
				if (reminder !== undefined && type.success && type.data.type === "message_end" && line.includes('"role":"assistant"')) {
					assistantsAfterReminder++;
				}
				if (reminder !== undefined && assistantsAfterReminder >= 1 && !aborted) {
					aborted = true;
					send({ type: "abort" });
					setTimeout(() => send({ type: "prompt", message: "/dump" }), 3_000);
				}
				const output = commandOutputSchema.safeParse(value);
				if (output.success) {
					dumpText = output.data.text;
					done.resolve();
				}
			}
		}
		done.resolve();
	})();
	try {
		send({ type: "prompt", message: PROMPT });
		await done.promise;
		if (reminder === undefined) return { kind: "unavailable", reason: failure ?? "omp exited before the host stop reminder" };
		if (dumpText === undefined) return { kind: "unavailable", reason: failure ?? "omp returned no /dump output" };
		const dumpFile = /^LLM request JSON: (.+)$/m.exec(dumpText)?.[1];
		if (dumpFile === undefined) return { kind: "unavailable", reason: "/dump named no LLM request file" };
		const request = requestSchema.safeParse(parseLine(readFileSync(dumpFile, "utf8")));
		if (!request.success) return { kind: "unavailable", reason: "/dump request file is not a message list" };
		const stopReminders = request.data.messages
			.filter((message) => message.role === "developer")
			.map((message) => textOf(message.content))
			.filter((text) => text.includes("You stopped with"));
		return { kind: "reminded", reminder, stopReminders, dumpFile };
	} finally {
		clearTimeout(silence);
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
	if (outcome.kind === "reminded") {
		console.log(`model ${model}`);
		break;
	}
	console.log(`model ${model} unavailable: ${outcome.reason}`);
}

if (outcome.kind === "reminded") {
	const { reminder, stopReminders, dumpFile } = outcome;
	console.log(`host todo_reminder ${JSON.stringify({ attempt: reminder.attempt, maxAttempts: reminder.maxAttempts })}`);
	console.log(`llm request ${dumpFile}`);
	console.log(`stop reminders in the request: ${stopReminders.length}`);
	check("host timed the reminder (todo_reminder attempt 1)", reminder.attempt === 1);
	const first = stopReminders[0] ?? "";
	check("request carries a stop reminder", stopReminders.length >= 1);
	check(
		"reminder lists the open item with its explanation",
		first.includes("Write hello.txt") && first.includes("Create the file with the word hello"),
	);
	check(
		"reminder carries current time and converted target completion time",
		first.includes("Current time:") && first.includes("due by ") && !first.includes("Estimate:"),
	);
	check("reminder carries the goal", first.includes("Objective: Stop reminder e2e"));
	check("reminder is numbered by the host's cap", new RegExp(`\\(Reminder 1/${reminder.maxAttempts}\\)`).test(first), first.slice(-80));
} else {
	check("host stop reminder reached the model", false, outcome.reason);
}
process.exit(failures === 0 ? 0 : 1);
