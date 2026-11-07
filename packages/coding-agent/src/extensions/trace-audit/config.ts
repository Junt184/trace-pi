import { getAuditDataDir } from "../../config.ts";

export const DATA = getAuditDataDir();
export const GITHUB_PROXY = process.env.GITHUB_PROXY || "http://127.0.0.1:7890";
