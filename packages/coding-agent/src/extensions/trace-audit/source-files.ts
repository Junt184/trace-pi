import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { sourceLanguage } from "./code.ts";
import { readProcess } from "./git.ts";
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export async function sourceFiles(
	cwd: string,
	scope = ".",
	purpose: "graph" | "vector" = "graph",
	signal?: AbortSignal,
) {
	cwd = realpathSync(cwd);
	const target = realpathSync(resolve(cwd, scope));
	const inside = (path: string) => {
		const r = relative(cwd, path);
		return !isAbsolute(r) && r !== ".." && !r.startsWith("../");
	};
	if (!inside(target)) throw new Error("索引范围必须在当前项目目录内");
	const scan = statSync(target).isFile()
		? { stdout: `${target}\0`, complete: true }
		: await readProcess(
				"rg",
				[
					"--files",
					"--null",
					"--glob",
					"!**/node_modules/**",
					"--glob",
					"!**/.audit-harness/**",
					"--glob",
					"!**/vendor/**",
					"--glob",
					"!**/dist/**",
					"--glob",
					"!**/build/**",
					"--glob",
					"!**/.venv/**",
					"--glob",
					"!**/target/**",
					"--",
					relative(cwd, target) || ".",
				],
				cwd,
				signal,
			);
	const excluded: { path: string; reason: string }[] = [];
	const files: {
		path: string;
		text: string;
		sha256: string;
		language?: string;
	}[] = [];
	const textTypes =
		/\.(?:[cm]?[jt]sx?|php|phtml|py|go|java|kt|rs|c|cc|cpp|h|hpp|cs|rb|sh|sql|md|yaml|yml|json|toml)$/i;
	for (const name of scan.stdout.split("\0").filter(Boolean).sort()) {
		signal?.throwIfAborted();
		if (!textTypes.test(name)) continue;
		const language = sourceLanguage(name);
		if (purpose === "graph" && !language) {
			if (!/\.(md|json|ya?ml|toml|sql|sh)$/i.test(name))
				excluded.push({
					path: name,
					reason: `unsupported-language:${extname(name)}`,
				});
			continue;
		}
		try {
			const path = realpathSync(resolve(cwd, name));
			if (!inside(path)) {
				excluded.push({ path: name, reason: "symlink-outside-project" });
				continue;
			}
			if (statSync(path).size > 512 * 1024) {
				excluded.push({
					path: name,
					reason: "file-over-512KiB; narrow or split before indexing",
				});
				continue;
			}
			const text = readFileSync(path, "utf8");
			if (text.includes("\0")) {
				excluded.push({ path: name, reason: "binary" });
				continue;
			}
			if (!files.some((f) => f.path === path)) files.push({ path, text, sha256: digest(text), language });
		} catch (error) {
			excluded.push({ path: name, reason: String(error) });
		}
	}
	return {
		cwd,
		scope: target,
		files,
		excluded,
		enumerationComplete: scan.complete,
		rules: "rg ignore rules apply; node_modules/vendor/dist/build/target/.venv/.audit-harness excluded at every depth; explicit file scope can select an ignored file",
	};
}
