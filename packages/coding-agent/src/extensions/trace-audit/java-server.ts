import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getAuditAssetsDir } from "../../config.ts";
import { DATA } from "./config.ts";

const distribution = JSON.parse(readFileSync(resolve(getAuditAssetsDir(), "java-distribution.json"), "utf8")) as {
	version: string;
};

export function javaServer() {
	const home = process.env.JDTLS_HOME || resolve(DATA, `servers/jdtls-${distribution.version}`);
	if (!existsSync(home)) {
		if (process.env.JDTLS_HOME) throw Error(`JDTLS_HOME 不存在：${home}`);
		return {
			command: [
				"jdtls",
				"--jvm-arg=-Djava.import.generatesMetadataFilesAtProjectRoot=false",
				"-data",
				"{workspace}/data",
			],
		};
	}
	const launcher = readdirSync(resolve(home, "plugins")).find((name) =>
		/^org\.eclipse\.equinox\.launcher_[\d.].*\.jar$/.test(name),
	);
	const platform = process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : "linux";
	const configuration = resolve(home, `config_${platform}`);
	if (!launcher || !existsSync(configuration))
		throw Error("JDT LS 安装不完整，请检查 JDTLS_HOME 或运行 npm run setup:java");
	return {
		configuration,
		command: [
			process.env.JAVA_HOME ? resolve(process.env.JAVA_HOME, "bin/java") : "java",
			"-Declipse.application=org.eclipse.jdt.ls.core.id1",
			"-Djava.import.generatesMetadataFilesAtProjectRoot=false",
			"-Dosgi.bundles.defaultStartLevel=4",
			"-Declipse.product=org.eclipse.jdt.ls.core.product",
			"-Xmx1G",
			"--add-modules=ALL-SYSTEM",
			"--add-opens",
			"java.base/java.util=ALL-UNNAMED",
			"--add-opens",
			"java.base/java.lang=ALL-UNNAMED",
			"-jar",
			resolve(home, "plugins", launcher),
			"-configuration",
			"{workspace}/config",
			"-data",
			"{workspace}/data",
		],
	};
}
