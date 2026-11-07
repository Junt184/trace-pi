import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { GITHUB_PROXY } from "./config.ts";

const exec = promisify(execFile);

export async function readProcess(command: string, args: string[], cwd: string, signal?: AbortSignal) {
	try {
		const result = await exec(command, args, {
			cwd,
			encoding: "utf8",
			timeout: 20000,
			killSignal: "SIGKILL",
			maxBuffer: 16 * 1024 * 1024,
			signal,
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
		});
		return { stdout: result.stdout, stderr: result.stderr, complete: true };
	} catch (error) {
		const failure = error as Error & {
			code?: string | number;
			stdout?: string;
			stderr?: string;
		};
		if (command === "rg" && failure.code === 1)
			return {
				stdout: failure.stdout || "",
				stderr: failure.stderr || "",
				complete: true,
			};
		if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
			return {
				stdout: failure.stdout || "",
				stderr: "Output exceeded 16 MiB. Narrow the path or query.",
				complete: false,
			};
		if (failure.code === "ENOENT") throw new Error(`未找到 ${command}，请安装后重试，或使用现有 shell 工具。`);
		throw new Error(failure.stderr?.trim() || failure.message, {
			cause: failure,
		});
	}
}

export function pageNumbers(offset = 0, limit = 40) {
	if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1)
		throw new Error("offset 必须是非负整数，limit 必须是正整数");
	return { offset, limit };
}

export async function git(cwd: string, args: string[], signal?: AbortSignal) {
	return readProcess(
		"git",
		[
			"--no-pager",
			"--literal-pathspecs",
			"-c",
			"core.quotePath=false",
			"-c",
			`http.proxy=${GITHUB_PROXY}`,
			"-C",
			cwd,
			...args,
		],
		cwd,
		signal,
	);
}

export async function resolveCommit(cwd: string, revision: string, signal?: AbortSignal) {
	const result = await git(cwd, ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`], signal);
	return result.stdout.trim();
}

export async function gitPath(cwd: string, path: string, signal?: AbortSignal) {
	const root = (await git(cwd, ["rev-parse", "--show-toplevel"], signal)).stdout.trim();
	const absolute = resolve(cwd, path);
	// Resolve directory aliases (/var -> /private/var), including paths deleted
	// from the worktree but still present in the requested Git revision.
	let parent = dirname(absolute);
	const suffix = [basename(absolute)];
	while (!existsSync(parent)) {
		suffix.unshift(basename(parent));
		parent = dirname(parent);
	}
	const name = relative(realpathSync(root), resolve(realpathSync(parent), ...suffix));
	if (name === ".." || name.startsWith(`..${sep}`) || isAbsolute(name))
		throw new Error("该路径不属于此 Git 仓库，无法读取其历史版本。");
	return { root, name: name.split(sep).join("/") };
}

export async function historicSource(cwd: string, path: string, revision: string, signal?: AbortSignal) {
	const commit = await resolveCommit(cwd, revision, signal);
	const { root, name } = await gitPath(cwd, path, signal);
	const result = await git(root, ["show", "--no-textconv", `${commit}:${name}`], signal);
	if (!result.complete) throw new Error("历史文件超过读取缓冲，请使用 shell 保存该文件后按需读取。");
	return { text: result.stdout, revision: commit };
}

function records(raw: string) {
	return raw
		.split("\x1e")
		.map((record) => record.trim())
		.filter(Boolean)
		.map((record) => record.split("\0"));
}

export async function listGitRefs(
	cwd: string,
	args: { query?: string; offset?: number; limit?: number },
	signal?: AbortSignal,
) {
	const { offset, limit } = pageNumbers(args.offset, args.limit ?? 30);
	const result = await git(
		cwd,
		[
			"for-each-ref",
			"--sort=-creatordate",
			"--format=%(refname)%00%(refname:short)%00%(objectname)%00%(*objectname)%00%(creatordate:iso-strict)%1e",
			"refs/heads",
			"refs/remotes",
			"refs/tags",
		],
		signal,
	);
	const refs = records(result.stdout)
		.map(([ref, name, objectId, peeledObjectId, date]) => ({
			ref,
			name,
			objectId,
			targetObjectId: peeledObjectId || objectId,
			date,
		}))
		.filter((ref) => !args.query || ref.name.toLowerCase().includes(args.query.toLowerCase()));
	return {
		scope: "local Git refs; no network fetch performed",
		complete: result.complete,
		refs: refs.slice(offset, offset + limit),
		total: result.complete ? refs.length : undefined,
		offset,
		nextOffset: offset + limit < refs.length ? offset + limit : null,
		warning: result.stderr || undefined,
	};
}

export async function gitHistory(
	cwd: string,
	args: {
		revision?: string;
		path?: string;
		query?: string;
		changedText?: string;
		offset?: number;
		limit?: number;
	},
	signal?: AbortSignal,
) {
	const { offset, limit } = pageNumbers(args.offset, args.limit ?? 20);
	const commit = await resolveCommit(cwd, args.revision || "HEAD", signal);
	const flags = [
		"log",
		`--max-count=${limit + 1}`,
		`--skip=${offset}`,
		"--format=%H%x00%h%x00%an%x00%aI%x00%s%x00%D%x1e",
	];
	if (args.query) flags.push("--fixed-strings", "--regexp-ignore-case", `--grep=${args.query}`);
	if (args.changedText) flags.push(`-G${args.changedText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
	flags.push(commit, "--");
	if (args.path) flags.push(args.path);
	const result = await git(cwd, flags, signal);
	const commits = records(result.stdout).map(([hash, shortHash, author, date, subject, refs]) => ({
		hash,
		shortHash,
		author,
		date,
		subject,
		refs,
	}));
	return {
		revision: commit,
		scope: "commits reachable from this local revision; release status is not inferred",
		query: args.query,
		changedText: args.changedText,
		path: args.path,
		complete: result.complete,
		commits: commits.slice(0, limit),
		offset,
		nextOffset: commits.length > limit ? offset + limit : null,
		note: "complete describes command capture, not the whole history. A non-null nextOffset means more commits are available; this page is not a total count.",
		warning: result.stderr || undefined,
	};
}

export async function gitPatch(
	cwd: string,
	args: {
		revision?: string;
		base?: string;
		path?: string;
		offset?: number;
		limit?: number;
	},
	signal?: AbortSignal,
) {
	const { offset, limit } = pageNumbers(args.offset, args.limit ?? 160);
	const revision = await resolveCommit(cwd, args.revision || "HEAD", signal);
	const base = args.base ? await resolveCommit(cwd, args.base, signal) : undefined;
	const flags = base
		? ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames", base, revision, "--"]
		: [
				"show",
				"--root",
				"--format=fuller",
				"--no-ext-diff",
				"--no-textconv",
				"--no-color",
				"--find-renames",
				revision,
				"--",
			];
	if (args.path) flags.push(args.path);
	const result = await git(cwd, flags, signal);
	const lines = result.stdout ? result.stdout.replace(/\n$/, "").split("\n") : [];
	const hunks = lines.flatMap((line, index) => {
		const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
		return match
			? [
					{
						patchLine: index + 1,
						oldStart: Number(match[1]),
						newStart: Number(match[3]),
						context: match[5].trim(),
					},
				]
			: [];
	});
	return {
		revision,
		base: base || null,
		comparison: base ? "two committed snapshots" : "selected commit patch",
		path: args.path,
		complete: result.complete,
		offset,
		totalLines: result.complete ? lines.length : undefined,
		nextOffset: offset + limit < lines.length ? offset + limit : null,
		patch: lines.slice(offset, offset + limit).join("\n"),
		hunks,
		fullPatch: result.stdout,
		note: "complete describes the saved patch capture. The returned patch field is one page; use nextOffset to read remaining lines or open the artifact.",
		warning: result.stderr || undefined,
	};
}
