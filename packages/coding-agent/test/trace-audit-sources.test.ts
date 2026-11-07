import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseFixUrl, readFixSource, searchFixSources } from "../src/extensions/trace-audit/fix-sources.ts";
import { checkFixApplicability, verifyFixSource } from "../src/extensions/trace-audit/fix-verification.ts";
import { AuditStore } from "../src/extensions/trace-audit/store.ts";

describe("Trace canonical fix evidence", () => {
	let root: string;
	let cwd: string;
	let store: AuditStore;
	const sha = "a".repeat(40);
	const commitUrl = `https://github.com/trace-fixture/project/commit/${sha}`;
	const advisoryUrl = "https://github.com/advisories/GHSA-abcd-abcd-abcd";
	const patch = "diff --git a/value.txt b/value.txt\n--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-before\n+after\n";
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "trace-sources-"));
		cwd = join(root, "project");
		mkdirSync(cwd);
		store = new AuditStore(join(root, "audit"));
		writeFileSync(join(cwd, "value.txt"), "before\n");
		writeFileSync(join(cwd, "package.json"), '{"name":"fixture","version":"1.0.0"}');
		execFileSync("git", ["-C", cwd, "init", "-q"]);
		execFileSync("git", ["-C", cwd, "remote", "add", "origin", "https://github.com/trace-fixture/project.git"]);
		const fixture = {
			patch,
			advisory: {
				html_url: advisoryUrl,
				ghsa_id: "GHSA-abcd-abcd-abcd",
				cve_id: "CVE-2026-123456",
				summary: "Fixture advisory",
				references: [commitUrl],
			},
			commit: {
				html_url: commitUrl,
				sha,
				commit: { message: "Fixture fix" },
				files: [{ filename: "value.txt", status: "modified", additions: 1, deletions: 1 }],
			},
			osv: { id: "OSV-fixture", aliases: ["CVE-2026-123456"], references: [{ url: commitUrl }], affected: [] },
		};
		writeFileSync(join(root, "fixture.json"), JSON.stringify(fixture));
		// A real subprocess models curl's file/status contract. No external source is contacted.
		writeFileSync(
			join(root, "curl"),
			`#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const fixture = JSON.parse(fs.readFileSync(process.env.TRACE_SOURCE_FIXTURE, 'utf8'));
const url = new URL(args.at(-1));
const headers = fs.readFileSync(args[args.indexOf('--header') + 1].slice(1), 'utf8');
let data;
if (headers.includes('application/vnd.github.diff')) data = fixture.patch;
else if (url.pathname.includes('/commits/')) data = fixture.commit;
else if (url.pathname === '/search/commits') data = { items: [fixture.commit] };
else if (url.pathname === '/search/issues') data = { items: [{ html_url: 'https://github.com/trace-fixture/project/issues/2', title: 'Keyword candidate' }] };
else if (url.hostname === 'api.osv.dev') data = url.pathname.endsWith('/query') ? { vulns: [fixture.osv] } : fixture.osv;
else data = url.search ? [fixture.advisory] : fixture.advisory;
const failed = process.env.TRACE_SOURCE_FAIL === '1';
fs.writeFileSync(args[args.indexOf('--output') + 1], failed ? 'fixture unavailable' : typeof data === 'string' ? data : JSON.stringify(data));
fs.writeFileSync(args[args.indexOf('--dump-header') + 1], 'HTTP/1.1 ' + (failed ? '503' : '200') + '\\r\\n\\r\\n');
process.stdout.write(failed ? '503' : '200');
`,
		);
		chmodSync(join(root, "curl"), 0o755);
		vi.stubEnv("PATH", `${root}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`);
		vi.stubEnv("TRACE_SOURCE_FIXTURE", join(root, "fixture.json"));
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	it("keeps explicit advisory references distinct from keyword candidates and persists captures", async () => {
		const result = await searchFixSources(
			cwd,
			{
				query: "CVE-2026-123456",
				repository: "trace-fixture/project",
				package: "fixture",
				ecosystem: "npm",
				version: "1.0.0",
			},
			store,
			"session",
			"search",
		);
		expect(result.complete).toBe(true);
		expect(result.sources).toHaveLength(4);
		expect(result.relatedFixes).toEqual([
			{ url: commitUrl, kind: "commit", relation: "explicit advisory reference" },
		]);
		expect(readFileSync(join(store.dir("session"), "artifacts", result.artifact), "utf8")).toContain("queryBody");
		vi.stubEnv("TRACE_SOURCE_FAIL", "1");
		const failed = await searchFixSources(cwd, { query: "GHSA-abcd-abcd-abcd" }, store, "session", "failed");
		expect(failed.complete).toBe(false);
		expect(failed.errors[0].error).toContain("503");
	});

	it("reads patches and verifies repository, commit, and explicit claim links separately", async () => {
		const source = await readFixSource(cwd, { url: commitUrl }, store, "session", "read");
		expect(source.sha).toBe(sha);
		expect(readFileSync(join(store.dir("session"), "artifacts", source.patchArtifact!), "utf8")).toBe(patch);
		const verified = await verifyFixSource(
			cwd,
			{
				url: commitUrl,
				claimUrl: advisoryUrl,
				expectedRepository: "trace-fixture/project",
				expectedCommit: sha.slice(0, 7),
			},
			store,
			"session",
			"verify",
		);
		expect(verified.checks.repositoryMatches).toBe(true);
		expect(verified.checks.commitMatches).toBe(true);
		expect(verified.checks.localOriginMatches).toBe(true);
		expect(verified.checks.claimExplicitlyLinksSource).toBe(true);
		const osvClaim = await verifyFixSource(
			cwd,
			{ url: commitUrl, claimUrl: "https://osv.dev/vulnerability/OSV-fixture" },
			store,
			"session",
			"osv",
		);
		expect(osvClaim.checks.claimExplicitlyLinksSource).toBe(true);
	});

	it("checks a real patch without applying it and records an actual runtime condition", async () => {
		const result = await checkFixApplicability(
			cwd,
			{
				url: commitUrl,
				conditions: [
					{
						description: "runtime predicate",
						command: process.execPath,
						args: ["-e", "console.log('predicate true')"],
						expectedOutput: "predicate true",
					},
				],
			},
			store,
			"session",
			"applicability",
		);
		expect(result.patchState.state).toBe("patch-can-apply");
		expect(result.conditions[0].satisfied).toBe(true);
		expect(result.files[0].sha256).toHaveLength(64);
		expect(readFileSync(join(cwd, "value.txt"), "utf8")).toBe("before\n");
	});

	it("rejects invalid source destinations and pre-cancelled work", async () => {
		expect(() => parseFixUrl("https://github.com.evil.invalid/a/b/commit/abcdefa")).toThrow();
		expect(() => parseFixUrl("https://user:password@github.com/a/b/issues/1")).toThrow();
		await expect(
			readFixSource(cwd, { url: commitUrl }, store, "session", "cancelled", AbortSignal.abort()),
		).rejects.toThrow();
	});
});
