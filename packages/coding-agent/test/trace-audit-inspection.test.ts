import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "vitest";
import { analyzeSource, codeOutline, findReferences, readSymbol } from "../src/extensions/trace-audit/code.ts";
import { gitHistory, gitPatch, listGitRefs } from "../src/extensions/trace-audit/git.ts";

function fixture() {
	const dir = mkdtempSync(resolve(tmpdir(), "audit-inspection-"));
	return {
		dir,
		write: (name: string, text: string) => writeFileSync(resolve(dir, name), text),
		clean: () => rmSync(dir, { recursive: true, force: true }),
	};
}

test("syntax trees read multiline methods without swallowing adjacent definitions or string braces", async () => {
	const x = fixture();
	try {
		x.write(
			"store.ts",
			`class First {\n  async save(\n    value: string,\n  ) {\n    const label = "} fake() {";\n    return value;\n  }\n}\nclass Second { save() { return 2; } }\nconst callback = (value: string) => value;\n`,
		);
		const outline = await codeOutline(x.dir, { path: "store.ts", limit: 2 });
		assert.equal(outline.engine, "tree-sitter");
		assert.equal(outline.total, 5);
		assert.equal(outline.nextOffset, 2);
		const ambiguous = await readSymbol(x.dir, {
			path: "store.ts",
			symbol: "save",
		});
		assert.equal(ambiguous.ambiguous, true);
		assert.equal(ambiguous.candidates?.length, 2);
		const method = await readSymbol(x.dir, {
			path: "store.ts",
			symbol: "First.save",
			limit: 3,
		});
		assert.equal(method.found, true);
		assert.equal(method.symbol?.startLine, 2);
		assert.equal(method.symbol?.endLine, 7);
		assert.equal(method.nextOffset, 3);
		assert.match(method.code!, /2:.*async save/);
		assert.doesNotMatch(method.code!, /class Second/);
		const secondPage = await readSymbol(x.dir, {
			path: "store.ts",
			symbol: "save",
			line: 2,
			offset: 3,
			limit: 10,
		});
		assert.match(secondPage.code!, /5:.*fake/);
		assert.equal(secondPage.nextOffset, null);
		const before = method.sha256;
		x.write("store.ts", "function changed() {}\n");
		const changed = await codeOutline(x.dir, { path: "store.ts" });
		assert.notEqual(changed.sha256, before);
	} finally {
		x.clean();
	}
});

test("Python decorators, Java overloads, Go receiver methods and TSX retain real source ranges", async () => {
	const x = fixture();
	try {
		x.write(
			"model.py",
			'class 模型:\n    @property\n    def value(self):\n        """def pretend(): not code"""\n        return "中文"\n',
		);
		const python = await readSymbol(x.dir, {
			path: "model.py",
			symbol: "模型.value",
		});
		assert.equal(python.symbol?.startLine, 2);
		assert.match(python.code!, /@property/);
		assert.match(python.code!, /中文/);
		x.write(
			"Upload.java",
			'class Upload {\n public void save(String value) { String text = "}"; }\n public void save(int value) {}\n}\n',
		);
		const java = await readSymbol(x.dir, {
			path: "Upload.java",
			symbol: "Upload.save",
		});
		assert.equal(java.ambiguous, true);
		const overload = await readSymbol(x.dir, {
			path: "Upload.java",
			symbol: "Upload.save",
			line: 3,
		});
		assert.match(overload.code!, /int value/);
		x.write(
			"monitor.go",
			"package monitor\ntype Server struct {}\nfunc (s *Server) Events(id string) string { return id }\n",
		);
		const go = await readSymbol(x.dir, {
			path: "monitor.go",
			symbol: "Server.Events",
		});
		assert.equal(go.found, true);
		assert.equal(go.symbol?.startLine, 3);
		const tsx = await analyzeSource("export function App() { return <div>hello</div>; }", "tsx");
		assert.equal(tsx.hasSyntaxErrors, false);
		assert.equal(tsx.symbols[0].name, "App");
	} finally {
		x.clean();
	}
});

test("candidate references exclude comments/strings and substrings, preserve Unicode columns and paginate", async () => {
	const x = fixture();
	try {
		x.write(
			"calls.ts",
			`class Worker { save() {} }\nconst worker = new Worker();\nconst 中文 = "你好"; worker.save();\n// worker.save();\nconst message = "save";\nfunction saveOther() {}\nworker.save();\n`,
		);
		const first = await findReferences(x.dir, {
			symbol: "Worker.save",
			limit: 2,
		});
		assert.equal(first.total, 3);
		assert.equal(first.nextOffset, 2);
		assert.equal(first.matches[0].kind, "declaration");
		assert.equal(first.matches[1].kind, "call-name");
		assert.equal(first.matches[1].line, 3);
		assert.equal(first.matches[1].column, 'const 中文 = "你好"; worker.'.length + 1);
		const second = await findReferences(x.dir, { symbol: "save", offset: 2 });
		assert.equal(second.matches.length, 1);
		assert.equal(second.matches[0].line, 7);
		const all = await findReferences(x.dir, {
			symbol: "save",
			includeNonCode: true,
		});
		assert.equal(all.total, 5);
		const missing = await findReferences(x.dir, { symbol: "notFound" });
		assert.equal(missing.total, 0);
		assert.equal(missing.complete, true);
	} finally {
		x.clean();
	}
});

test("Git history, refs, patches and historic symbols use real commits without changing the worktree", async () => {
	const x = fixture();
	const git = (...args: string[]) =>
		execFileSync(
			"git",
			[
				"-c",
				"user.name=Harness Test",
				"-c",
				"user.email=harness-test@localhost",
				"-c",
				"commit.gpgsign=false",
				"-c",
				"core.hooksPath=/dev/null",
				"-C",
				x.dir,
				...args,
			],
			{ encoding: "utf8" },
		).trim();
	try {
		git("init", "--quiet");
		x.write("上传 handler.py", "def save(name):\n    return name\n");
		git("add", "--", "上传 handler.py");
		git("commit", "--quiet", "-m", "Initial fixture source");
		git("tag", "before-fix");
		x.write("上传 handler.py", 'def save(name):\n    return name.replace("../", "")\n');
		git("add", "--", "上传 handler.py");
		git("commit", "--quiet", "-m", "Fix fixture traversal check");
		git("tag", "--annotate", "after-fix", "-m", "Annotated fixture tag");
		const head = git("rev-parse", "HEAD");
		x.write("上传 handler.py", "def save(name):\n    return 'uncommitted'\n");
		const statusBefore = git("status", "--porcelain");
		const refs = await listGitRefs(x.dir, { query: "fix" });
		assert.equal(refs.total, 2);
		assert.equal(refs.refs.find((ref) => ref.name === "after-fix")?.targetObjectId, head);
		const history = await gitHistory(x.dir, { query: "fixture", limit: 1 });
		assert.equal(history.commits.length, 1);
		assert.equal(history.nextOffset, 1);
		const searched = await gitHistory(x.dir, {
			changedText: 'replace("../"',
			path: "上传 handler.py",
		});
		assert.equal(searched.commits.length, 1);
		const patch = await gitPatch(x.dir, {
			base: "before-fix",
			revision: "after-fix",
			path: "上传 handler.py",
			limit: 4,
		});
		assert.equal(patch.revision, head);
		assert.match(patch.fullPatch, /replace/);
		assert.doesNotMatch(patch.fullPatch, /uncommitted/);
		assert.ok(patch.hunks.length > 0);
		assert.equal(patch.nextOffset, 4);
		const old = await readSymbol(x.dir, {
			path: "上传 handler.py",
			symbol: "save",
			revision: "before-fix",
		});
		assert.match(old.code!, /return name$/);
		assert.doesNotMatch(old.code!, /replace/);
		const absoluteOld = await readSymbol(x.dir, {
			path: resolve(x.dir, "上传 handler.py"),
			symbol: "save",
			revision: "before-fix",
		});
		assert.equal(absoluteOld.sha256, old.sha256);
		const current = await readSymbol(x.dir, {
			path: "上传 handler.py",
			symbol: "save",
		});
		assert.match(current.code!, /uncommitted/);
		assert.equal(git("status", "--porcelain"), statusBefore);
		await assert.rejects(gitPatch(x.dir, { revision: "does-not-exist" }));
	} finally {
		x.clean();
	}
});

test("unsupported files and malformed source are explicitly labelled", async () => {
	const x = fixture();
	try {
		x.write("notes.txt", "save()\n");
		const unsupported = await codeOutline(x.dir, { path: "notes.txt" });
		assert.equal(unsupported.supported, false);
		const malformed = await analyzeSource("class Broken { save( {", "typescript");
		assert.equal(malformed.hasSyntaxErrors, true);
		await assert.rejects(codeOutline(x.dir, { path: "notes.txt", limit: 0 }), /limit/);
	} finally {
		x.clean();
	}
});
