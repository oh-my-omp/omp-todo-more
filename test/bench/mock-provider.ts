import { appendFileSync } from "node:fs";

export const SCRIPT_MODEL = "script";
export const CHILD_MODEL = "child";
export const AUX_MODEL = "aux";
const AUX_REPLY = "ok";

export type ScriptedTurn = {
	readonly text?: string;
	readonly toolCalls?: readonly { readonly name: string; readonly arguments: Record<string, unknown> }[];
	readonly child?: true;
	readonly error?: {
		readonly status: number;
		readonly body?: string;
		readonly headers?: Record<string, string>;
		readonly repeat?: number;
	};
};

export type MockProvider = {
	readonly port: number;
	enqueue(turns: readonly ScriptedTurn[]): void;
	pending(): number;
	stop(): void;
};

type Chunk = Record<string, unknown>;

function chunk(model: string, delta: Record<string, unknown>, finish: string | null): Chunk {
	return {
		id: "chatcmpl-mock",
		object: "chat.completion.chunk",
		created: 0,
		model,
		choices: [{ index: 0, delta, finish_reason: finish }],
	};
}

function turnChunks(model: string, turn: ScriptedTurn, callPrefix: string): Chunk[] {
	const chunks: Chunk[] = [chunk(model, { role: "assistant", content: "" }, null)];
	if (turn.text !== undefined && turn.text !== "") chunks.push(chunk(model, { content: turn.text }, null));
	const calls = turn.toolCalls ?? [];
	calls.forEach((call, index) => {
		chunks.push(
			chunk(
				model,
				{
					tool_calls: [
						{
							index,
							id: `${callPrefix}_${index}`,
							type: "function",
							function: { name: call.name, arguments: JSON.stringify(call.arguments) },
						},
					],
				},
				null,
			),
		);
	});
	const last = chunk(model, {}, calls.length > 0 ? "tool_calls" : "stop");
	last.usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
	chunks.push(last);
	return chunks;
}

function completion(model: string, turn: ScriptedTurn, callPrefix: string): Record<string, unknown> {
	const calls = turn.toolCalls ?? [];
	return {
		id: "chatcmpl-mock",
		object: "chat.completion",
		created: 0,
		model,
		choices: [
			{
				index: 0,
				message: {
					role: "assistant",
					content: turn.text ?? "",
					...(calls.length > 0
						? {
								tool_calls: calls.map((call, index) => ({
									id: `${callPrefix}_${index}`,
									type: "function",
									function: { name: call.name, arguments: JSON.stringify(call.arguments) },
								})),
							}
						: {}),
				},
				finish_reason: calls.length > 0 ? "tool_calls" : "stop",
			},
		],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	};
}

function makeJitter(seed: number, maxMs: number): () => number {
	let state = seed >>> 0 || 1;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return maxMs === 0 ? 0 : (state >>> 0) % (maxMs + 1);
	};
}

export function startMockProvider(requestsFile: string): MockProvider {
	const queues = new Map<string, ScriptedTurn[]>([
		[SCRIPT_MODEL, []],
		[CHILD_MODEL, []],
	]);
	const perModel = new Map<string, number>();
	let seq = 0;
	const jitterMax = Number(process.env.OMP_PARITY_JITTER_MS ?? "0") || 0;
	let seed = 0;
	for (const ch of requestsFile) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
	seed = (seed ^ Number(process.env.OMP_PARITY_JITTER_SEED ?? "0")) >>> 0;
	const jitter = makeJitter(seed, jitterMax);
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
				return new Response("not served by the mock provider", { status: 404 });
			}
			const body: unknown = await request.json();
			const model = typeof body === "object" && body !== null && "model" in body && typeof body.model === "string" ? body.model : "";
			const stream = typeof body === "object" && body !== null && "stream" in body && body.stream === true;
			seq += 1;
			const modelSeq = (perModel.get(model) ?? 0) + 1;
			perModel.set(model, modelSeq);
			const queue = queues.get(model);
			const scripted = queue?.[0];
			let turn: ScriptedTurn;
			if (queue === undefined || scripted === undefined) turn = { text: AUX_REPLY };
			else if (scripted.error !== undefined && (scripted.error.repeat ?? 0) > 0) {
				turn = { ...scripted, error: { ...scripted.error, repeat: (scripted.error.repeat ?? 0) - 1 } };
				queue[0] = turn;
			} else {
				turn = queue.shift() ?? { text: AUX_REPLY };
			}
			const callPrefix = `call_${model}_${modelSeq}`;
			const status = turn.error?.status ?? 200;
			appendFileSync(requestsFile, `${JSON.stringify({ seq, model, scripted: scripted !== undefined, status, body })}\n`);
			if (jitterMax > 0) await Bun.sleep(jitter());
			if (turn.error !== undefined) {
				return new Response(turn.error.body ?? "", {
					status: turn.error.status,
					headers: { "content-type": "application/json", ...turn.error.headers },
				});
			}
			if (!stream) return Response.json(completion(model, turn, callPrefix));
			const lines = turnChunks(model, turn, callPrefix).map((c) => `data: ${JSON.stringify(c)}\n\n`);
			lines.push("data: [DONE]\n\n");
			return new Response(lines.join(""), { headers: { "content-type": "text/event-stream" } });
		},
	});
	return {
		port: server.port ?? 0,
		enqueue: (turns) => {
			for (const turn of turns) queues.get(turn.child === true ? CHILD_MODEL : SCRIPT_MODEL)?.push(turn);
		},
		pending: () => [...queues.values()].reduce((sum, queue) => sum + queue.length, 0),
		stop: () => {
			server.stop(true);
		},
	};
}
