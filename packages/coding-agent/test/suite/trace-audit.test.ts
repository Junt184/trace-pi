import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { builtInExtensions } from "../../src/extensions/index.ts";
import traceAuditExtension from "../../src/extensions/trace-audit/index.ts";
import { AuditStore } from "../../src/extensions/trace-audit/store.ts";
import { createHarness, getToolResult, type Harness } from "./harness.ts";

describe("Trace audit tools in native Pi sessions", () => {
	let root: string;
	const harnesses: Harness[] = [];
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "trace-session-"));
		vi.stubEnv("AUDIT_DATA_DIR", join(root, "audit"));
	});
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		rmSync(root, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	it("loads all 19 audit tools through normal built-in extension discovery", async () => {
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: join(root, "agent"),
			settingsManager: SettingsManager.inMemory(),
			extensionFactories: builtInExtensions,
			noSkills: true,
			noPromptTemplates: true,
			noContextFiles: true,
		});
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		const audit = loader.getExtensions().extensions.find((extension) => extension.path === "builtin:trace-audit");
		expect(audit?.tools.size).toBe(19);
		expect([...audit!.tools.keys()].sort()).toEqual([
			"audit_notes",
			"build_call_graph",
			"check_fix_applicability",
			"code_outline",
			"compare_patch",
			"find_references",
			"git_history",
			"git_patch",
			"git_refs",
			"project_overview",
			"query_call_graph",
			"read_fix_source",
			"read_symbol",
			"record_finding",
			"run_command",
			"search_fix_sources",
			"semantic_references",
			"semantic_search",
			"verify_fix_source",
		]);
	});

	it("resumes notes and findings from the same session while a new session remains isolated", async () => {
		const manager = SessionManager.create(root, join(root, "pi-sessions"));
		const harness = await createHarness({ extensionFactories: [traceAuditExtension], sessionManager: manager });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("audit_notes", { text: "已排除文本匹配，下一步检查语义绑定" }),
					fauxToolCall("record_finding", {
						title: "待核实调用链",
						severity: "medium",
						description: "需要继续验证",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("saved"),
		]);
		await harness.session.prompt("保存审计进度");
		expect(getToolResult(harness, "record_finding").isError).toBe(false);
		const file = manager.getSessionFile()!;
		expect(existsSync(file)).toBe(true);
		harness.cleanup();
		harnesses.splice(harnesses.indexOf(harness), 1);

		const resumed = await createHarness({
			extensionFactories: [traceAuditExtension],
			sessionManager: SessionManager.open(file),
		});
		harnesses.push(resumed);
		let restoredPrompt = "";
		resumed.setResponses([
			(context) => {
				restoredPrompt = getCurrentSystemPrompt(context.messages);
				return fauxAssistantMessage([fauxToolCall("audit_notes", {})], { stopReason: "toolUse" });
			},
			fauxAssistantMessage("restored"),
		]);
		await resumed.session.prompt("继续审计");
		expect(getToolResult(resumed, "audit_notes").content).toEqual([
			{ type: "text", text: "已排除文本匹配，下一步检查语义绑定" },
		]);
		expect(restoredPrompt).toContain("待核实调用链");
		expect(restoredPrompt).toContain("已排除文本匹配");

		const fresh = await createHarness({ extensionFactories: [traceAuditExtension] });
		harnesses.push(fresh);
		fresh.setResponses([
			fauxAssistantMessage([fauxToolCall("audit_notes", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("empty"),
		]);
		await fresh.session.prompt("新审计");
		expect(getToolResult(fresh, "audit_notes").content).toEqual([{ type: "text", text: "No notes yet." }]);
		const store = new AuditStore(join(root, "audit", "sessions"));
		expect(store.findings(manager.getSessionId())).toHaveLength(1);
		expect(store.findings(fresh.sessionManager.getSessionId())).toEqual([]);
	});

	it("executes literal argv and persists full command logs through the native tool loop", async () => {
		const harness = await createHarness({ extensionFactories: [traceAuditExtension] });
		harnesses.push(harness);
		const literal = "$(printf shell-expansion); 中文 'quoted'";
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("run_command", {
						command: process.execPath,
						args: ["-e", "console.log(process.argv[1]);process.exit(7)", literal],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("observed"),
		]);
		await harness.session.prompt("执行定向命令");
		const result = getToolResult(harness, "run_command").details as {
			exitCode: number;
			output: string;
			fullOutputPath: string;
		};
		expect(result.exitCode).toBe(7);
		expect(result.output.trim()).toBe(literal);
		expect(readFileSync(result.fullOutputPath, "utf8").trim()).toBe(literal);
		expect(result.fullOutputPath).toContain(harness.sessionManager.getSessionId());
	});

	it("aborts a real running command and retains its partial evidence", async () => {
		const harness = await createHarness({ extensionFactories: [traceAuditExtension] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("run_command", {
						command: process.execPath,
						args: ["-e", "console.log('started');setInterval(()=>{},1000)"],
					}),
				],
				{ stopReason: "toolUse" },
			),
		]);
		let aborted = false;
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "tool_execution_update" && !aborted) {
				aborted = true;
				void harness.session.abort();
			}
		});
		try {
			await harness.session.prompt("运行后停止");
		} finally {
			unsubscribe();
		}
		expect(aborted).toBe(true);
		const folder = join(root, "audit", "sessions", harness.sessionManager.getSessionId(), "artifacts");
		expect(readdirSync(folder)).toHaveLength(1);
		expect(readFileSync(join(folder, readdirSync(folder)[0]), "utf8")).toContain("started");
	});
});
