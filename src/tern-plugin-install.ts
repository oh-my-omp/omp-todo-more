import { lstatSync, type Stats } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tr } from "../omomp-shared/i18n.ts";
import { findTern, pluginCopyMatches, readPluginManifest, type TernPluginEntry, type TernResult } from "../omomp-shared/tern-plugin.ts";
import { errorText } from "./errors.ts";

const ID = "omp-todo-ng";
const BUNDLE_DIR = fileURLToPath(new URL("../tern/", import.meta.url));

type Bundle = { version: string; css: string };

function statEntry(path: string): Stats | undefined {
	try {
		return lstatSync(path);
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

function unwrap<T>(result: TernResult<T>): T {
	if (result.ok) return result.value;
	throw new Error(result.error.message);
}

async function readBundle(): Promise<Bundle> {
	const manifest = unwrap(await readPluginManifest(BUNDLE_DIR, ID));
	if (manifest.version === undefined) {
		throw new Error(tr("Bundled Tern manifest declares no version.", "内置 Tern 清单没有声明版本。"));
	}
	const cssPath = join(BUNDLE_DIR, "todo-ng.css");
	return { version: manifest.version, css: await Bun.file(cssPath).text() };
}

async function isCurrent(plugins: readonly TernPluginEntry[], root: string, bundle: Bundle): Promise<boolean> {
	const plugin = plugins.find((entry) => entry.id === ID);
	if (plugin === undefined || plugin.status.kind === "failed" || plugin.version !== bundle.version) return false;
	if (plugin.status.kind === "ready" && plugin.css !== bundle.css) return false;
	if (statEntry(join(root, `${ID}.path`))) return false;
	return unwrap(await pluginCopyMatches(BUNDLE_DIR, join(root, ID)));
}

async function initialize(): Promise<void> {
	const tern = findTern();
	if (tern.kind === "not_installed") return;
	const cli = tern.cli;
	try {
		const bundle = await readBundle();
		const root = unwrap(await cli.dir());
		const before = unwrap(await cli.list());
		if (await isCurrent(before, root, bundle)) return;
		const installed = unwrap(await cli.install(BUNDLE_DIR));
		if (installed.id !== ID || installed.version !== bundle.version || resolve(installed.dir) !== resolve(join(root, ID))) {
			throw new Error(
				tr("Tern returned an unexpected plugin identity, version or destination.", "Tern 返回了意外的插件身份、版本或目标路径。"),
			);
		}
		const after = unwrap(await cli.list());
		if (!(await isCurrent(after, root, bundle))) {
			const plugin = after.find((entry) => entry.id === ID);
			throw new Error(
				plugin?.status.kind === "failed"
					? tr(`Tern catalog failed: ${plugin.status.detail}`, `Tern 目录失败：${plugin.status.detail}`)
					: tr("Tern did not confirm the matching ready/disabled normal copy.", "Tern 未确认匹配的 ready/disabled 正常副本。"),
			);
		}
	} catch (error) {
		throw new Error(tr(`omp-todo-ng Tern initialization failed: ${errorText(error)}`, `omp-todo-ng Tern 初始化失败：${errorText(error)}`));
	}
}

let initialization: Promise<void> | undefined;
export function initializeTernPlugin(): Promise<void> {
	initialization ??= initialize();
	return initialization;
}
