import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionContext } from "../../core/extensions/types.ts";

export interface Finding {
	id: string;
	title: string;
	severity: string;
	status: string;
	location?: string;
	description: string;
	evidence?: string;
	preconditions?: string;
	reproduction?: string;
	recommendation?: string;
	createdAt: string;
	updatedAt: string;
}

export interface AuditContext {
	cwd: string;
	store: AuditStore;
	runId: string;
}

export type ResolveAuditContext = (ctx: ExtensionContext) => AuditContext;

/** Stores durable audit evidence under the native Pi session ID. */
export class AuditStore {
	readonly root: string;

	constructor(root: string) {
		this.root = root;
	}

	dir(id: string): string {
		// The session ID crosses the session-file boundary before becoming a directory name.
		if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("无效的会话 ID");
		return resolve(this.root, id);
	}

	findings(id: string): Finding[] {
		const file = resolve(this.dir(id), "findings.json");
		return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
	}

	saveFinding(id: string, input: Omit<Finding, "id" | "createdAt" | "updatedAt"> & { id?: string }): Finding {
		const all = this.findings(id);
		const index = input.id ? all.findIndex((finding) => finding.id === input.id) : -1;
		const now = new Date().toISOString();
		const finding: Finding = {
			...input,
			id: input.id || `F-${String(all.length + 1).padStart(3, "0")}`,
			createdAt: index >= 0 ? all[index].createdAt : now,
			updatedAt: now,
		};
		if (index >= 0) all[index] = finding;
		else all.push(finding);
		this.writeText(id, "findings.json", JSON.stringify(all, null, 2));
		return finding;
	}

	notes(id: string): string {
		const file = resolve(this.dir(id), "notes.md");
		return existsSync(file) ? readFileSync(file, "utf8") : "";
	}

	saveNotes(id: string, text: string): void {
		this.writeText(id, "notes.md", text);
	}

	private writeText(id: string, name: string, text: string): void {
		mkdirSync(this.dir(id), { recursive: true, mode: 0o700 });
		const file = resolve(this.dir(id), name);
		writeFileSync(`${file}.tmp`, text, { mode: 0o600 });
		renameSync(`${file}.tmp`, file);
	}
}
