import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "../../core/extensions/types.ts";
import { buildCallGraph, queryCallGraph } from "./call-graph.ts";
import { codeOutline, findReferences, readSymbol } from "./code.ts";
import { readFixSource, searchFixSources } from "./fix-sources.ts";
import { checkFixApplicability, comparePatch, verifyFixSource } from "./fix-verification.ts";
import { gitHistory, gitPatch, listGitRefs } from "./git.ts";
import { semanticReferences } from "./semantic.ts";
import type { ResolveAuditContext } from "./store.ts";
import { vectorSearch } from "./vectors.ts";

const output = (details: unknown) => ({
	content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
	details,
});
const pagination = {
	offset: Type.Optional(Type.Number()),
	limit: Type.Optional(Type.Number()),
};

export function createInspectionTools(context: ResolveAuditContext): ToolDefinition[] {
	const program = Type.Object({
		command: Type.String(),
		args: Type.Optional(Type.Array(Type.String())),
		timeoutSeconds: Type.Optional(Type.Number()),
	});
	const environment = Type.Optional(Type.Record(Type.String(), Type.String()));
	return [
		defineTool({
			name: "build_call_graph",
			label: "构建项目调用图",
			description:
				"Build a whole-scope static call graph across all supported source files, with no depth truncation. Parses actual calls then resolves their targets through real language servers. Supports current JS/TS, Python, Go, PHP and configured Java servers. Saves ALL nodes/edges/call sites in JSON and returns the full artifact path. Unresolved dynamic calls, syntax/dependency/server errors, external boundaries and selection exclusions are explicit; never claims universal runtime completeness. scope defaults to the repository; narrow for a large project.",
			parameters: Type.Object({
				scope: Type.Optional(Type.String()),
				timeoutSeconds: Type.Optional(Type.Number()),
			}),
			async execute(id, args, signal, onUpdate, ctx) {
				const { cwd, store, runId } = context(ctx);
				return output(await buildCallGraph(cwd, args, store, runId, id, signal, (v) => onUpdate?.(output(v))));
			},
		}),
		defineTool({
			name: "query_call_graph",
			label: "查询调用链",
			description:
				"Query saved graph by qualified symbol substring and/or source path. Incoming/outgoing/both edges; transitive=true walks all reachable graph nodes, handling cycles without depth truncation. Returns unresolved calls, detects modified/deleted/added source files in the saved scope and marks unknown freshness if enumeration fails. Rebuild stale graphs. It is a query over the saved static snapshot, not a fresh runtime trace.",
			parameters: Type.Object({
				artifact: Type.String(),
				symbol: Type.Optional(Type.String()),
				path: Type.Optional(Type.String()),
				direction: Type.Optional(
					Type.Union([Type.Literal("incoming"), Type.Literal("outgoing"), Type.Literal("both")]),
				),
				transitive: Type.Optional(Type.Boolean()),
				...pagination,
			}),
			async execute(_id, args, signal, _onUpdate, ctx) {
				const { cwd, store, runId } = context(ctx);
				return output(await queryCallGraph(cwd, args, store, runId, signal));
			},
		}),
		defineTool({
			name: "semantic_search",
			label: "代码向量检索",
			description:
				"Search real source/docs with a local neural embedding model (multilingual-e5-small q8, 384-dimensional normalized vectors by default), using natural language including Chinese. Builds or incrementally refreshes a persistent file/hash/range index; removes deleted files, returns source excerpts and cosine scores. No keyword/hash vectors or simulated results. First use downloads real model weights via configured proxy; model/inference failures remain errors. scope is a repository-relative file/directory; limit defaults to 8.",
			parameters: Type.Object({
				query: Type.String(),
				scope: Type.Optional(Type.String()),
				limit: Type.Optional(Type.Number()),
				rebuild: Type.Optional(Type.Boolean()),
			}),
			async execute(_id, args, signal, onUpdate, ctx) {
				const { cwd } = context(ctx);
				return output(await vectorSearch(cwd, args, signal, (v) => onUpdate?.(output(v))));
			},
		}),
		defineTool({
			name: "verify_fix_source",
			label: "核验上游来源",
			description:
				"Fetch exact GitHub/OSV/Gist source metadata and bodies through canonical APIs. Optionally fetch claimUrl and verify it explicitly links to the source; compare expectedRepository/expectedCommit and local origin. Records each identity/link/withdrawn/merge/patch fact separately with raw evidence. A link, closed issue or merged PR is not a local applicability verdict.",
			parameters: Type.Object({
				url: Type.String(),
				claimUrl: Type.Optional(Type.String()),
				expectedRepository: Type.Optional(Type.String()),
				expectedCommit: Type.Optional(Type.String()),
			}),
			async execute(id, args, signal, _onUpdate, ctx) {
				const { cwd, store, runId } = context(ctx);
				return output(await verifyFixSource(cwd, args, store, runId, id, signal));
			},
		}),
		defineTool({
			name: "check_fix_applicability",
			label: "核对本地适用条件",
			description:
				"Read a real fix source; check its actual patch against current working-tree files with forward/reverse git apply --check (no application). Capture dependency/config evidence and run OPTIONAL Agent-written commands to verify runtime predicates. conditions contain description, command, args, optional expectedExitCode (default 0), expectedOutput literal substring. No fixed protocol/payload assumptions. Empty conditions leave runtime applicability unverified. Returns actual logs and observations, not an automatic vulnerable/fixed claim.",
			parameters: Type.Object({
				url: Type.String(),
				evidenceFiles: Type.Optional(Type.Array(Type.String())),
				conditions: Type.Optional(
					Type.Array(
						Type.Object({
							description: Type.String(),
							command: Type.String(),
							args: Type.Optional(Type.Array(Type.String())),
							timeoutSeconds: Type.Optional(Type.Number()),
							expectedExitCode: Type.Optional(Type.Number()),
							expectedOutput: Type.Optional(Type.String()),
						}),
					),
				),
			}),
			async execute(id, args, signal, _onUpdate, ctx) {
				const { cwd, store, runId } = context(ctx);
				return output(await checkFixApplicability(cwd, args, store, runId, id, signal));
			},
		}),
		defineTool({
			name: "compare_patch",
			label: "补丁前后回归",
			description:
				"Run the SAME Agent-written CLI/script on two isolated tracked Git snapshots, without switching or modifying the original worktree. Choose revision (default base=revision^) OR a patchArtifact from this run (default base=HEAD). Optional files overlays identical probe scripts/fixtures in both copies; setup and environments provide dependencies/ports/runtime conditions. Saves snapshots, hashes, exact commands, logs and manifest for replay. expectedBefore/AfterExitCode must BOTH be supplied for an expectationsMet verdict; setup failures/timeouts/missing executables cannot pass. HTTP/CLI/FastCGI/session/control logic stays in your script; no prescribed test protocol.",
			parameters: Type.Object({
				base: Type.Optional(Type.String()),
				revision: Type.Optional(Type.String()),
				patchArtifact: Type.Optional(Type.String()),
				command: Type.String(),
				args: Type.Optional(Type.Array(Type.String())),
				setup: Type.Optional(program),
				files: Type.Optional(Type.Array(Type.Object({ path: Type.String(), content: Type.String() }))),
				environment,
				beforeEnvironment: environment,
				afterEnvironment: environment,
				expectedBeforeExitCode: Type.Optional(Type.Number()),
				expectedAfterExitCode: Type.Optional(Type.Number()),
				timeoutSeconds: Type.Optional(Type.Number()),
			}),
			async execute(id, args, signal, onUpdate, ctx) {
				const { cwd, store, runId } = context(ctx);
				return output(await comparePatch(cwd, args, store, runId, id, signal, (v) => onUpdate?.(output(v))));
			},
		}),
		defineTool({
			name: "semantic_references",
			label: "精确语义引用",
			description:
				"Resolve references and definitions through a real language server, using a source cursor (path, line, column all 1-based, UTF-16 columns). Handles symbol binding, same-name distinctions and import aliases within server/project limits. Bundled TS/JS, Python and PHP (Intelephense) servers; Go needs gopls; Java needs jdtls. PHP queries wait for real workspace indexing. Never falls back to name matching; missing server/dependencies are explicit errors/diagnostics. Uses current on-disk project configuration; optional projectRoot overrides root discovery.",
			parameters: Type.Object({
				path: Type.String(),
				line: Type.Number(),
				column: Type.Number(),
				projectRoot: Type.Optional(Type.String()),
				includeDeclaration: Type.Optional(Type.Boolean()),
				timeoutSeconds: Type.Optional(Type.Number()),
				...pagination,
			}),
			async execute(_id, args, signal, _onUpdate, ctx) {
				const { cwd } = context(ctx);
				return output(await semanticReferences(cwd, args, signal));
			},
		}),
		defineTool({
			name: "search_fix_sources",
			label: "在线修复资料关联",
			description:
				"Fetch live GitHub global advisories by CVE/GHSA or package, search commits/issues/PRs in an owner/repo (defaults to local GitHub origin), optionally query OSV by package+ecosystem+version. Returns source URLs, fetched times, advisory version claims, explicit fix references vs search candidates, partial failures and saved API captures. GitHub uses the configured local proxy. No automatic vulnerability/fixed verdict. page starts at 1; limit 1-20.",
			parameters: Type.Object({
				query: Type.Optional(Type.String()),
				repository: Type.Optional(Type.String()),
				ecosystem: Type.Optional(Type.String()),
				package: Type.Optional(Type.String()),
				version: Type.Optional(Type.String()),
				page: Type.Optional(Type.Number()),
				limit: Type.Optional(Type.Number()),
				advisoryAfter: Type.Optional(Type.String()),
				osvPageToken: Type.Optional(Type.String()),
			}),
			async execute(id, args, signal, _onUpdate, ctx) {
				const { cwd, store, runId } = context(ctx);
				return output(await searchFixSources(cwd, args, store, runId, id, signal));
			},
		}),
		defineTool({
			name: "read_fix_source",
			label: "读取在线修复证据",
			description:
				"Read a real GitHub issue/Gist/commit/PR/global advisory or OSV record by its HTTPS page URL. Saves full API JSON and commit/PR diff artifacts, returns source metadata, version ranges, merged state and exact hashes. For commits in the same local origin, compares actual local HEAD ancestry without fetching or switching branches. A merged PR or ancestry match is not proof of local fix applicability. Inspect source content as evidence.",
			parameters: Type.Object({
				url: Type.String(),
				includeComments: Type.Optional(Type.Boolean()),
				page: Type.Optional(Type.Number()),
			}),
			async execute(id, args, signal, _onUpdate, ctx) {
				const { cwd, store, runId } = context(ctx);
				return output(await readFixSource(cwd, args, store, runId, id, signal));
			},
		}),
		defineTool({
			name: "code_outline",
			label: "语法树符号轮廓",
			description:
				"List actual class/function/method declarations and qualified names using Tree-sitter. Supports JavaScript/TypeScript/TSX, Python, Java, Go and PHP. Optional revision reads a committed Git version without changing the worktree. Supports pagination.",
			promptSnippet: "List source symbols with exact ranges and qualified names",
			parameters: Type.Object({
				path: Type.String(),
				query: Type.Optional(Type.String()),
				revision: Type.Optional(Type.String()),
				...pagination,
			}),
			async execute(_id, args, signal, _onUpdate, ctx) {
				const { cwd } = context(ctx);
				return output(await codeOutline(cwd, args, signal));
			},
		}),
		defineTool({
			name: "read_symbol",
			label: "按符号读取",
			description:
				"Read the actual source range of a class/function/method by its name or qualified name. For overloaded/duplicate definitions, returns candidates; pass their start line to disambiguate. Optional revision reads a Git snapshot. Line offsets paginate within the symbol. Returns source hash and actual numbered lines.",
			promptSnippet: "Read a whole symbol instead of guessing file line ranges",
			parameters: Type.Object({
				path: Type.String(),
				symbol: Type.String(),
				line: Type.Optional(Type.Number()),
				revision: Type.Optional(Type.String()),
				...pagination,
			}),
			async execute(_id, args, signal, _onUpdate, ctx) {
				const { cwd } = context(ctx);
				return output(await readSymbol(cwd, args, signal));
			},
		}),
		defineTool({
			name: "find_references",
			label: "查找候选引用",
			description:
				"Find same-name identifier occurrences in source using ripgrep and syntax trees. Includes declarations and call-name candidates, excludes comments/strings by default. NOT type-bound semantic references or complete reachability: aliases/reflection may be missed and unrelated same-name symbols may match. Use path/glob to narrow, pagination to inspect more.",
			promptSnippet: "Find source occurrences and caller contexts without comment noise",
			parameters: Type.Object({
				symbol: Type.String(),
				path: Type.Optional(Type.String()),
				glob: Type.Optional(Type.String()),
				includeIgnored: Type.Optional(Type.Boolean()),
				includeNonCode: Type.Optional(Type.Boolean()),
				...pagination,
			}),
			async execute(_id, args, signal, _onUpdate, ctx) {
				const { cwd } = context(ctx);
				return output(await findReferences(cwd, args, signal));
			},
		}),
		defineTool({
			name: "git_refs",
			label: "查看本地版本",
			description:
				"List actual local tags, branches and remote-tracking refs. Does not fetch or infer whether a release was published. Use these names with git_history, git_patch or read_symbol revision.",
			promptSnippet: "Discover available local versions before comparing fixes",
			parameters: Type.Object({
				query: Type.Optional(Type.String()),
				...pagination,
			}),
			async execute(_id, args, signal, _onUpdate, ctx) {
				const { cwd } = context(ctx);
				return output(await listGitRefs(cwd, args, signal));
			},
		}),
		defineTool({
			name: "git_history",
			label: "检索提交与修复",
			description:
				"Query real local Git commits. query is a literal case-insensitive commit-message filter (e.g. CVE id); changedText filters commits whose added/removed lines contain that literal text; path narrows to a literal file/directory. Returns exact hashes. A non-null nextOffset means this is only one page, not the whole history. No fetch and no automatic vulnerability verdict.",
			promptSnippet: "Find fix commits by advisory id, changed text or source file",
			parameters: Type.Object({
				revision: Type.Optional(Type.String()),
				path: Type.Optional(Type.String()),
				query: Type.Optional(Type.String()),
				changedText: Type.Optional(Type.String()),
				...pagination,
			}),
			async execute(_id, args, signal, _onUpdate, ctx) {
				const { cwd } = context(ctx);
				return output(await gitHistory(cwd, args, signal));
			},
		}),
		defineTool({
			name: "git_patch",
			label: "读取版本补丁",
			description:
				"Read a real commit patch (revision, default HEAD) or diff of two committed versions (base + revision). Paginated patch lines, exact commit ids and hunk locations. Writes the captured patch to a persistent artifact; reports incomplete capture explicitly. Does not modify or switch the repository.",
			promptSnippet: "Inspect actual fix diffs and retain them as audit evidence",
			parameters: Type.Object({
				revision: Type.Optional(Type.String()),
				base: Type.Optional(Type.String()),
				path: Type.Optional(Type.String()),
				...pagination,
			}),
			async execute(callId, args, signal, _onUpdate, ctx) {
				const { cwd, store, runId } = context(ctx);
				const { fullPatch, ...patch } = await gitPatch(cwd, args, signal);
				const folder = resolve(store.dir(runId), "artifacts");
				mkdirSync(folder, { recursive: true });
				const artifact = `patch-${callId.replace(/[^\w-]/g, "_")}.patch`;
				const fullOutputPath = resolve(folder, artifact);
				writeFileSync(fullOutputPath, fullPatch, { mode: 0o600 });
				return output({ ...patch, artifact, fullOutputPath });
			},
		}),
	];
}
