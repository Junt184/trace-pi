import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { GITHUB_PROXY } from "./config.ts";
export interface Program {
	command: string;
	args?: string[];
	timeoutSeconds?: number;
}
export async function recordedProgram(
	cwd: string,
	program: Program,
	folder: string,
	label: string,
	signal?: AbortSignal,
	environment?: Record<string, string>,
) {
	const seconds = program.timeoutSeconds ?? 120;
	if (!Number.isFinite(seconds) || seconds <= 0) throw Error("timeoutSeconds 必须大于 0");
	signal?.throwIfAborted();
	mkdirSync(folder, { recursive: true });
	const name = `${label.replace(/[^\w.-]/g, "_")}.log`,
		file = resolve(folder, name);
	writeFileSync(file, "", { mode: 0o600 });
	return await new Promise<{
		command: string;
		args: string[];
		cwd: string;
		exitCode: number | null;
		signal: NodeJS.Signals | null;
		timedOut: boolean;
		aborted: boolean;
		spawnError?: string;
		tail: string;
		log: string;
	}>((accept) => {
		let tail = "",
			timedOut = false,
			aborted = false,
			spawnError: string | undefined;
		const child = spawn(program.command, program.args || [], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
			env: {
				...process.env,
				HTTPS_PROXY: GITHUB_PROXY,
				HTTP_PROXY: GITHUB_PROXY,
				...environment,
			},
		});
		const kill = () => {
			try {
				if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch {}
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
		const receive = (data: Buffer) => {
			appendFileSync(file, data);
			tail = (tail + data.toString("utf8")).slice(-24000);
		};
		child.stdout.on("data", receive);
		child.stderr.on("data", receive);
		child.once("error", (error) => {
			spawnError = error.message;
			receive(Buffer.from(error.message));
		});
		child.once("close", (exitCode, exitSignal) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", cancel);
			accept({
				command: program.command,
				args: program.args || [],
				cwd,
				exitCode,
				signal: exitSignal,
				timedOut,
				aborted,
				spawnError,
				tail,
				log: file,
			});
		});
		if (signal?.aborted) cancel();
	});
}
