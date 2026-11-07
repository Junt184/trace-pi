import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { analyzeSource } from "./code.ts";
import { pageNumbers } from "./git.ts";
import { javaServer } from "./java-server.ts";

const require = createRequire(import.meta.url);
type Position = { line: number; character: number };
type Range = { start: Position; end: Position };
type Location = { uri: string; range: Range };
type LocationLink = { targetUri: string; targetSelectionRange?: Range; targetRange: Range };
export type Definition = Location | LocationLink;
interface ServerInfo {
	capabilities: {
		referencesProvider?: boolean;
		definitionProvider?: boolean;
		positionEncoding?: string;
		executeCommandProvider?: { commands?: string[] };
	};
	serverInfo?: { name: string; version?: string };
}
interface Diagnostic {
	severity?: number;
	message: string;
	range: Range;
}
interface RpcMessage {
	id?: number;
	method?: string;
	params: {
		items: { section: string }[];
		uri: string;
		diagnostics: Diagnostic[];
		type: string;
		message: string;
	};
	result?: unknown;
	error?: { code: number; message: string };
}
export function languageServer(path: string) {
	const extension = extname(path);
	const language = /\.[cm]?[jt]sx?$/.test(extension)
		? "typescript"
		: extension === ".go"
			? "go"
			: extension === ".py"
				? "python"
				: [".php", ".phtml"].includes(extension)
					? "php"
					: extension === ".java"
						? "java"
						: "";
	const custom = JSON.parse(process.env.AUDIT_LSP_SERVERS || "{}");
	let command: string[] | undefined = custom[language];
	if (!command && language === "typescript")
		command = [process.execPath, require.resolve("typescript-language-server/lib/cli.mjs"), "--stdio"];
	if (!command && language === "python")
		command = [process.execPath, require.resolve("pyright/langserver.index.js"), "--stdio"];
	if (!command && language === "go") command = [process.env.GOPLS_PATH || "gopls"];
	if (!command && language === "php") command = [process.execPath, require.resolve("intelephense"), "--stdio"];
	if (!command && language === "java") return { language, ...javaServer() };
	if (!command?.length || command.some((v) => typeof v !== "string"))
		throw new Error("未配置该语言的语义服务器。可用 AUDIT_LSP_SERVERS 指定命令数组；不会回退为文本匹配。");
	return { language, command };
}
export function projectRoot(cwd: string, file: string) {
	let dir = dirname(file);
	const markers = [
		"composer.json",
		"tsconfig.json",
		"jsconfig.json",
		"go.work",
		"go.mod",
		"pyrightconfig.json",
		"pyproject.toml",
		"pom.xml",
		"build.gradle",
		"build.gradle.kts",
	];
	for (;;) {
		if (markers.some((name) => existsSync(resolve(dir, name)))) return dir;
		if (dir === cwd || dirname(dir) === dir) return cwd;
		dir = dirname(dir);
	}
}

// One server per query: no stale index or unmanaged long-lived process. All RPC work
// and its process group are cancelled together when Pi aborts the tool.
export class LspClient {
	child;
	private buffer = Buffer.alloc(0);
	private nextId = 0;
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private failure?: Error;
	private readyWaiters = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
	private stderr = "";
	private workspace?: string;
	private javaStatus?: string;
	private javaReady = false;
	private javaWaiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
	private logWaiters: {
		pattern: RegExp;
		resolve: () => void;
		reject: (e: Error) => void;
	}[] = [];
	diagnostics = new Map<string, Diagnostic[]>();
	messages: string[] = [];
	private cwd: string;
	private signal: AbortSignal;
	constructor(command: string[], cwd: string, signal: AbortSignal, configuration?: string) {
		this.cwd = cwd;
		this.signal = signal;
		signal.throwIfAborted();
		if (command.some((arg) => arg.includes("{workspace}"))) {
			this.workspace = mkdtempSync(resolve(tmpdir(), "trace-lsp-"));
			if (configuration)
				cpSync(configuration, resolve(this.workspace, "config"), {
					recursive: true,
				});
			command = command.map((arg) => arg.replaceAll("{workspace}", this.workspace!));
		}
		this.child = spawn(command[0], command.slice(1), {
			cwd,
			detached: process.platform !== "win32",
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child.on("error", (error) => {
			this.cleanup();
			this.fail(new Error(`语言服务器启动失败：${error.message}。请检查安装和 AUDIT_LSP_SERVERS 配置。`));
		});
		this.child.on("exit", (code, sig) => {
			this.cleanup();
			this.fail(new Error(`语言服务器退出 (${code ?? sig}) ${this.stderr.slice(-1800)}`));
		});
		this.child.stdin.on("error", (error) => this.fail(error));
		this.child.stderr.on("data", (chunk) => {
			this.stderr = (this.stderr + chunk).slice(-8000);
		});
		this.child.stdout.on("data", (chunk) => {
			this.buffer = Buffer.concat([this.buffer, chunk]);
			try {
				this.parse();
			} catch (error) {
				this.fail(error as Error);
				this.dispose();
			}
		});
		signal.addEventListener("abort", this.abort, { once: true });
	}
	private abort = () => {
		this.fail(new Error("语义查询已取消或超时"));
		this.dispose();
	};
	private fail(error: Error) {
		this.failure ??= error;
		for (const p of this.pending.values()) p.reject(error);
		this.pending.clear();
		for (const p of this.readyWaiters.values()) p.reject(error);
		this.readyWaiters.clear();
		for (const waiter of this.logWaiters) waiter.reject(error);
		this.logWaiters = [];
		for (const waiter of this.javaWaiters) waiter.reject(error);
		this.javaWaiters = [];
	}
	private send(message: object) {
		if (this.failure) throw this.failure;
		const data = JSON.stringify(message);
		this.child.stdin.write(`Content-Length: ${Buffer.byteLength(data)}\r\n\r\n${data}`);
	}
	notify(method: string, params?: object) {
		this.send({ jsonrpc: "2.0", method, params });
	}
	waitForDiagnostics(uri: string) {
		if (this.failure) return Promise.reject(this.failure);
		if (this.diagnostics.has(uri)) return Promise.resolve();
		return new Promise<void>((resolve, reject) => this.readyWaiters.set(uri, { resolve, reject }));
	}
	waitForMessage(pattern: RegExp) {
		if (this.failure) return Promise.reject(this.failure);
		if (this.messages.some((message) => pattern.test(message))) return Promise.resolve();
		return new Promise<void>((resolve, reject) => this.logWaiters.push({ pattern, resolve, reject }));
	}
	waitForJavaReady() {
		if (this.failure) return Promise.reject(this.failure);
		if (this.javaReady) return Promise.resolve();
		return new Promise<void>((resolve, reject) => this.javaWaiters.push({ resolve, reject }));
	}
	request<T = unknown>(method: string, params?: object): Promise<T> {
		if (this.failure) return Promise.reject(this.failure);
		const id = ++this.nextId;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
			try {
				this.send({ jsonrpc: "2.0", id, method, params });
			} catch (error) {
				this.pending.delete(id);
				reject(error);
			}
		});
	}
	private parse() {
		for (;;) {
			const end = this.buffer.indexOf("\r\n\r\n");
			if (end < 0) return;
			const length = Number(/Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, end).toString())?.[1]);
			if (!Number.isSafeInteger(length) || length < 0 || length > 32 * 1024 * 1024)
				throw new Error("无效的 LSP 响应长度");
			if (this.buffer.length < end + 4 + length) return;
			const message = JSON.parse(this.buffer.subarray(end + 4, end + 4 + length).toString()) as RpcMessage;
			this.buffer = this.buffer.subarray(end + 4 + length);
			if (message.method && message.id !== undefined) {
				this.messages.push(`Server request: ${message.method} ${JSON.stringify(message.params)}`);
				const result =
					message.method === "workspace/configuration"
						? message.params.items.map((item) =>
								item.section === "python"
									? { analysis: { diagnosticMode: "workspace" } }
									: item.section === "python.analysis"
										? { diagnosticMode: "workspace" }
										: {},
							)
						: message.method === "workspace/workspaceFolders"
							? [{ uri: pathToFileURL(this.cwd).href, name: this.cwd }]
							: null;
				this.send({ jsonrpc: "2.0", id: message.id, result });
			} else if (message.method === "textDocument/publishDiagnostics") {
				this.diagnostics.set(message.params.uri, message.params.diagnostics);
				this.readyWaiters.get(message.params.uri)?.resolve();
				this.readyWaiters.delete(message.params.uri);
			} else if (message.method === "language/status") {
				this.javaStatus = message.params.type;
				this.messages.push(`Java ${message.params.type}: ${message.params.message}`);
				if (this.javaStatus === "Error") this.fail(new Error(`Java 项目初始化失败：${message.params.message}`));
				if (this.javaStatus === "Started") {
					this.javaReady = true;
					for (const waiter of this.javaWaiters) waiter.resolve();
					this.javaWaiters = [];
				}
			} else if (message.method === "window/logMessage") {
				const text = String(message.params.message);
				this.messages.push(text);
				this.logWaiters = this.logWaiters.filter((waiter) => {
					if (!waiter.pattern.test(text)) return true;
					waiter.resolve();
					return false;
				});
			} else if (message.id !== undefined) {
				const p = this.pending.get(message.id);
				this.pending.delete(message.id);
				if (message.error) p?.reject(new Error(`LSP ${message.error.code}: ${message.error.message}`));
				else p?.resolve(message.result);
			}
		}
	}
	private cleanup() {
		if (this.workspace) rmSync(this.workspace, { recursive: true, force: true, maxRetries: 3 });
	}
	dispose() {
		this.signal.removeEventListener("abort", this.abort);
		if (this.child.pid) {
			try {
				process.platform === "win32" ? this.child.kill("SIGKILL") : process.kill(-this.child.pid, "SIGKILL");
			} catch {}
		}
		this.fail(new Error("语义查询已结束"));
	}
}
export function located(location: Definition) {
	const uri = "uri" in location ? location.uri : location.targetUri;
	const range = "range" in location ? location.range : location.targetSelectionRange || location.targetRange;
	let path: string | undefined;
	let text: string | undefined;
	try {
		path = fileURLToPath(uri);
		text = readFileSync(path, "utf8").split(/\r?\n/)[range.start.line];
	} catch {}
	return {
		uri,
		path,
		line: range.start.line + 1,
		column: range.start.character + 1,
		endLine: range.end.line + 1,
		endColumn: range.end.character + 1,
		text,
	};
}
export async function semanticReferences(
	cwd: string,
	args: {
		path: string;
		line: number;
		column: number;
		projectRoot?: string;
		includeDeclaration?: boolean;
		offset?: number;
		limit?: number;
		timeoutSeconds?: number;
	},
	signal?: AbortSignal,
) {
	cwd = realpathSync(cwd);
	const path = realpathSync(resolve(cwd, args.path));
	const text = readFileSync(path, "utf8");
	const lines = text.split(/\r?\n/);
	if (
		!Number.isSafeInteger(args.line) ||
		args.line < 1 ||
		args.line > lines.length ||
		!Number.isSafeInteger(args.column) ||
		args.column < 1 ||
		args.column > lines[args.line - 1].length + 1
	)
		throw new Error("line/column 必须指向源码中的位置，均从 1 开始；column 按 UTF-16 计数。");
	const seconds = args.timeoutSeconds ?? 90;
	if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("timeoutSeconds 必须大于 0");
	const server = languageServer(path);
	const { language, command } = server;
	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(), seconds * 1000);
	const cancel = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
	const root = args.projectRoot ? resolve(cwd, args.projectRoot) : projectRoot(cwd, path);
	let client: LspClient | undefined;
	try {
		client = new LspClient(command, root, cancel, "configuration" in server ? server.configuration : undefined);
		const info = await initializeLanguageServer(client, root, path, language, text);
		const uri = pathToFileURL(path).href;
		if (!info.capabilities.referencesProvider) throw new Error("语言服务器未提供 referencesProvider");
		const position = { line: args.line - 1, character: args.column - 1 };
		const definitions = info.capabilities.definitionProvider
			? await client.request<Definition[] | Definition | null>("textDocument/definition", {
					textDocument: { uri },
					position,
				})
			: [];
		const references: Location[] =
			(await client.request<Location[] | null>("textDocument/references", {
				textDocument: { uri },
				position,
				context: { includeDeclaration: args.includeDeclaration ?? true },
			})) || [];
		// Pyright reports the imported name separately from an explicit local alias.
		// Locate alias cursors by syntax tree, verify their definitions with the
		// server, then query the alias references. No text-match edges are added.
		if (language === "python") {
			const seed = (Array.isArray(definitions) ? definitions : definitions ? [definitions] : []).map(located);
			const visited = new Set<string>();
			const parsed = new Map<string, Awaited<ReturnType<typeof analyzeSource>>>();
			for (let i = 0; i < references.length; i++) {
				cancel.throwIfAborted();
				const ref = references[i];
				if (!ref.uri.startsWith("file:")) continue;
				let syntax = parsed.get(ref.uri);
				if (!syntax) {
					syntax = await analyzeSource(readFileSync(fileURLToPath(ref.uri), "utf8"), "python", cancel);
					parsed.set(ref.uri, syntax);
				}
				for (const alias of syntax.importAliases) {
					if (
						ref.range.start.line !== alias.line ||
						ref.range.start.character < alias.column ||
						ref.range.start.character >= alias.endColumn
					)
						continue;
					const key = `${ref.uri}:${alias.aliasLine}:${alias.aliasColumn}`;
					if (visited.has(key)) continue;
					visited.add(key);
					const cursor = {
						textDocument: { uri: ref.uri },
						position: { line: alias.aliasLine, character: alias.aliasColumn },
					};
					const targets = await client.request<Definition[] | Definition | null>(
						"textDocument/definition",
						cursor,
					);
					if (
						!(Array.isArray(targets) ? targets : targets ? [targets] : [])
							.map(located)
							.some((t) => seed.some((s) => s.uri === t.uri && s.line === t.line && s.column === t.column))
					)
						continue;
					references.push(
						...((await client.request<Location[] | null>("textDocument/references", {
							...cursor,
							context: { includeDeclaration: args.includeDeclaration ?? true },
						})) || []),
					);
				}
			}
		}
		const unique = [...new Map(references.map((v) => [`${v.uri}:${JSON.stringify(v.range)}`, v])).values()].sort(
			(a, b) =>
				a.uri.localeCompare(b.uri) ||
				a.range.start.line - b.range.start.line ||
				a.range.start.character - b.range.start.character,
		);
		const { offset, limit } = pageNumbers(args.offset, args.limit);
		const diagnostics = [...client.diagnostics.entries()].flatMap(([uri, values]) =>
			values.filter((v) => v.severity === 1).map((v) => ({ uri, message: v.message, range: v.range })),
		);
		return {
			mode: "language-server semantic references",
			language,
			server: info.serverInfo || { command: command[0] },
			projectRoot: root,
			path,
			line: args.line,
			column: args.column,
			sha256: createHash("sha256").update(text).digest("hex"),
			positionEncoding: "utf-16",
			definitions: (Array.isArray(definitions) ? definitions : definitions ? [definitions] : []).map(located),
			references: unique.slice(offset, offset + limit).map(located),
			total: unique.length,
			offset,
			nextOffset: offset + limit < unique.length ? offset + limit : null,
			diagnostics,
			serverMessages: client.messages.slice(-15),
			note: "References are resolved by the language server in this project/build configuration, not by name matching. Missing dependencies, dynamic dispatch/reflection, excluded files and server limitations can still omit references; a zero result does not prove unreachable code.",
		};
	} finally {
		clearTimeout(timer);
		client?.dispose();
	}
}

export async function initializeLanguageServer(
	client: LspClient,
	root: string,
	path: string,
	language: string,
	text: string,
) {
	const info = await client.request<ServerInfo>("initialize", {
		processId: process.pid,
		rootPath: root,
		rootUri: pathToFileURL(root).href,
		workspaceFolders: [{ uri: pathToFileURL(root).href, name: root }],
		initializationOptions:
			language === "typescript"
				? {
						tsserver: {
							path: require.resolve("typescript-lsp/lib/tsserver.js"),
							useSyntaxServer: "never",
						},
					}
				: language === "java"
					? { settings: { java: { autobuild: { enabled: false } } } }
					: undefined,
		capabilities: {
			general: { positionEncodings: ["utf-16"] },
			workspace: { configuration: true, workspaceFolders: true },
			textDocument: {
				definition: { linkSupport: true },
				publishDiagnostics: { relatedInformation: true },
			},
		},
	});
	if (info.capabilities.positionEncoding && info.capabilities.positionEncoding !== "utf-16")
		throw new Error("服务器没有选择 UTF-16 位置编码");
	client.notify("initialized", {});
	if (language === "java") await client.waitForJavaReady();
	const languageId =
		language === "typescript"
			? (/\.[cm]?jsx?$/.test(extname(path)) ? "javascript" : "typescript") +
				(extname(path).endsWith("x") ? "react" : "")
			: language;
	const uri = pathToFileURL(path).href;
	client.notify("textDocument/didOpen", {
		textDocument: { uri, languageId, version: 1, text },
	});
	if (language === "python") await client.waitForDiagnostics(uri);
	if (language === "php" && client.messages.some((message) => /Initialising intelephense/.test(message)))
		await client.waitForMessage(/Indexer: Indexing finished\./);
	if (
		language === "typescript" &&
		info.capabilities.executeCommandProvider?.commands?.includes("typescript.tsserverRequest")
	) {
		await client.request("workspace/executeCommand", {
			command: "typescript.tsserverRequest",
			arguments: ["projectInfo", { file: path, needFileNameList: true }, { expectsResult: true, isAsync: false }],
		});
	}

	return info;
}
