/** Tern owns registration and installation; local reads verify its published normal-copy representation. */
import { execFile } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, type Stats } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "./errors.ts";
import { tr } from "./i18n.ts";

const ID = "omp-todo-more";
const BUNDLE_DIR = fileURLToPath(new URL("../tern/", import.meta.url));
const FILES = ["plugin.toml", "todo-more.css", "window.luau"] as const;
const CLI_TIMEOUT_MS = 75_000;
const absolutePath = z.string().refine(isAbsolute, "must be an absolute path");
const directorySchema = z.object({ dir: absolutePath });
const installedSchema = z.object({ id: z.string(), version: z.string(), dir: absolutePath });
const catalogSchema = z.object({
	plugins: z.array(
		z.object({
			id: z.string(),
			version: z.string(),
			css: z.string(),
			status: z.union([z.enum(["ready", "disabled"]), z.object({ failed: z.string() })]),
		}),
	),
});
type Catalog = z.infer<typeof catalogSchema>;
type Bundle = { version: string; manifest: string; css: string; window: string };
type CliResult = { kind: "ok"; stdout: string } | { kind: "failed"; message: string };

function runTern(tern: string, args: string[]): Promise<CliResult> {
	const { promise, resolve: done } = Promise.withResolvers<CliResult>();
	execFile(
		tern,
		["plugin", ...args],
		{ timeout: CLI_TIMEOUT_MS, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
		(error, stdout, stderr) => {
			done(
				error
					? {
							kind: "failed",
							message: tr(
								`tern plugin ${args.join(" ")} failed (${error.code ?? "unknown"}): ${stderr || error.message}`,
								`tern 插件 ${args.join(" ")} 失败（${error.code ?? "unknown"}）：${stderr || error.message}`,
							),
						}
					: { kind: "ok", stdout },
			);
		},
	);
	return promise;
}

async function ownerReply(tern: string, args: string[]): Promise<unknown> {
	const result = await runTern(tern, args);
	if (result.kind === "failed") throw new Error(result.message);
	try {
		return JSON.parse(result.stdout);
	} catch (error) {
		throw new Error(
			tr(
				`tern plugin ${args.join(" ")} returned invalid JSON: ${errorText(error)}`,
				`tern 插件 ${args.join(" ")} 返回了无效 JSON：${errorText(error)}`,
			),
		);
	}
}

function statEntry(path: string): Stats | undefined {
	try {
		return lstatSync(path);
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

function readBundle(): Bundle {
	const manifest = readFileSync(join(BUNDLE_DIR, "plugin.toml"), "utf8");
	const version = /^version\s*=\s*"([^"]+)"\s*$/m.exec(manifest)?.[1];
	if (version === undefined || !/^id\s*=\s*"omp-todo-more"\s*$/m.test(manifest))
		throw new Error(tr("Bundled Tern manifest has invalid identity/version.", "内置 Tern 清单的身份或版本无效。"));
	return {
		version,
		manifest,
		css: readFileSync(join(BUNDLE_DIR, "todo-more.css"), "utf8"),
		window: readFileSync(join(BUNDLE_DIR, "window.luau"), "utf8"),
	};
}

function matchesCopy(root: string, bundle: Bundle): boolean {
	if (statEntry(join(root, `${ID}.path`))) return false;
	const destination = join(root, ID);
	const entry = statEntry(destination);
	if (!entry?.isDirectory() || entry.isSymbolicLink()) return false;
	const inventory = readdirSync(destination, { withFileTypes: true });
	if (inventory.length !== FILES.length || !inventory.every((file) => file.isFile() && FILES.some((name) => name === file.name)))
		return false;
	return (
		readFileSync(join(destination, "plugin.toml"), "utf8") === bundle.manifest &&
		readFileSync(join(destination, "todo-more.css"), "utf8") === bundle.css &&
		readFileSync(join(destination, "window.luau"), "utf8") === bundle.window
	);
}

function isCurrent(catalog: Catalog, root: string, bundle: Bundle): boolean {
	const plugin = catalog.plugins.find((entry) => entry.id === ID);
	return (
		plugin !== undefined &&
		(plugin.status === "ready" || plugin.status === "disabled") &&
		plugin.version === bundle.version &&
		(plugin.status === "disabled" || plugin.css === bundle.css) &&
		matchesCopy(root, bundle)
	);
}

async function initialize(): Promise<void> {
	const tern = Bun.which("tern");
	if (tern === null) return; // ANSI-only hosts have no Tern owner to ask.
	try {
		const bundle = readBundle();
		const root = directorySchema.parse(await ownerReply(tern, ["dir", "--json"])).dir;
		const before = catalogSchema.parse(await ownerReply(tern, ["list", "--json"]));
		if (isCurrent(before, root, bundle)) return;
		const installed = installedSchema.parse(await ownerReply(tern, ["install", BUNDLE_DIR, "--force", "--json"]));
		if (installed.id !== ID || installed.version !== bundle.version || resolve(installed.dir) !== resolve(join(root, ID))) {
			throw new Error(
				tr("Tern returned an unexpected plugin identity, version or destination.", "Tern 返回了意外的插件身份、版本或目标路径。"),
			);
		}
		const after = catalogSchema.parse(await ownerReply(tern, ["list", "--json"]));
		if (!isCurrent(after, root, bundle)) {
			const plugin = after.plugins.find((entry) => entry.id === ID);
			throw new Error(
				typeof plugin?.status === "object"
					? tr(`Tern catalog failed: ${plugin.status.failed}`, `Tern 目录失败：${plugin.status.failed}`)
					: tr("Tern did not confirm the matching ready/disabled normal copy.", "Tern 未确认匹配的 ready/disabled 正常副本。"),
			);
		}
	} catch (error) {
		throw new Error(
			tr(`omp-todo-more Tern initialization failed: ${errorText(error)}`, `omp-todo-more Tern 初始化失败：${errorText(error)}`),
		);
	}
}

/** One awaited owner initialization for this module graph; prepared child factories reuse its conclusion. */
let initialization: Promise<void> | undefined;
export function initializeTernPlugin(): Promise<void> {
	initialization ??= initialize();
	return initialization;
}
