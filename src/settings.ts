import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import manifest from "../package.json";
import { errorText } from "./errors.ts";

const PLUGIN = "omp-todo-more";
const defaults = manifest.omp.settings;

export type TodoMoreSettings = {
	readonly leafMaxMinutes: number;
};

export const DEFAULT_SETTINGS: TodoMoreSettings = {
	leafMaxMinutes: defaults.leafMaxMinutes.default,
};

function isEagerMode(value: unknown): value is EagerMode {
	return EAGER_MODES.some((mode) => mode === value);
}

export async function readSettings(pi: Pick<ExtensionAPI, "logger">, ctx: Pick<ExtensionContext, "cwd">): Promise<TodoMoreSettings> {
	try {
		const raw = await getPluginSettings(PLUGIN, ctx.cwd);
		if (raw.leafMaxMinutes === undefined) return DEFAULT_SETTINGS;
		if (isLeafMax(raw.leafMaxMinutes)) return { leafMaxMinutes: raw.leafMaxMinutes };
		pi.logger.warn("todo-more ignored invalid plugin settings", { keys: ["leafMaxMinutes"] });
		return DEFAULT_SETTINGS;
	} catch (error) {
		pi.logger.warn("todo-more could not read its plugin settings", { error: errorText(error) });
		return DEFAULT_SETTINGS;
	}
}
