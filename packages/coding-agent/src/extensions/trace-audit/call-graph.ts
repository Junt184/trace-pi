import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { analyzeSource, type CodeSymbol } from "./code.ts";
import {
	type Definition,
	initializeLanguageServer,
	LspClient,
	languageServer,
	located,
	projectRoot,
} from "./semantic.ts";
import { digest, sourceFiles } from "./source-files.ts";
import type { AuditStore } from "./store.ts";

const callable = (s: CodeSymbol) => /function|method|constructor|class_declaration|class_definition/.test(s.kind);
export interface GraphNode extends Partial<CodeSymbol> {
	id: string;
	path: string;
	qualifiedName: string;
	external?: boolean;
}
export interface GraphEdge {
	from: string;
	to: string;
	line: number;
	column: number;
	path: string;
	binding: "definition";
	ambiguous: boolean;
}
interface UnresolvedCall {
	from: string;
	path: string;
	line: number;
	column: number;
	text: string;
	reason: string;
	definitions?: ReturnType<typeof located>[];
	error?: string;
}
type GraphError = { error: string; path?: string; paths?: string[]; uri?: string };
export interface CallGraph {
	schema: 1;
	repository: string;
	scope: string;
	generatedAt: string;
	files: { path: string; sha256: string }[];
	nodes: GraphNode[];
	edges: GraphEdge[];
	unresolved: UnresolvedCall[];
	errors: GraphError[];
	excluded: { path: string; reason: string }[];
	servers: { language: string; root: string; files: number; info?: unknown }[];
	coverage: {
		enumerationComplete: boolean;
		indexedFiles: number;
		callSites: number;
		resolvedCallSites: number;
		staticAnalysisComplete: boolean;
		runtimeComplete: boolean;
		selectionRules: string;
	};
	note: string;
}
const contains = (s: Partial<CodeSymbol>, line: number, column: number) =>
	s.startLine !== undefined &&
	(line > s.startLine || (line === s.startLine && column >= (s.startColumn || 1))) &&
	(line < s.endLine! || (line === s.endLine && column <= (s.endColumn || 1)));
export async function buildCallGraph(
	cwd: string,
	args: { scope?: string; timeoutSeconds?: number },
	store: AuditStore,
	runId: string,
	callId: string,
	signal?: AbortSignal,
	onProgress?: (value: unknown) => void,
) {
	const deadline = new AbortController();
	const seconds = args.timeoutSeconds ?? 180;
	if (!Number.isFinite(seconds) || seconds <= 0) throw Error("timeoutSeconds 必须大于 0");
	const timer = setTimeout(() => deadline.abort(), seconds * 1000);
	const cancel = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
	try {
		const scan = await sourceFiles(cwd, args.scope, "graph", cancel);
		const graph: CallGraph = {
			schema: 1,
			repository: scan.cwd,
			scope: scan.scope,
			generatedAt: new Date().toISOString(),
			files: [],
			nodes: [],
			edges: [],
			unresolved: [],
			errors: [],
			excluded: scan.excluded,
			servers: [],
			coverage: {
				enumerationComplete: scan.enumerationComplete,
				indexedFiles: 0,
				callSites: 0,
				resolvedCallSites: 0,
				staticAnalysisComplete: false,
				runtimeComplete: false,
				selectionRules: scan.rules,
			},
			note: "Project-wide static graph for the declared scope, no depth truncation. Edges use real language-server definitions; callbacks, reflection, dynamic dispatch, dependency/configuration gaps and implicit runtime calls can remain unresolved. runtimeComplete is always false; no universal runtime-completeness claim.",
		};
		const parsed = new Map<string, Awaited<ReturnType<typeof analyzeSource>>>();
		for (const file of scan.files) {
			cancel.throwIfAborted();
			try {
				const syntax = await analyzeSource(file.text, file.language!, cancel);
				parsed.set(file.path, syntax);
				graph.files.push({ path: file.path, sha256: file.sha256 });
				if (syntax.hasSyntaxErrors) graph.errors.push({ path: file.path, error: "syntax-errors" });
				graph.nodes.push({
					id: digest(`${file.path}:module`),
					path: file.path,
					qualifiedName: "<module>",
					kind: "module",
				});
				for (const symbol of syntax.symbols.filter(callable))
					graph.nodes.push({
						...symbol,
						path: file.path,
						id: digest(`${file.path}:${symbol.nameLine}:${symbol.nameColumn}`),
					});
			} catch (error) {
				cancel.throwIfAborted();
				graph.errors.push({ path: file.path, error: String(error) });
			}
		}
		type Call = Awaited<ReturnType<typeof analyzeSource>>["calls"][number] & {
			path: string;
			from: string;
		};
		const calls = new Map<string, Call[]>();
		const settled = new Set<Call>();
		for (const file of scan.files) {
			const syntax = parsed.get(file.path);
			if (!syntax) continue;
			calls.set(
				file.path,
				syntax.calls.map((call) => {
					const parents = graph.nodes.filter((n) => n.path === file.path && contains(n, call.line, call.column));
					parents.sort(
						(a, b) => a.endLine! - a.startLine! - (b.endLine! - b.startLine!) || b.startColumn! - a.startColumn!,
					);
					return {
						...call,
						path: file.path,
						from: (parents[0] || graph.nodes.find((n) => n.path === file.path && n.kind === "module"))!.id,
					};
				}),
			);
		}
		graph.coverage.callSites = [...calls.values()].reduce((n, items) => n + items.length, 0);
		const groups = new Map<string, { root: string; files: typeof scan.files }>();
		for (const file of scan.files) {
			if (!parsed.has(file.path)) continue;
			const root = projectRoot(scan.cwd, file.path);
			const language = /^(javascript|typescript|tsx)$/.test(file.language!) ? "typescript" : file.language!;
			const key = `${language}:${root}`;
			const group = groups.get(key) || { root, files: [] };
			group.files.push(file);
			groups.set(key, group);
		}
		for (const { files, root } of groups.values()) {
			let client: LspClient | undefined;
			try {
				const first = files[0];
				const server = languageServer(first.path);
				const { language, command } = server;
				client = new LspClient(command, root, cancel, "configuration" in server ? server.configuration : undefined);
				const info = await initializeLanguageServer(client, root, first.path, language, first.text);
				if (!info.capabilities.definitionProvider) throw Error("语言服务器未提供语义定义查询");
				graph.servers.push({
					language,
					root,
					files: files.length,
					info: info.serverInfo,
				});
				for (const file of files.slice(1))
					client.notify("textDocument/didOpen", {
						textDocument: {
							uri: pathToFileURL(file.path).href,
							languageId:
								language === "typescript"
									? (/\.[cm]?jsx?$/.test(file.path) ? "javascript" : "typescript") +
										(file.path.endsWith("x") ? "react" : "")
									: language,
							version: 1,
							text: file.text,
						},
					});
				for (const file of files) {
					if (language === "python") await client.waitForDiagnostics(pathToFileURL(file.path).href);
					graph.coverage.indexedFiles++;
					for (const call of calls.get(file.path)!) {
						cancel.throwIfAborted();
						const { from } = call;
						const unresolved = call;
						if (call.dynamic) {
							graph.unresolved.push({
								...unresolved,
								reason: "dynamic-callee",
							});
							settled.add(call);
							continue;
						}
						try {
							const defs = await client.request<Definition[] | Definition | null>("textDocument/definition", {
								textDocument: { uri: pathToFileURL(file.path).href },
								position: { line: call.line - 1, character: call.column - 1 },
							});
							const locations = (Array.isArray(defs) ? defs : defs ? [defs] : []).map(located);
							const targets: GraphNode[] = [];
							for (const loc of locations) {
								let target = graph.nodes.find(
									(n) =>
										n.path === loc.path &&
										((n.nameLine === loc.line && n.nameColumn === loc.column) ||
											(n.startLine === loc.line && n.startColumn === loc.column)),
								);
								if (!target && loc.path && !parsed.has(loc.path)) {
									// Outside the indexed scope: retain a semantic boundary, never infer its body.
									const id = digest(`${loc.uri}:${loc.line}:${loc.column}`);
									target = graph.nodes.find((n) => n.id === id);
									if (!target) {
										target = {
											id,
											path: loc.path,
											qualifiedName: call.text,
											nameLine: loc.line,
											nameColumn: loc.column,
											kind: "external-definition",
											external: true,
										};
										graph.nodes.push(target);
									}
								}
								if (
									target &&
									/new_expression|object_creation_expression/.test(call.kind) &&
									/class/.test(target.kind || "")
								) {
									const constructorNode = graph.nodes.find(
										(n) =>
											n.path === target!.path &&
											[
												`${target!.qualifiedName}.constructor`,
												`${target!.qualifiedName}.__construct`,
												`${target!.qualifiedName}.${target!.name}`,
											].includes(n.qualifiedName),
									);
									if (constructorNode) target = constructorNode;
								}
								if (target && !targets.some((t) => t.id === target!.id)) targets.push(target);
							}
							if (!targets.length)
								graph.unresolved.push({
									...unresolved,
									reason: locations.length ? "definition-is-not-an-indexed-callable" : "no-definition",
									definitions: locations,
								});
							else {
								graph.coverage.resolvedCallSites++;
								for (const to of targets)
									graph.edges.push({
										from,
										to: to.id,
										path: file.path,
										line: call.line,
										column: call.column,
										binding: "definition",
										ambiguous: targets.length > 1,
									});
							}
						} catch (error) {
							cancel.throwIfAborted();
							graph.unresolved.push({
								...unresolved,
								reason: "definition-error",
								error: String(error),
							});
						}
						settled.add(call);
					}
					onProgress?.({
						phase: "call-graph",
						file: relative(scan.cwd, file.path),
						...graph.coverage,
					});
				}
				const diagnostics = [...client.diagnostics.entries()].flatMap(([uri, items]) =>
					items.filter((d) => d.severity === 1).map((d) => ({ uri, error: d.message })),
				);
				graph.errors.push(...diagnostics);
			} catch (error) {
				signal?.throwIfAborted();
				graph.errors.push({
					paths: files.map((f) => f.path),
					error: deadline.signal.aborted ? "analysis-timeout" : String(error),
				});
			} finally {
				client?.dispose();
			}
			if (cancel.aborted) break;
		}
		// Every syntactic call is accounted for even when an entire server failed,
		// or a deadline prevented later language/project groups from being started.
		for (const items of calls.values())
			for (const call of items) {
				if (!settled.has(call))
					graph.unresolved.push({
						...call,
						reason: deadline.signal.aborted ? "analysis-timeout" : "language-server-error",
					});
			}
		graph.coverage.staticAnalysisComplete =
			scan.enumerationComplete &&
			graph.errors.length === 0 &&
			graph.excluded.length === 0 &&
			graph.coverage.indexedFiles === graph.files.length &&
			graph.unresolved.length === 0;
		const name = `call-graph-${callId.replace(/[^\w-]/g, "_")}.json`;
		mkdirSync(resolve(store.dir(runId), "artifacts"), { recursive: true });
		writeFileSync(resolve(store.dir(runId), "artifacts", name), JSON.stringify(graph), { mode: 0o600 });
		return {
			artifact: name,
			fullOutputPath: resolve(store.dir(runId), "artifacts", name),
			scope: graph.scope,
			nodes: graph.nodes.length,
			edges: graph.edges.length,
			unresolved: graph.unresolved.length,
			coverage: graph.coverage,
			errors: graph.errors,
			excluded: graph.excluded,
			servers: graph.servers,
			note: graph.note,
		};
	} finally {
		clearTimeout(timer);
	}
}
function readGraph(cwd: string, artifact: string, store: AuditStore, runId: string): CallGraph {
	if (basename(artifact) !== artifact || !artifact.startsWith("call-graph-"))
		throw Error("请选择该任务生成的调用图产物");
	const graph: CallGraph = JSON.parse(readFileSync(resolve(store.dir(runId), "artifacts", artifact), "utf8"));
	if (graph.schema !== 1 || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges))
		throw Error("不支持的调用图产物格式");
	if (realpathSync(cwd) !== graph.repository) throw Error("调用图属于其他项目，请在原项目中查询或重建");
	return graph;
}

async function sourceStatus(cwd: string, graph: CallGraph, signal?: AbortSignal) {
	signal?.throwIfAborted();
	const stale = graph.files
		.filter((f) => {
			try {
				return digest(readFileSync(f.path, "utf8")) !== f.sha256;
			} catch {
				return true;
			}
		})
		.map((f) => f.path);
	let addedFiles: string[] = [];
	let freshnessError: string | undefined;
	try {
		const current = await sourceFiles(cwd, graph.scope, "graph", signal);
		const indexed = new Set(graph.files.map((f) => f.path));
		const currentPaths = new Set(current.files.map((f) => f.path));
		for (const file of graph.files)
			if (!currentPaths.has(file.path) && !stale.includes(file.path)) stale.push(file.path);
		addedFiles = current.files.filter((f) => !indexed.has(f.path)).map((f) => f.path);
		if (!current.enumerationComplete) freshnessError = "源码枚举未完成";
		else if (current.excluded.length) freshnessError = "部分文件被排除，无法完整确认范围内源码是否变化";
	} catch (error) {
		signal?.throwIfAborted();
		freshnessError = String(error);
	}
	return {
		staleFiles: stale,
		addedFiles,
		freshness: freshnessError ? "unknown" : stale.length || addedFiles.length ? "stale" : "unchanged",
		freshnessError,
		generatedAt: graph.generatedAt,
	};
}

export async function callGraphStatus(
	cwd: string,
	artifact: string,
	store: AuditStore,
	runId: string,
	signal?: AbortSignal,
) {
	return sourceStatus(cwd, readGraph(cwd, artifact, store, runId), signal);
}

export async function queryCallGraph(
	cwd: string,
	args: {
		artifact: string;
		symbol?: string;
		path?: string;
		direction?: "incoming" | "outgoing" | "both";
		transitive?: boolean;
		offset?: number;
		limit?: number;
	},
	store: AuditStore,
	runId: string,
	signal?: AbortSignal,
) {
	signal?.throwIfAborted();
	const graph = readGraph(cwd, args.artifact, store, runId);
	const selected = graph.nodes.filter(
		(n) =>
			(!args.symbol || n.qualifiedName.includes(args.symbol)) && (!args.path || n.path === resolve(cwd, args.path)),
	);
	const reached = new Set(selected.map((n) => n.id));
	const edges = new Set<GraphEdge>();
	let added = true;
	while (added) {
		added = false;
		for (const edge of graph.edges) {
			const match =
				(args.direction !== "incoming" && reached.has(edge.from)) ||
				(args.direction !== "outgoing" && reached.has(edge.to));
			if (match) {
				edges.add(edge);
				for (const id of [edge.from, edge.to])
					if (!reached.has(id) && args.transitive) {
						reached.add(id);
						added = true;
					}
			}
		}
		if (!args.transitive) break;
	}
	const all = [...edges];
	const nodeIds = new Set(selected.map((node) => node.id));
	for (const edge of all) {
		nodeIds.add(edge.from);
		nodeIds.add(edge.to);
	}
	const offset = args.offset ?? 0,
		limit = args.limit ?? 100;
	if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit <= 0)
		throw Error("无效分页");
	return {
		selected,
		edges: all.slice(offset, offset + limit),
		nodes: graph.nodes.filter((node) => nodeIds.has(node.id)),
		totalEdges: all.length,
		nextOffset: offset + limit < all.length ? offset + limit : null,
		unresolved: graph.unresolved.filter((v) => reached.has(v.from)),
		...(await sourceStatus(cwd, graph, signal)),
		coverage: graph.coverage,
		note: graph.note,
	};
}
