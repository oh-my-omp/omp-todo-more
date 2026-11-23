import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import manifest from "../package.json";
import { errorText } from "./errors.ts";

const PLUGIN = "omp-todo-ng";
const defaults = manifest.omp.settings;

export type TodoNgSettings = {
	readonly leafMaxMinutes: number;
};

export const DEFAULT_SETTINGS: TodoNgSettings = {
	leafMaxMinutes: defaults.leafMaxMinutes.default,
};

const isLeafMax = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= defaults.leafMaxMinutes.min && value <= defaults.leafMaxMinutes.max;

export async function readSettings(pi: Pick<ExtensionAPI, "logger">, ctx: Pick<ExtensionContext, "cwd">): Promise<TodoNgSettings> {
	try {
		const raw = await getPluginSettings(PLUGIN, ctx.cwd);
		if (raw.leafMaxMinutes === undefined) return DEFAULT_SETTINGS;
		if (isLeafMax(raw.leafMaxMinutes)) return { leafMaxMinutes: raw.leafMaxMinutes };
		pi.logger.warn("todo-ng ignored invalid plugin settings", { keys: ["leafMaxMinutes"] });
		return DEFAULT_SETTINGS;
	} catch (error) {
		pi.logger.warn("todo-ng could not read its plugin settings", { error: errorText(error) });
		return DEFAULT_SETTINGS;
	}
}
