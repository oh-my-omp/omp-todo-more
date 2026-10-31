import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODULE_URL = new URL("../src/i18n.ts", import.meta.url).href;
const LANGUAGE_SCRIPT = `import { language } from ${JSON.stringify(MODULE_URL)}; process.stdout.write(language());`;

type Environment = Record<string, string>;

async function runLanguage(overrides: Record<string, string | undefined>, files: Record<string, string> = {}): Promise<string> {
	const agentDir = await mkdtemp(join(tmpdir(), "omp-todo-more-i18n-"));
	try {
		for (const [name, content] of Object.entries(files)) await writeFile(join(agentDir, name), content);
		const env = Object.fromEntries(
			Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
		) as Environment;
		for (const key of ["OMOMP_LANG", "LC_ALL", "LC_MESSAGES", "LANG"]) delete env[key];
		env.PI_CODING_AGENT_DIR = agentDir;
		for (const [key, value] of Object.entries(overrides)) {
			if (value === undefined) delete env[key];
			else env[key] = value;
		}
		const result = Bun.spawnSync({ cmd: [process.execPath, "-e", LANGUAGE_SCRIPT], env, stdout: "pipe", stderr: "pipe" });
		const stdout = new TextDecoder().decode(result.stdout).trim();
		const stderr = new TextDecoder().decode(result.stderr).trim();
		expect(result.exitCode, stderr).toBe(0);
		return stdout;
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
}

describe("runtime UI language resolution", () => {
	test("explicit OMOMP_LANG wins over the agent config and locale", async () => {
		expect(await runLanguage({ OMOMP_LANG: " EN ", LANG: "zh_CN.UTF-8" }, { "omomp.yml": "omomp-lang:\n  language: zh\n" })).toBe("en");
	});

	test("agent config wins after an invalid explicit value", async () => {
		expect(await runLanguage({ OMOMP_LANG: "fr", LANG: "en_US.UTF-8" }, { "omomp.yml": "omomp-lang:\n  language: zh\n" })).toBe("zh");
	});

	test("locale fallback uses the first non-empty locale", async () => {
		expect(await runLanguage({ OMOMP_LANG: "invalid", LC_ALL: "", LC_MESSAGES: "zh_TW.UTF-8", LANG: "en_US.UTF-8" })).toBe("zh");
	});

	test("multiple agent config files provide no configured language", async () => {
		expect(await runLanguage({ LANG: "zh_CN.UTF-8" }, { "omomp.yml": "omomp-lang:\n  language: en\n", "omomp.json": "{}" })).toBe("zh");
	});

	test("agent config requires an exact language enum and no extra section fields", async () => {
		for (const section of [{ language: "ZH" }, { language: " zh " }, { language: "zh", extra: true }, { language: 1 }, {}, ["zh"]]) {
			expect(await runLanguage({ LANG: "en_US.UTF-8" }, { "omomp.json": JSON.stringify({ "omomp-lang": section }) })).toBe("en");
		}
	});

	test("each supported agent config format accepts the exact section", async () => {
		for (const [name, content] of Object.entries({
			"omomp.yml": "omomp-lang:\n  language: zh\n",
			"omomp.yaml": "omomp-lang:\n  language: zh\n",
			"omomp.json": '{"omomp-lang":{"language":"zh"}}',
			"omomp.toml": '[omomp-lang]\nlanguage = "zh"\n',
		})) {
			expect(await runLanguage({ LANG: "en_US.UTF-8" }, { [name]: content })).toBe("zh");
		}
	});
	test("missing values default to English", async () => {
		expect(await runLanguage({ OMOMP_LANG: "", LC_ALL: "", LC_MESSAGES: "", LANG: "" })).toBe("en");
	});
});
