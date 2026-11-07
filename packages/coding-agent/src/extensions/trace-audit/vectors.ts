import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { getAuditAssetsDir } from "../../config.ts";
import { DATA, GITHUB_PROXY } from "./config.ts";
import { digest, sourceFiles } from "./source-files.ts";

const model = process.env.AUDIT_EMBED_MODEL || "Xenova/multilingual-e5-small";
const revision =
	process.env.AUDIT_EMBED_REVISION ||
	(model === "Xenova/multilingual-e5-small" ? "761b726dd34fb83930e26aab4e9ac3899aa1fa78" : "main");
interface Chunk {
	path: string;
	startLine: number;
	endLine: number;
	text: string;
	sha256: string;
	vector: number[];
}
interface Index {
	schema: 1;
	model: string;
	revision: string;
	dimension: number;
	repository: string;
	scope: string;
	updatedAt: string;
	files: { path: string; sha256: string }[];
	chunks: Chunk[];
	excluded: { path: string; reason: string }[];
	complete: boolean;
	rules: string;
}
const locks = new Set<string>();
async function embed(texts: string[], signal?: AbortSignal, onProgress?: (v: unknown) => void): Promise<number[][]> {
	if (!texts.length) return [];
	signal?.throwIfAborted();
	return await new Promise((accept, reject) => {
		const child = spawn(process.execPath, [resolve(getAuditAssetsDir(), "embedding-worker.mjs")], {
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		const vectors: number[][] = [];
		let pending = "",
			error = "",
			finished = false;
		const kill = () => {
			try {
				child.pid && process.platform !== "win32" ? process.kill(-child.pid, "SIGKILL") : child.kill("SIGKILL");
			} catch {}
		};
		const cancel = () => {
			kill();
			finish(Error("向量计算已取消或超时"));
		};
		const timeout = setTimeout(cancel, 600000);
		const finish = (reason?: Error) => {
			if (finished) return;
			finished = true;
			clearTimeout(timeout);
			signal?.removeEventListener("abort", cancel);
			if (reason) reject(reason);
			else accept(vectors);
		};
		signal?.addEventListener("abort", cancel, { once: true });
		child.stdin.on("error", () => {});
		child.stdout.on("data", (chunk) => {
			pending += chunk.toString("utf8");
			while (pending.includes("\n")) {
				const e = pending.indexOf("\n");
				const line = pending.slice(0, e);
				pending = pending.slice(e + 1);
				try {
					const item = JSON.parse(line);
					if (item.vectors) {
						for (let j = 0; j < item.vectors.length; j++) vectors[item.offset + j] = item.vectors[j];
						onProgress?.({
							phase: "embedding",
							completed: vectors.length,
							total: texts.length,
						});
					} else onProgress?.(item);
				} catch (err) {
					kill();
					finish(Error(`向量计算返回无效结果：${String(err)}`));
				}
			}
		});
		child.stderr.on("data", (chunk) => {
			error = (error + chunk).slice(-6000);
		});
		child.once("error", (e) => finish(e));
		child.once("close", (code) => {
			if (code !== 0) finish(Error(`真实向量模型失败：${error}`));
			else if (
				vectors.length !== texts.length ||
				vectors.some((v) => !v?.length || v.some((n) => !Number.isFinite(n)))
			)
				finish(Error("向量维度或数量无效"));
			else finish();
		});
		child.stdin.end(
			JSON.stringify({
				texts,
				model,
				revision,
				cache: resolve(DATA, "models"),
				proxy: process.env.AUDIT_EMBED_PROXY ?? GITHUB_PROXY,
			}),
		);
		if (signal?.aborted) cancel();
	});
}
export async function vectorSearch(
	cwd: string,
	args: { query: string; scope?: string; limit?: number; rebuild?: boolean },
	signal?: AbortSignal,
	onProgress?: (v: unknown) => void,
) {
	if (!args.query.trim()) throw Error("请填写语义检索问题");
	const limit = args.limit ?? 8;
	if (!Number.isSafeInteger(limit) || limit < 1) throw Error("limit 必须是正整数");
	const scan = await sourceFiles(cwd, args.scope, "vector", signal);
	const id = digest(`${scan.cwd}\n${scan.scope}\n${model}\n${revision}`),
		folder = resolve(DATA, "indexes", id),
		file = resolve(folder, "vectors.json");
	if (locks.has(id)) throw Error("该项目范围正在更新向量索引，请稍后重试");
	locks.add(id);
	try {
		let old: Index | undefined;
		if (!args.rebuild && existsSync(file))
			try {
				old = JSON.parse(readFileSync(file, "utf8"));
			} catch {}
		const chunks: Chunk[] = [],
			missing: Chunk[] = [];
		const cached = new Map((old?.chunks || []).map((c) => [`${c.path}:${c.startLine}:${c.sha256}`, c]));
		for (const source of scan.files) {
			const lines = source.text.split(/\r?\n/);
			let start = 0;
			while (start < lines.length) {
				let end = start,
					chars = 0;
				while (end < lines.length && end - start < 35 && (chars < 1000 || end === start)) {
					chars += lines[end].length + 1;
					end++;
				}
				const text = lines.slice(start, end).join("\n");
				const hash = digest(text),
					key = `${source.path}:${start + 1}:${hash}`;
				const existing = cached.get(key),
					chunk: Chunk = {
						path: source.path,
						startLine: start + 1,
						endLine: end,
						text,
						sha256: hash,
						vector: existing?.vector || [],
					};
				chunks.push(chunk);
				if (!chunk.vector.length) missing.push(chunk);
				start = Math.max(start + 1, end - 4);
				if (end === lines.length) break;
			}
		}
		onProgress?.({
			phase: "index",
			files: scan.files.length,
			chunks: chunks.length,
			newChunks: missing.length,
			model,
			revision,
		});
		const inputs = missing.map((c) => `passage: ${relative(scan.cwd, c.path)}\n${c.text}`);
		const vectors = await embed([...inputs, `query: ${args.query}`], signal, onProgress);
		for (let i = 0; i < missing.length; i++) missing[i].vector = vectors[i];
		const query = vectors.at(-1)!;
		const dimension = query.length;
		if (chunks.some((c) => c.vector.length !== dimension))
			throw Error("索引维度与当前模型不同，请 rebuild=true 重建");
		const index: Index = {
			schema: 1,
			model,
			revision,
			dimension,
			repository: scan.cwd,
			scope: scan.scope,
			updatedAt: new Date().toISOString(),
			files: scan.files.map((f) => ({ path: f.path, sha256: f.sha256 })),
			chunks,
			excluded: scan.excluded,
			complete: scan.enumerationComplete && scan.excluded.length === 0,
			rules: scan.rules,
		};
		signal?.throwIfAborted();
		mkdirSync(folder, { recursive: true });
		const temporary = `${file}.tmp`;
		writeFileSync(temporary, JSON.stringify(index), { mode: 0o600 });
		renameSync(temporary, file);
		const results = chunks
			.map((c) => {
				let score = 0;
				for (let i = 0; i < dimension; i++) score += query[i] * c.vector[i];
				return {
					path: c.path,
					startLine: c.startLine,
					endLine: c.endLine,
					sha256: c.sha256,
					score,
					text: c.text,
				};
			})
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);
		return {
			mode: "local-neural-vector-search",
			model,
			revision,
			dimension,
			query: args.query,
			scope: scan.scope,
			files: scan.files.length,
			chunks: chunks.length,
			embeddedChunks: missing.length,
			reusedChunks: chunks.length - missing.length,
			complete: index.complete,
			excluded: index.excluded,
			results,
			note: "Real normalized neural embeddings, cosine similarity; not a reachability or vulnerability verdict. Index refreshes source hashes and drops deleted chunks each query. Model input is capped at 512 tokens; long individual lines can be truncated by the model. Source excerpts and hashes permit direct verification.",
		};
	} finally {
		locks.delete(id);
	}
}
