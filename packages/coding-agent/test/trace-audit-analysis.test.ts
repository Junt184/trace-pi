import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCallGraph, type CallGraph, queryCallGraph } from "../src/extensions/trace-audit/call-graph.ts";
import { comparePatch } from "../src/extensions/trace-audit/fix-verification.ts";
import { semanticReferences } from "../src/extensions/trace-audit/semantic.ts";
import { AuditStore } from "../src/extensions/trace-audit/store.ts";

describe("Trace audit analysis engines", () => {
	const temporary: string[] = [];
	afterEach(() => {
		for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
	});
	function fixture(files: Record<string, string>) {
		const root = mkdtempSync(join(tmpdir(), "trace-analysis-"));
		temporary.push(root);
		const dir = join(root, "project");
		mkdirSync(dir);
		for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
		return { dir, store: new AuditStore(join(root, "audit")), runId: "session-1" };
	}

	it("builds real cross-file call edges and queries cycles and changed sources without a web server", async () => {
		const x = fixture({
			"tsconfig.json": JSON.stringify({
				compilerOptions: { strict: true, module: "NodeNext", moduleResolution: "NodeNext" },
				include: ["*.ts"],
			}),
			"a.ts":
				"import { beta } from './b.js';\nexport function alpha(){ beta(); }\nexport class Other { beta() {} }\nexport function dynamic(f:()=>void){ f(); }\n",
			"b.ts": "import {alpha as entry} from './a.js';\nexport function beta(){ entry(); }\n",
		});
		const summary = await buildCallGraph(x.dir, {}, x.store, x.runId, "graph");
		expect(summary).not.toHaveProperty("viewerUrl");
		const graph = JSON.parse(readFileSync(summary.fullOutputPath, "utf8")) as CallGraph;
		const a = graph.nodes.find((node) => node.qualifiedName === "alpha")!;
		const b = graph.nodes.find((node) => node.qualifiedName === "beta")!;
		const other = graph.nodes.find((node) => node.qualifiedName === "Other.beta")!;
		expect(graph.edges.some((edge) => edge.from === a.id && edge.to === b.id)).toBe(true);
		expect(graph.edges.some((edge) => edge.from === b.id && edge.to === a.id)).toBe(true);
		expect(graph.edges.some((edge) => edge.to === other.id)).toBe(false);
		expect(graph.unresolved.some((call) => call.text === "f")).toBe(true);
		const query = await queryCallGraph(
			x.dir,
			{ artifact: summary.artifact, symbol: "alpha", direction: "outgoing", transitive: true },
			x.store,
			x.runId,
		);
		expect(query.totalEdges).toBe(2);
		expect(query.freshness).toBe("unchanged");
		expect(query.coverage.runtimeComplete).toBe(false);
		writeFileSync(join(x.dir, "a.ts"), "export function changed(){}\n");
		writeFileSync(join(x.dir, "new.ts"), "export function added(){}\n");
		const stale = await queryCallGraph(x.dir, { artifact: summary.artifact }, x.store, x.runId);
		expect(stale.freshness).toBe("stale");
		expect(stale.staleFiles.map((path) => basename(path))).toContain("a.ts");
		expect(stale.addedFiles.map((path) => basename(path))).toContain("new.ts");
	}, 60000);

	it("resolves PHP aliases through the installed language server", async () => {
		const x = fixture({
			"composer.json": "{}",
			"api.php":
				"<?php\nnamespace App;\nclass A { public function save() {} }\nclass B { public function save() {} }\n",
			"use.php":
				"<?php\nnamespace Client;\nuse App\\A as Store;\n$a = new Store(); $a->save();\n$b = new \\App\\B(); $b->save();\n",
		});
		const refs = await semanticReferences(x.dir, { path: "api.php", line: 3, column: 28, timeoutSeconds: 30 });
		expect(refs.references.some((ref) => basename(ref.path || "") === "use.php" && ref.line === 4)).toBe(true);
		expect(refs.references.some((ref) => basename(ref.path || "") === "use.php" && ref.line === 5)).toBe(false);
	}, 40000);

	it("runs the same probe on real Git snapshots and preserves a dirty source worktree", async () => {
		const x = fixture({ "value.txt": "before" });
		const git = (...args: string[]) =>
			execFileSync(
				"git",
				[
					"-C",
					x.dir,
					"-c",
					"user.name=Trace Test",
					"-c",
					"user.email=test@localhost",
					"-c",
					"commit.gpgsign=false",
					"-c",
					"core.hooksPath=/dev/null",
					...args,
				],
				{ encoding: "utf8" },
			).trim();
		git("init", "-q");
		git("add", "value.txt");
		git("commit", "-qm", "before");
		writeFileSync(join(x.dir, "value.txt"), "after");
		git("commit", "-qam", "fix");
		const revision = git("rev-parse", "HEAD");
		writeFileSync(join(x.dir, "value.txt"), "user-dirty");
		const status = git("status", "--porcelain");
		const args = {
			revision,
			command: process.execPath,
			args: ["probe.cjs"],
			files: [
				{
					path: "probe.cjs",
					content:
						"const fs=require('fs');const value=fs.readFileSync('value.txt','utf8');console.log(value);process.exit(value==='after'?0:1);",
				},
			],
			expectedBeforeExitCode: 1,
			expectedAfterExitCode: 0,
		};
		const report = await comparePatch(x.dir, args, x.store, x.runId, "comparison");
		expect(report.expectationsMet).toBe(true);
		expect(report.runs.before?.result?.exitCode).toBe(1);
		expect(report.runs.after?.result?.exitCode).toBe(0);
		expect(existsSync(join(x.store.dir(x.runId), "artifacts", report.artifact))).toBe(true);
		const patch = execFileSync("git", ["-C", x.dir, "diff", "HEAD^", "HEAD"], { encoding: "utf8" });
		writeFileSync(join(x.store.dir(x.runId), "artifacts", "fix.patch"), patch);
		const applied = await comparePatch(
			x.dir,
			{ ...args, revision: undefined, patchArtifact: "fix.patch", base: "HEAD^" },
			x.store,
			x.runId,
			"patch",
		);
		expect(applied.expectationsMet).toBe(true);
		const missing = await comparePatch(
			x.dir,
			{ ...args, command: "trace-nonexistent-program" },
			x.store,
			x.runId,
			"missing",
		);
		expect(missing.expectationsMet).toBe(false);
		expect(missing.runs.before?.status).toBe("spawn-error");
		expect(git("status", "--porcelain")).toBe(status);
		expect(git("rev-parse", "HEAD")).toBe(revision);
		expect(readFileSync(join(x.dir, "value.txt"), "utf8")).toBe("user-dirty");
	});
});
