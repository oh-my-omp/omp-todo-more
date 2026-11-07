/**
 * todo-more's reminder settings and the native automation they replace.
 *
 * The values are this plugin's native settings (`package.json` `omp.settings`,
 * edited in `/settings` → Plugins or `omp plugin config`), read when a session
 * starts and at every prompt start; between those, hooks and timers use the
 * last read. An invalid value falls back to its default with a warning.
 *
 * The native TodoTracker keeps running underneath (`todo.enabled` stays on), so
 * its own stop reminder, mid-run nudge and eager prelude are switched off with
 * runtime overrides on the session's settings: never persisted, and gone with
 * the process.
 */
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import { cfgTodoEager, cfgTodoReminders } from "@oh-my-pi/pi-coding-agent/tools/settings";
import manifest from "../package.json";
import { errorText } from "./errors.ts";

const PLUGIN = "omp-todo-more";
const defaults = manifest.omp.settings;

export const EAGER_MODES = ["default", "preferred", "always"] as const;
export type EagerMode = (typeof EAGER_MODES)[number];

export type ReminderSettings = { readonly reminders: boolean; readonly remindersMax: number; readonly eager: EagerMode };

export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = {
	reminders: defaults.reminders.default,
	remindersMax: defaults.remindersMax.default,
	eager: "default",
};

function isEagerMode(value: unknown): value is EagerMode {
	return EAGER_MODES.some((mode) => mode === value);
}

/** One raw setting, or its default when unset or invalid; `invalid` collects the keys that were. */
function pick<T>(raw: unknown, valid: (value: unknown) => value is T, fallback: T, key: string, invalid: string[]): T {
	if (raw === undefined) return fallback;
	if (valid(raw)) return raw;
	invalid.push(key);
	return fallback;
}

const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isCount = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= defaults.remindersMax.min && value <= defaults.remindersMax.max;

export async function readReminderSettings(pi: ExtensionAPI, ctx: Pick<ExtensionContext, "cwd">): Promise<ReminderSettings> {
	try {
		const raw = await getPluginSettings(PLUGIN, ctx.cwd);
		const invalid: string[] = [];
		const settings: ReminderSettings = {
			reminders: pick(raw.reminders, isBoolean, DEFAULT_REMINDER_SETTINGS.reminders, "reminders", invalid),
			remindersMax: pick(raw.remindersMax, isCount, DEFAULT_REMINDER_SETTINGS.remindersMax, "remindersMax", invalid),
			eager: pick(raw.eager, isEagerMode, DEFAULT_REMINDER_SETTINGS.eager, "eager", invalid),
		};
		if (invalid.length > 0) pi.logger.warn("todo-more ignored invalid plugin settings", { keys: invalid });
		return settings;
	} catch (error) {
		pi.logger.warn("todo-more could not read its plugin settings", { error: errorText(error) });
		return DEFAULT_REMINDER_SETTINGS;
	}
}

/** Switch off the native reminders and eager prelude todo-more replaces, for this process only. */
export function silenceNativeTodoAutomation(session: AgentSession): void {
	if (cfgTodoReminders.get(session.settings)) cfgTodoReminders.override(session.settings, false);
	if (cfgTodoEager.get(session.settings) !== "default") cfgTodoEager.override(session.settings, "default");
}
