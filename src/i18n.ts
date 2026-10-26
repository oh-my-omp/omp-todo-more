import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";

export type Language = "en" | "zh";

/** The environment variable that names the language explicitly: `en` or `zh`. */
export const LANGUAGE_ENV = "OMOMP_LANG";

const CONFIG_FILES = ["omomp.yml", "omomp.yaml", "omomp.json", "omomp.toml"] as const;

type ConfigValue = Record<string, unknown>;

let omompRead = false;
let omompLanguage: Language | undefined;

function parseLanguage(value: unknown): Language | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return normalized === "en" || normalized === "zh" ? normalized : undefined;
}

function readOmompLanguage(): Language | undefined {
	if (omompRead) return omompLanguage;
	omompRead = true;

	let path: string | undefined;
	let text: string | undefined;
	for (const filename of CONFIG_FILES) {
		try {
			const candidatePath = join(getAgentDir(), filename);
			const candidateText = readFileSync(candidatePath, "utf8");
			if (path !== undefined) return undefined;
			path = candidatePath;
			text = candidateText;
		} catch (error) {
			if (isNotFound(error)) continue;
			return undefined;
		}
	}
	if (path === undefined || text === undefined) return undefined;

	try {
		const parsed: unknown = path.endsWith(".json")
			? JSON.parse(text)
			: path.endsWith(".toml")
				? Bun.TOML.parse(text)
				: Bun.YAML.parse(text);
		if (!isConfigValue(parsed)) return undefined;
		const section = parsed["omomp-lang"];
		if (!isConfigValue(section)) return undefined;
		omompLanguage = parseLanguage(section.language);
		return omompLanguage;
	} catch {
		return undefined;
	}
}

function isConfigValue(value: unknown): value is ConfigValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * Resolve the current UI language. Environment variables are read for every call;
 * the omomp setting is read once on first use and applies from the next start.
 */
export function language(): Language {
	const explicit = parseLanguage(process.env[LANGUAGE_ENV]);
	if (explicit !== undefined) return explicit;

	const configured = readOmompLanguage();
	if (configured !== undefined) return configured;

	for (const key of ["LC_ALL", "LC_MESSAGES", "LANG"] as const) {
		const value = process.env[key]?.trim();
		if (value) return value.toLowerCase().startsWith("zh") ? "zh" : "en";
	}
	return "en";
}

/** The text for the current language; English comes first at each use site. */
export function tr(en: string, zh: string): string {
	return language() === "zh" ? zh : en;
}
