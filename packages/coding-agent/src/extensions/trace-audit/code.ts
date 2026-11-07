import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, relative, resolve } from "node:path";
import type { Node as SyntaxNode } from "@vscode/tree-sitter-wasm";
import binding from "@vscode/tree-sitter-wasm";
import { historicSource, pageNumbers, readProcess } from "./git.ts";

const require = createRequire(import.meta.url);
const { Parser, Language } = binding;
const wasm = (name: string) => require.resolve(`@vscode/tree-sitter-wasm/wasm/${name}`);
const initialization = Parser.init({ locateFile: (file) => wasm(file) });
const languages = new Map<string, Promise<InstanceType<typeof Language>>>();
const extensions: Record<string, string> = {
	".ts": "typescript",
	".mts": "typescript",
	".cts": "typescript",
	".tsx": "tsx",
	".js": "javascript",
	".jsx": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".py": "python",
	".java": "java",
	".go": "go",
	".php": "php",
	".phtml": "php",
};
export const sourceLanguage = (path: string) => extensions[extname(path).toLowerCase()];
export const SUPPORTED_LANGUAGES = ["JavaScript", "TypeScript / TSX", "Python", "Java", "Go", "PHP"];
const declarations = new Set([
	"function_declaration",
	"function_signature",
	"generator_function_declaration",
	"function_definition",
	"class_definition",
	"class_declaration",
	"abstract_class_declaration",
	"method_definition",
	"method_declaration",
	"method_signature",
	"abstract_method_signature",
	"constructor_declaration",
	"interface_declaration",
	"enum_declaration",
	"type_alias_declaration",
	"annotation_type_declaration",
	"record_declaration",
	"type_spec",
]);
const nameNodes = new Set([
	"name",
	"identifier",
	"property_identifier",
	"field_identifier",
	"type_identifier",
	"shorthand_property_identifier",
	"shorthand_property_identifier_pattern",
]);
const callNodes = new Set([
	"function_call_expression",
	"member_call_expression",
	"nullsafe_member_call_expression",
	"scoped_call_expression",
	"call_expression",
	"call",
	"method_invocation",
	"new_expression",
	"object_creation_expression",
]);

export interface CodeSymbol {
	name: string;
	qualifiedName: string;
	kind: string;
	startLine: number;
	startColumn: number;
	endLine: number;
	endColumn: number;
	nameLine: number;
	nameColumn: number;
	signature: string;
}
interface SourceOrigin {
	path: string;
	revision: string;
	sha256: string;
	language?: string;
}
interface OutlineResult extends SourceOrigin {
	supported: boolean;
	engine?: "tree-sitter";
	supportedLanguages?: string[];
	note?: string;
	totalLines?: number;
	hasSyntaxErrors?: boolean;
	declarations?: CodeSymbol[];
	total?: number;
	offset?: number;
	nextOffset?: number | null;
}
interface SymbolResult extends SourceOrigin {
	supported: boolean;
	found: boolean;
	ambiguous?: boolean;
	candidates?: CodeSymbol[];
	supportedLanguages?: string[];
	note?: string;
	symbol?: CodeSymbol;
	hasSyntaxErrors?: boolean;
	offset?: number;
	nextOffset?: number | null;
	code?: string;
}
interface Occurrence {
	name: string;
	line: number;
	column: number;
	kind: string;
	container?: string;
}

async function sourceFile(cwd: string, path: string, revision?: string, signal?: AbortSignal) {
	const file = resolve(cwd, path);
	const source = revision
		? await historicSource(cwd, path, revision, signal)
		: { text: readFileSync(file, "utf8"), revision: "working-tree" };
	if (source.text.includes("\0")) throw new Error("这是二进制文件，请选择源代码文件。");
	return {
		...source,
		path: file,
		sha256: createHash("sha256").update(source.text).digest("hex"),
		language: extensions[extname(file).toLowerCase()],
	};
}

export async function analyzeSource(text: string, language: string, signal?: AbortSignal) {
	await initialization;
	if (signal?.aborted) throw new Error("代码分析已取消");
	let grammar = languages.get(language);
	if (!grammar) {
		grammar = Language.load(wasm(`tree-sitter-${language}.wasm`));
		languages.set(language, grammar);
	}
	const parser = new Parser();
	parser.setLanguage(await grammar);
	const tree = parser.parse(text);
	if (!tree) {
		parser.delete();
		throw new Error("解析器没有返回语法树");
	}
	const symbols: CodeSymbol[] = [];
	const importAliases: {
		line: number;
		column: number;
		endLine: number;
		endColumn: number;
		aliasLine: number;
		aliasColumn: number;
	}[] = [];
	const calls: {
		line: number;
		column: number;
		text: string;
		dynamic: boolean;
		kind: string;
	}[] = [];
	const occurrences: Occurrence[] = [];
	const declaredNames = new Set<number>();
	const classScope = (name: SyntaxNode) => name.text.replace(/^["']|["']$/g, "");
	function visit(node: SyntaxNode, scopes: string[]) {
		let nextScopes = scopes;
		let name = node.childForFieldName("name");
		if (callNodes.has(node.type)) {
			const expression =
				node.childForFieldName("function") ||
				node.childForFieldName("name") ||
				node.childForFieldName("constructor") ||
				node.childForFieldName("type") ||
				(node.type === "object_creation_expression"
					? node.namedChildren.find(
							(child) => child && ["name", "qualified_name", "variable_name"].includes(child.type),
						)
					: undefined);
			const target =
				expression?.childForFieldName("property") ||
				expression?.childForFieldName("attribute") ||
				expression?.childForFieldName("field") ||
				(expression?.type === "qualified_name" ? expression.namedChildren.at(-1) : undefined) ||
				expression;
			const dynamic =
				!target ||
				![
					"identifier",
					"property_identifier",
					"field_identifier",
					"name",
					"qualified_name",
					"type_identifier",
					"generic_type",
				].includes(target.type);
			calls.push({
				line: (target || node).startPosition.row + 1,
				column: (target || node).startPosition.column + 1,
				text: (expression || node).text.slice(0, 250),
				dynamic,
				kind: node.type,
			});
		}
		if (language === "python" && node.type === "aliased_import") {
			const alias = node.childForFieldName("alias");
			if (name && alias)
				importAliases.push({
					line: name.startPosition.row,
					column: name.startPosition.column,
					endLine: name.endPosition.row,
					endColumn: name.endPosition.column,
					aliasLine: alias.startPosition.row,
					aliasColumn: alias.startPosition.column,
				});
		}
		const value = node.childForFieldName("value");
		const callableAssignment =
			["variable_declarator", "field_definition", "public_field_definition", "property_definition"].includes(
				node.type,
			) &&
			value &&
			["arrow_function", "function_expression", "generator_function"].includes(value.type);
		if (declarations.has(node.type) || callableAssignment) {
			if (!name && node.type === "constructor_declaration")
				name = node.namedChildren.find((child) => child?.type === "identifier") || null;
			if (name) {
				let parents = scopes;
				if (language === "go" && node.type === "method_declaration") {
					const receiver = node.childForFieldName("receiver");
					const receiverType = receiver?.namedChildren[0]
						?.childForFieldName("type")
						?.text.replace(/^\*/, "")
						.replace(/\[.*$/, "");
					if (receiverType) parents = [...scopes, receiverType];
				}
				const symbolName = classScope(name);
				const qualifiedName = [...parents, symbolName].join(".");
				const outer = node.parent?.type === "decorated_definition" ? node.parent : node;
				const body = node.childForFieldName("body") || value?.childForFieldName("body");
				const headerLines = Math.max(
					1,
					Math.min(4, (body?.startPosition.row ?? outer.startPosition.row) - outer.startPosition.row + 1),
				);
				symbols.push({
					name: symbolName,
					qualifiedName,
					kind: callableAssignment ? "function_assignment" : node.type,
					startLine: outer.startPosition.row + 1,
					startColumn: outer.startPosition.column + 1,
					endLine: outer.endPosition.row + 1,
					endColumn: outer.endPosition.column + 1,
					nameLine: name.startPosition.row + 1,
					nameColumn: name.startPosition.column + 1,
					signature: outer.text.split("\n").slice(0, headerLines).join("\n").trim(),
				});
				declaredNames.add(name.startIndex);
				nextScopes = [...parents, symbolName];
			}
		}
		if (nameNodes.has(node.type)) {
			const parent = node.parent;
			const call =
				parent && callNodes.has(parent.type)
					? parent
					: parent?.parent && callNodes.has(parent.parent.type)
						? parent.parent
						: null;
			const callee =
				call?.childForFieldName("function") ||
				call?.childForFieldName("name") ||
				call?.childForFieldName("constructor") ||
				call?.childForFieldName("type");
			const kind = declaredNames.has(node.startIndex)
				? "declaration"
				: callee && node.startIndex >= callee.startIndex && node.endIndex <= callee.endIndex
					? "call-name"
					: "reference";
			occurrences.push({
				name: node.text,
				line: node.startPosition.row + 1,
				column: node.startPosition.column + 1,
				kind,
				container: scopes.join(".") || undefined,
			});
		}
		if (
			[
				"arrow_function",
				"lambda",
				"lambda_expression",
				"anonymous_function",
				"anonymous_function_creation_expression",
				"function_expression",
			].includes(node.type) &&
			!callableAssignment &&
			!["variable_declarator", "field_definition", "public_field_definition", "property_definition"].includes(
				node.parent?.type || "",
			)
		) {
			const label = `<anonymous@${node.startPosition.row + 1}:${node.startPosition.column + 1}>`;
			symbols.push({
				name: label,
				qualifiedName: [...scopes, label].join("."),
				kind: "anonymous_function",
				startLine: node.startPosition.row + 1,
				startColumn: node.startPosition.column + 1,
				endLine: node.endPosition.row + 1,
				endColumn: node.endPosition.column + 1,
				nameLine: node.startPosition.row + 1,
				nameColumn: node.startPosition.column + 1,
				signature: node.text.split("\n")[0].slice(0, 200),
			});
			nextScopes = [...scopes, label];
		}
		let namespace = nextScopes;
		for (const child of node.namedChildren)
			if (child) {
				if (
					language === "php" &&
					node.type === "program" &&
					child.type === "namespace_definition" &&
					!child.childForFieldName("body")
				)
					namespace = [child.childForFieldName("name")?.text || ""];
				visit(child, namespace);
			}
	}
	try {
		visit(tree.rootNode, []);
		return {
			symbols,
			occurrences,
			calls,
			importAliases,
			hasSyntaxErrors: tree.rootNode.hasError,
		};
	} finally {
		tree.delete();
		parser.delete();
	}
}

export async function codeOutline(
	cwd: string,
	args: {
		path: string;
		query?: string;
		revision?: string;
		offset?: number;
		limit?: number;
	},
	signal?: AbortSignal,
): Promise<OutlineResult> {
	const { offset, limit } = pageNumbers(args.offset, args.limit ?? 100);
	const source = await sourceFile(cwd, args.path, args.revision, signal);
	const { text: _, ...origin } = source;
	if (!source.language)
		return {
			...origin,
			supported: false,
			supportedLanguages: SUPPORTED_LANGUAGES,
			note: "此类型尚无符号解析器，仍可用 read/bash 阅读。",
		};
	const analysis = await analyzeSource(source.text, source.language, signal);
	const symbols = analysis.symbols.filter(
		(symbol) => !args.query || symbol.qualifiedName.toLowerCase().includes(args.query.toLowerCase()),
	);
	return {
		...origin,
		engine: "tree-sitter",
		supported: true,
		totalLines: source.text.split("\n").length,
		hasSyntaxErrors: analysis.hasSyntaxErrors,
		declarations: symbols.slice(offset, offset + limit),
		total: symbols.length,
		offset,
		nextOffset: offset + limit < symbols.length ? offset + limit : null,
	};
}

export async function readSymbol(
	cwd: string,
	args: {
		path: string;
		symbol: string;
		revision?: string;
		line?: number;
		offset?: number;
		limit?: number;
	},
	signal?: AbortSignal,
): Promise<SymbolResult> {
	const { offset, limit } = pageNumbers(args.offset, args.limit ?? 160);
	const source = await sourceFile(cwd, args.path, args.revision, signal);
	const { text: _, ...origin } = source;
	if (!source.language)
		return {
			...origin,
			supported: false,
			found: false,
			supportedLanguages: SUPPORTED_LANGUAGES,
			note: "该文件类型未支持符号解析，可直接使用 read。",
		};
	const analysis = await analyzeSource(source.text, source.language, signal);
	const matches = analysis.symbols.filter(
		(symbol) =>
			(symbol.name === args.symbol || symbol.qualifiedName === args.symbol) &&
			(args.line === undefined || symbol.startLine === args.line),
	);
	if (matches.length !== 1)
		return {
			...origin,
			supported: true,
			found: false,
			ambiguous: matches.length > 1,
			candidates: matches,
			note: matches.length
				? "同名符号存在多个定义，请指定 qualifiedName 或定义的 line。"
				: "未找到该符号，请先用 code_outline 查看可用定义。",
		};
	const symbol = matches[0];
	const lines = source.text.split("\n").slice(symbol.startLine - 1, symbol.endLine);
	return {
		...origin,
		supported: true,
		found: true,
		symbol,
		hasSyntaxErrors: analysis.hasSyntaxErrors,
		offset,
		nextOffset: offset + limit < lines.length ? offset + limit : null,
		code: lines
			.slice(offset, offset + limit)
			.map((line, index) => `${symbol.startLine + offset + index}: ${line}`)
			.join("\n"),
	};
}

export async function findReferences(
	cwd: string,
	args: {
		symbol: string;
		path?: string;
		glob?: string;
		includeIgnored?: boolean;
		includeNonCode?: boolean;
		offset?: number;
		limit?: number;
	},
	signal?: AbortSignal,
) {
	const { offset, limit } = pageNumbers(args.offset, args.limit ?? 40);
	const name = args.symbol.split(".").at(-1)!;
	if (!/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(name)) throw new Error("symbol 应为符号名称或 Class.method。");
	const scope = resolve(cwd, args.path || ".");
	const flags = [
		"--json",
		"--fixed-strings",
		"--sort=path",
		"--hidden",
		"--glob=!.git/**",
		"--glob=!node_modules/**",
		"--glob=!.audit-harness/**",
		"--glob=!target/**",
		"--glob=!dist/**",
		"--glob=!build/**",
	];
	if (args.includeIgnored) flags.push("--no-ignore");
	if (args.glob) flags.push("--glob", args.glob);
	flags.push("--", name, scope);
	const result = await readProcess("rg", flags, cwd, signal);
	const files = new Map<string, { text: string; candidates: Array<{ line: number; byte: number }> }>();
	for (const row of result.stdout.split("\n")) {
		let entry: {
			type: string;
			data: {
				path: { text?: string };
				lines: { text?: string };
				line_number: number;
				submatches: { start: number }[];
			};
		};
		try {
			entry = JSON.parse(row);
		} catch {
			continue;
		}
		if (entry.type !== "match" || !entry.data.path.text || !entry.data.lines.text) continue;
		const path = entry.data.path.text as string;
		let file = files.get(path);
		if (!file) {
			file = { text: readFileSync(path, "utf8"), candidates: [] };
			files.set(path, file);
		}
		for (const hit of entry.data.submatches) file.candidates.push({ line: entry.data.line_number, byte: hit.start });
	}
	const matches: Array<{
		path: string;
		line: number;
		column: number;
		kind: string;
		container?: string;
		text: string;
		lineTruncated: boolean;
	}> = [];
	const warnings: string[] = [];
	for (const [path, file] of files) {
		const language = extensions[extname(path).toLowerCase()];
		const analysis = language ? await analyzeSource(file.text, language, signal) : undefined;
		if (!language && !args.includeNonCode) {
			warnings.push(`未分析的文件类型：${relative(cwd, path)}`);
			continue;
		}
		if (analysis?.hasSyntaxErrors) warnings.push(`语法树含错误节点：${relative(cwd, path)}`);
		const lines = file.text.split("\n");
		for (const candidate of file.candidates) {
			const line = lines[candidate.line - 1] || "";
			const position = Buffer.from(line).subarray(0, candidate.byte).toString("utf8").length;
			if (
				/[\p{L}\p{N}_$]/u.test(line[position - 1] || "") ||
				/[\p{L}\p{N}_$]/u.test(line[position + name.length] || "")
			)
				continue;
			const occurrence = analysis?.occurrences.find(
				(hit) => hit.name === name && hit.line === candidate.line && hit.column === position + 1,
			);
			if (!occurrence && !args.includeNonCode) continue;
			matches.push({
				path,
				line: candidate.line,
				column: position + 1,
				kind: occurrence?.kind || "text-match",
				container: occurrence?.container,
				text: line.slice(0, 600),
				lineTruncated: line.length > 600,
			});
		}
	}
	return {
		mode: "same-name candidates; not type-bound semantic references or a call graph",
		symbol: args.symbol,
		searchedName: name,
		scope,
		complete: result.complete,
		total: result.complete ? matches.length : undefined,
		offset,
		nextOffset: offset + limit < matches.length ? offset + limit : null,
		matches: matches.slice(offset, offset + limit),
		warnings: [...warnings, ...(result.stderr ? [result.stderr] : [])],
		note: "默认尊重 gitignore，跳过产物目录和非代码命中；includeIgnored/includeNonCode 可扩大范围。动态调用、别名或反射可能未命中。",
	};
}
