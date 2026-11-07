import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { type Program, recordedProgram } from "./execution.ts";
import { artifact, parseFixUrl, readFixSource } from "./fix-sources.ts";
import type { FixSource } from "./fix-types.ts";
import { git, resolveCommit } from "./git.ts";
import { digest } from "./source-files.ts";
import type { AuditStore } from "./store.ts";

type ProgramResult = Awaited<ReturnType<typeof recordedProgram>>;
interface PatchState {
	state: string;
	note: string;
	forward?: ProgramResult;
	reverse?: ProgramResult;
	patchSha256?: string;
}
interface ExperimentRun {
	directory: string;
	status?: string;
	setup?: ProgramResult;
	result?: ProgramResult;
}
interface ComparisonReport {
	base: string;
	revision: string;
	patchArtifact?: string;
	experiment: string;
	createdAt: string;
	endedAt?: string;
	overlays: { path: string; sha256: string }[];
	program: { command: string; args: string[] };
	runs: Partial<Record<"before" | "after", ExperimentRun>>;
	expectationsMet: boolean | null;
	note: string;
	patchSha256?: string;
	patchApplication?: ProgramResult;
	error?: string;
}
function artifactPath(store: AuditStore, runId: string, name: string) {
	if (basename(name) !== name) throw Error("请选择当前任务内的产物文件");
	return resolve(store.dir(runId), "artifacts", name);
}
export async function verifyFixSource(
	cwd: string,
	args: {
		url: string;
		claimUrl?: string;
		expectedRepository?: string;
		expectedCommit?: string;
	},
	store: AuditStore,
	runId: string,
	callId: string,
	signal?: AbortSignal,
) {
	if (args.expectedCommit && !/^[a-f0-9]{7,40}$/i.test(args.expectedCommit))
		throw Error("expectedCommit 必须是 7–40 位提交 hash");
	if (args.expectedRepository && !/^[\w.-]+\/[\w.-]+$/.test(args.expectedRepository))
		throw Error("expectedRepository 必须是 owner/repo");
	const target = parseFixUrl(args.url);
	const source = await readFixSource(
		cwd,
		{ url: args.url, includeComments: true },
		store,
		runId,
		`${callId}-source`,
		signal,
	);
	let claim: FixSource | undefined;
	if (args.claimUrl)
		claim = await readFixSource(
			cwd,
			{ url: args.claimUrl, includeComments: true },
			store,
			runId,
			`${callId}-claim`,
			signal,
		);
	const canonical = (url: string) => {
		try {
			return parseFixUrl(url).url.toLowerCase();
		} catch {
			return url.toLowerCase();
		}
	};
	const references = claim?.references || [];
	const sourceRepo = "repository" in target ? target.repository : undefined;
	let localOrigin: string | undefined;
	try {
		localOrigin = (await git(cwd, ["remote", "get-url", "origin"], signal)).stdout.trim();
	} catch {
		signal?.throwIfAborted();
	}
	const originRepo = /(?:github\.com[/:])([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(localOrigin || "")?.[1];
	const checks = {
		fetchedFromCanonicalApi: true,
		repositoryMatches: args.expectedRepository
			? sourceRepo
				? args.expectedRepository.toLowerCase() === sourceRepo.toLowerCase()
				: null
			: null,
		commitMatches: args.expectedCommit
			? source.sha
				? source.sha.toLowerCase().startsWith(args.expectedCommit.toLowerCase())
				: null
			: null,
		localOriginMatches: originRepo && sourceRepo ? originRepo.toLowerCase() === sourceRepo.toLowerCase() : null,
		claimExplicitlyLinksSource: claim
			? references.some((url: string) => canonical(url) === canonical(source.url))
			: null,
		withdrawn: Boolean(source.withdrawnAt),
		merged: source.merged ?? null,
		patchAvailable: Boolean(source.patchArtifact),
		commentsComplete: !source.commentsError && !source.nextCommentsPage,
	};
	const report = {
		sourceUrl: source.url,
		sourceArtifact: source.artifact,
		claimUrl: claim?.url,
		claimArtifact: claim?.artifact,
		expectedRepository: args.expectedRepository,
		expectedCommit: args.expectedCommit,
		localOrigin,
		checks,
		source,
		claim,
		note: "Canonical API content and identity/link relationships are verified separately. An explicit link is a source claim, not a proof of a fix. Issue closure, Gist authorship, merged state and local ancestry do not prove local applicability or publication.",
	};
	return {
		...report,
		artifact: artifact(store, runId, callId, "source-verification", JSON.stringify(report, null, 2)),
	};
}
export interface Condition extends Program {
	description: string;
	expectedExitCode?: number;
	expectedOutput?: string;
}
export async function checkFixApplicability(
	cwd: string,
	args: { url: string; conditions?: Condition[]; evidenceFiles?: string[] },
	store: AuditStore,
	runId: string,
	callId: string,
	signal?: AbortSignal,
) {
	const source = await readFixSource(cwd, { url: args.url }, store, runId, `${callId}-source`, signal);
	const checks: {
		description: string;
		expectedExitCode: number;
		expectedOutput?: string;
		satisfied: boolean;
		result: ProgramResult;
	}[] = [];
	const folder = resolve(store.dir(runId), "artifacts");
	let patchState: PatchState = {
		state: "no-patch",
		note: "此来源没有可用补丁，不能检查工作树代码状态",
	};
	if (source.patchArtifact) {
		const path = artifactPath(store, runId, source.patchArtifact);
		const forward = await recordedProgram(
			cwd,
			{ command: "git", args: ["apply", "--check", path] },
			folder,
			`applicability-${callId}-forward`,
			signal,
		);
		const reverse = await recordedProgram(
			cwd,
			{ command: "git", args: ["apply", "--reverse", "--check", path] },
			folder,
			`applicability-${callId}-reverse`,
			signal,
		);
		const ok = (r: typeof forward) => r.exitCode === 0 && !r.aborted && !r.timedOut && !r.spawnError;
		patchState = {
			state:
				ok(forward) && !ok(reverse)
					? "patch-can-apply"
					: ok(reverse) && !ok(forward)
						? "matches-patch-after-state"
						: ok(forward) && ok(reverse)
							? "ambiguous"
							: "does-not-match-or-invalid-patch",
			forward,
			reverse,
			patchSha256: digest(readFileSync(path, "utf8")),
			note: "git apply --check 只读检查当前工作树；补丁匹配不证明配置可达性、回移植等价或漏洞状态。",
		};
	}
	for (const [i, condition] of (args.conditions || []).entries()) {
		signal?.throwIfAborted();
		const result = await recordedProgram(cwd, condition, folder, `applicability-${callId}-condition-${i}`, signal);
		const observed =
			result.exitCode === (condition.expectedExitCode ?? 0) &&
			!result.spawnError &&
			!result.aborted &&
			!result.timedOut &&
			(condition.expectedOutput === undefined ||
				readFileSync(result.log, "utf8").includes(condition.expectedOutput));
		checks.push({
			description: condition.description,
			expectedExitCode: condition.expectedExitCode ?? 0,
			expectedOutput: condition.expectedOutput,
			satisfied: observed,
			result,
		});
	}
	const paths = args.evidenceFiles || [
		"composer.json",
		"composer.lock",
		"package.json",
		"go.mod",
		"Cargo.toml",
		"pyproject.toml",
		"pom.xml",
	];
	const files = paths
		.filter((p) => existsSync(resolve(cwd, p)))
		.map((p) => {
			const text = readFileSync(resolve(cwd, p), "utf8");
			return { path: resolve(cwd, p), sha256: digest(text), content: text };
		});
	const report = {
		sourceUrl: source.url,
		sourceArtifact: source.artifact,
		localHistory: source.localHistory,
		patchState,
		conditions: checks,
		files,
		note: "Actual source, dependency/config files and Agent-supplied runtime checks are evidence. No conditions means runtime applicability is unverified. A passing probe only establishes the predicate implemented by that script, not automatic vulnerability/fixed status.",
	};
	const name = artifact(store, runId, callId, "applicability", JSON.stringify(report, null, 2));
	return {
		...report,
		files: files.map((f) => ({
			...f,
			content: f.content.slice(0, 8000),
			truncated: f.content.length > 8000,
		})),
		artifact: name,
	};
}
export async function comparePatch(
	cwd: string,
	args: {
		base?: string;
		revision?: string;
		patchArtifact?: string;
		command: string;
		args?: string[];
		setup?: Program;
		files?: { path: string; content: string }[];
		environment?: Record<string, string>;
		beforeEnvironment?: Record<string, string>;
		afterEnvironment?: Record<string, string>;
		expectedBeforeExitCode?: number;
		expectedAfterExitCode?: number;
		timeoutSeconds?: number;
	},
	store: AuditStore,
	runId: string,
	callId: string,
	signal?: AbortSignal,
	onProgress?: (v: unknown) => void,
) {
	if (Boolean(args.revision) === Boolean(args.patchArtifact))
		throw Error("请选择 revision 或 patchArtifact 其中一种对照方式");
	const base = await resolveCommit(cwd, args.base || (args.revision ? `${args.revision}^` : "HEAD"), signal);
	const after = args.revision ? await resolveCommit(cwd, args.revision, signal) : base;
	const experiment = resolve(store.dir(runId), "experiments", callId.replace(/[^\w-]/g, "_"));
	if (existsSync(experiment)) throw Error("此实验 ID 已存在，请用新工具调用重放，保留原始证据");
	mkdirSync(experiment, { recursive: true });
	const folder = resolve(store.dir(runId), "artifacts");
	mkdirSync(folder, { recursive: true });
	const report: ComparisonReport = {
		base,
		revision: after,
		patchArtifact: args.patchArtifact,
		experiment,
		createdAt: new Date().toISOString(),
		overlays: (args.files || []).map((f) => ({
			path: f.path,
			sha256: digest(f.content),
		})),
		program: { command: args.command, args: args.args || [] },
		runs: {},
		expectationsMet: null,
		note: "Tracked Git snapshots in separate experiment directories; original worktree/index/HEAD untouched. The identical Agent-written scripts run on each side. Dependencies, daemons, external services and ignored runtime data are provided by setup/environment; scripts remain unrestricted. Exit changes alone are not a vulnerability verdict.",
	};
	const manifest = `patch-comparison-${callId.replace(/[^\w-]/g, "_")}.json`;
	const save = () =>
		writeFileSync(resolve(folder, manifest), JSON.stringify(report, null, 2), {
			mode: 0o600,
		});
	try {
		for (const [name, revision] of [
			["before", base],
			["after", after],
		] as const) {
			signal?.throwIfAborted();
			const dir = resolve(experiment, name);
			mkdirSync(dir, { recursive: true });
			const archive = resolve(experiment, `${name}.tar`);
			await git(cwd, ["archive", "--format=tar", `--output=${archive}`, revision], signal);
			const extraction = await recordedProgram(
				experiment,
				{ command: "tar", args: ["-xf", archive, "-C", dir] },
				folder,
				`comparison-${callId}-${name}-extract`,
				signal,
			);
			if (extraction.exitCode !== 0 || extraction.timedOut || extraction.aborted || extraction.spawnError)
				throw Error(`无法展开真实 Git 快照：${extraction.tail}`);
			const isolatedGit = await recordedProgram(
				dir,
				{ command: "git", args: ["init", "-q"] },
				folder,
				`comparison-${callId}-${name}-init`,
				signal,
			);
			if (isolatedGit.exitCode !== 0 || isolatedGit.aborted || isolatedGit.timedOut || isolatedGit.spawnError)
				throw Error("无法初始化独立快照 Git 上下文");
			if (name === "after" && args.patchArtifact) {
				const patch = artifactPath(store, runId, args.patchArtifact);
				report.patchSha256 = digest(readFileSync(patch, "utf8"));
				const applied = await recordedProgram(
					dir,
					{ command: "git", args: ["apply", patch] },
					folder,
					`comparison-${callId}-apply`,
					signal,
				);
				report.patchApplication = applied;
				if (applied.exitCode !== 0 || applied.aborted || applied.timedOut || applied.spawnError)
					throw Error(`隔离副本应用补丁失败：${applied.tail}`);
			}
			for (const file of args.files || []) {
				const dest = resolve(dir, file.path),
					r = relative(dir, dest);
				if (isAbsolute(r) || r === ".." || r.startsWith("../")) throw Error("实验文件路径必须位于快照内");
				mkdirSync(resolve(dest, ".."), { recursive: true });
				writeFileSync(dest, file.content, { mode: 0o600 });
			}
			const environment = {
				...args.environment,
				...(name === "before" ? args.beforeEnvironment : args.afterEnvironment),
			};
			const run: ExperimentRun = { directory: dir };
			report.runs[name] = run;
			save();
			onProgress?.({
				phase: "patch-regression",
				stage: name,
				artifact: manifest,
			});
			if (args.setup) {
				run.setup = await recordedProgram(
					dir,
					args.setup,
					folder,
					`comparison-${callId}-${name}-setup`,
					signal,
					environment,
				);
				save();
				if (run.setup.exitCode !== 0 || run.setup.timedOut || run.setup.aborted || run.setup.spawnError) {
					run.status = "setup-failed";
					continue;
				}
			}
			signal?.throwIfAborted();
			run.result = await recordedProgram(
				dir,
				{
					command: args.command,
					args: args.args,
					timeoutSeconds: args.timeoutSeconds,
				},
				folder,
				`comparison-${callId}-${name}-probe`,
				signal,
				environment,
			);
			run.status = run.result.spawnError
				? "spawn-error"
				: run.result.timedOut
					? "timed-out"
					: run.result.aborted
						? "cancelled"
						: "observed";
			save();
		}
		if (args.expectedBeforeExitCode !== undefined && args.expectedAfterExitCode !== undefined)
			report.expectationsMet = (["before", "after"] as const).every((name) => {
				const r = report.runs[name];
				return (
					r?.status === "observed" &&
					r.result?.exitCode === (name === "before" ? args.expectedBeforeExitCode : args.expectedAfterExitCode)
				);
			});
	} catch (error) {
		report.error = String(error);
		throw error;
	} finally {
		report.endedAt = new Date().toISOString();
		save();
	}
	return { ...report, artifact: manifest };
}
