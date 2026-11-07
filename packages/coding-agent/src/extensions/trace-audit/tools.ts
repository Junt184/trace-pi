import { execFile, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "../../core/extensions/types.ts";
import { GITHUB_PROXY } from "./config.ts";
import { createInspectionTools } from "./inspection-tools.ts";
import type { ResolveAuditContext } from "./store.ts";

const exec = promisify(execFile);
const output = (value: unknown) => ({
	content: [
		{
			type: "text" as const,
			text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
		},
	],
	details: value,
});

export async function repositoryInfo(path: string) {
	const cwd = resolve(path.replace(/^~(?=\/|$)/, process.env.HOME || "~"));
	if (!statSync(cwd).isDirectory()) throw new Error("仓库路径必须是本机目录");
	const queries = await Promise.allSettled([
		exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 5000 }),
		exec("git", ["-C", cwd, "rev-parse", "--short", "HEAD"], { timeout: 5000 }),
		exec("git", ["-C", cwd, "branch", "--show-current"], { timeout: 5000 }),
		exec("git", ["-C", cwd, "status", "--porcelain"], {
			timeout: 5000,
			maxBuffer: 512000,
		}),
	]);
	const result = (n: number) => (queries[n].status === "fulfilled" ? queries[n].value.stdout.trim() : "");
	const entries = readdirSync(cwd, { withFileTypes: true }).filter(
		(e) => ![".git", "node_modules", ".audit-harness", ".venv", "__pycache__"].includes(e.name),
	);
	return {
		path: cwd,
		name: basename(cwd),
		isGit: Boolean(result(0)),
		gitRoot: result(0),
		commit: result(1),
		branch: result(2),
		dirtyFiles: result(3).split("\n").filter(Boolean).length,
		entries: entries.map((e) => ({ name: e.name, directory: e.isDirectory() })),
	};
}

export function createAuditTools(context: ResolveAuditContext): ToolDefinition[] {
	return [
		defineTool({
			name: "project_overview",
			label: "项目概览",
			description:
				"Read the actual repository version, git status and top-level files. Does not build or modify the project.",
			promptSnippet: "Inspect repository structure and source version",
			parameters: Type.Object({}),
			async execute(_callId, _args, _signal, _onUpdate, ctx) {
				const { cwd } = context(ctx);
				return output(await repositoryInfo(cwd));
			},
		}),
		...createInspectionTools(context),
		defineTool({
			name: "run_command",
			label: "结构化执行",
			description:
				"Execute a real program with an argv array (no shell interpolation). Useful for Python/Java probes, tests and payload files. Captures output to a persistent artifact. Shell remains available via bash. GitHub git traffic uses the configured proxy.",
			promptSnippet: "Run scripts, probes and tests with exact argument bytes",
			parameters: Type.Object({
				command: Type.String(),
				args: Type.Optional(Type.Array(Type.String())),
				cwd: Type.Optional(Type.String()),
				timeoutSeconds: Type.Optional(Type.Number()),
			}),
			async execute(callId, args, signal, onUpdate, ctx) {
				const { cwd, store, runId } = context(ctx);
				const dir = resolve(cwd, args.cwd || ".");
				const artifacts = resolve(store.dir(runId), "artifacts");
				mkdirSync(artifacts, { recursive: true });
				const artifact = `command-${callId.replace(/[^\w-]/g, "_")}.log`;
				const file = resolve(artifacts, artifact);
				writeFileSync(file, "", { mode: 0o600 });
				let argv = args.args || [];
				if (basename(args.command) === "git") argv = ["-c", `http.proxy=${GITHUB_PROXY}`, ...argv];
				const seconds = args.timeoutSeconds ?? 120;
				if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("timeoutSeconds 必须大于 0");
				return await new Promise((accept, reject) => {
					const child = spawn(args.command, argv, {
						cwd: dir,
						detached: process.platform !== "win32",
						stdio: ["ignore", "pipe", "pipe"],
					});
					let tail = "";
					let timedOut = false;
					let aborted = false;
					let lastUpdate = 0;
					const kill = () => {
						try {
							if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
							else child.kill("SIGKILL");
						} catch {
							/* Already exited. */
						}
					};
					const timer = setTimeout(() => {
						timedOut = true;
						kill();
					}, seconds * 1000);
					const cancel = () => {
						aborted = true;
						kill();
					};
					signal?.addEventListener("abort", cancel, { once: true });
					if (signal?.aborted) cancel();
					const receive = (chunk: Buffer) => {
						appendFileSync(file, chunk, { mode: 0o600 });
						tail = (tail + chunk.toString("utf8")).slice(-24000);
						if (Date.now() - lastUpdate > 150) {
							onUpdate?.(output(tail));
							lastUpdate = Date.now();
						}
					};
					child.stdout.on("data", receive);
					child.stderr.on("data", receive);
					const cleanup = () => {
						clearTimeout(timer);
						signal?.removeEventListener("abort", cancel);
					};
					child.once("error", (error) => {
						cleanup();
						reject(error);
					});
					child.once("close", (exitCode, exitSignal) => {
						cleanup();
						accept(
							output({
								command: args.command,
								args: argv,
								cwd: dir,
								exitCode,
								signal: exitSignal,
								timedOut,
								aborted,
								output: tail,
								artifact,
								fullOutputPath: file,
							}),
						);
					});
				});
			},
		}),
		defineTool({
			name: "record_finding",
			label: "记录审计发现",
			description:
				"Save or update a real audit finding for the user in this session. You decide severity and status. Include source locations, prerequisites and observed evidence; candidate or dismissed findings are welcome. Reuse id to update.",
			promptSnippet: "Persist findings and evidence in the audit session",
			parameters: Type.Object({
				id: Type.Optional(Type.String()),
				title: Type.String(),
				severity: Type.String(),
				status: Type.Optional(Type.String()),
				location: Type.Optional(Type.String()),
				description: Type.String(),
				evidence: Type.Optional(Type.String()),
				preconditions: Type.Optional(Type.String()),
				reproduction: Type.Optional(Type.String()),
				recommendation: Type.Optional(Type.String()),
			}),
			async execute(_id, args, _signal, _onUpdate, ctx) {
				const { store, runId } = context(ctx);
				return output(
					store.saveFinding(runId, {
						...args,
						status: args.status || "candidate",
					}),
				);
			},
		}),
		defineTool({
			name: "audit_notes",
			label: "审计笔记",
			description:
				"Read or replace the durable audit notebook. Save important context, ruled-out ideas and next steps when helpful. No required workflow or fixed schema.",
			promptSnippet: "Remember progress across a long audit or restart",
			parameters: Type.Object({ text: Type.Optional(Type.String()) }),
			async execute(_id, args, _signal, _onUpdate, ctx) {
				const { store, runId } = context(ctx);
				if (args.text !== undefined) store.saveNotes(runId, args.text);
				return output(store.notes(runId) || "No notes yet.");
			},
		}),
	];
}
