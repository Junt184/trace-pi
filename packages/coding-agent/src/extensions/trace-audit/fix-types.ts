/** Wire fields used from canonical GitHub and OSV JSON responses. */
export interface SourceApiData {
	html_url: string;
	url: string;
	id: string;
	number: number;
	ghsa_id: string;
	cve_id: string;
	summary: string;
	description: string;
	details: string;
	published_at: string;
	updated_at: string;
	created_at: string;
	closed_at: string;
	withdrawn_at: string;
	withdrawn: string;
	source_code_location: string;
	vulnerabilities: unknown;
	references?: (string | { url: string })[];
	aliases?: string[];
	affected?: { package: unknown; ranges: unknown; versions?: string[] }[];
	commit?: { message: string };
	title: string;
	body: string;
	sha: string;
	merge_commit_sha: string;
	parents?: { sha: string }[];
	state: string;
	state_reason: string;
	merged: boolean;
	merged_at: string;
	base?: { sha: string };
	head?: { sha: string };
	files?: SourceApiFile[] | Record<string, SourceApiFile>;
	user?: { login: string };
	owner?: { login: string };
	labels?: { name: string }[];
	public: boolean;
	comments: number;
	pull_request?: unknown;
	next_page_token?: string;
	incomplete_results?: boolean;
	items?: SourceApiData[];
	vulns?: SourceApiData[];
}

export interface SourceApiFile {
	filename: string;
	status: string;
	additions: number;
	deletions: number;
	content?: string;
	truncated?: boolean;
	raw_url?: string;
	language: string;
	size: number;
}

export interface SourceCapture<T> {
	url: string;
	fetchedAt: string;
	status: number;
	more: boolean;
	nextUrl?: string;
	data: T;
}

export interface FixSource {
	kind: string;
	url: string;
	apiUrl: string;
	fetchedAt: string;
	artifact: string;
	sha?: string;
	patchArtifact?: string;
	patchPreview?: string;
	patchTotalLines?: number;
	patchCaptureComplete?: boolean;
	patchNote?: string;
	patchError?: string;
	localHistory?: unknown;
	withdrawnAt?: string;
	merged?: boolean;
	references?: string[];
	body?: string;
	files?: { filename: string; content?: string; [key: string]: unknown }[];
	comments?: { body: string; [key: string]: unknown }[];
	commentsPage?: number;
	nextCommentsPage?: number | null;
	commentsNote?: string;
	commentsError?: string;
	note?: string;
	[key: string]: unknown;
}
