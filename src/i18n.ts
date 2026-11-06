export type Language = "en" | "zh";

/** The environment variable that names the language explicitly: `en` or `zh`. */
export const LANGUAGE_ENV = "OMOMP_LANG";

function parseLanguage(value: unknown): Language | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return normalized === "en" || normalized === "zh" ? normalized : undefined;
}

/** Resolve the current UI language. Environment variables are read for every call. */
export function language(): Language {
	const explicit = parseLanguage(process.env[LANGUAGE_ENV]);
	if (explicit !== undefined) return explicit;

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
