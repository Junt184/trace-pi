// Isolated ONNX process: stopping the Agent terminates downloads/inference together.
import { pipeline, env } from "@huggingface/transformers";
import { ProxyAgent, fetch as proxyFetch } from "undici";
import { mkdirSync } from "node:fs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const job = JSON.parse(input);
mkdirSync(job.cache, { recursive: true });
env.cacheDir = job.cache;
env.allowLocalModels = true;
if (job.proxy) {
  const dispatcher = new ProxyAgent(job.proxy);
  env.fetch = async (url, options) => {
    const remote = await proxyFetch(url, { ...options, dispatcher });
    // Transformers.js uses native Response identity to decide filesystem caching.
    // Undici 8's dispatcher cannot be handed to Node 24's built-in fetch.
    return new Response(remote.body, {
      status: remote.status,
      statusText: remote.statusText,
      headers: [...remote.headers],
    });
  };
}
try {
  let lastPercent = new Map();
  const extractor = await pipeline("feature-extraction", job.model, {
    device: "cpu",
    dtype: "q8",
    revision: job.revision,
    progress_callback: (p) => {
      const bucket = Math.floor((p.progress || 0) / 10);
      if (p.status === "progress" && bucket > (lastPercent.get(p.file) ?? -1)) {
        lastPercent.set(p.file, bucket);
        process.stdout.write(
          JSON.stringify({
            progress: {
              file: p.file,
              status: "download",
              percent: bucket * 10,
              loaded: p.loaded,
              total: p.total,
            },
          }) + "\n",
        );
      }
      if (["initiate", "done", "ready"].includes(p.status))
        process.stdout.write(JSON.stringify({ progress: p }) + "\n");
    },
  });
  for (let i = 0; i < job.texts.length; i += 4) {
    const result = await extractor(job.texts.slice(i, i + 4), {
      pooling: "mean",
      normalize: true,
      truncation: true,
      max_length: 512,
    });
    process.stdout.write(
      JSON.stringify({ offset: i, vectors: result.tolist() }) + "\n",
    );
  }
  await extractor.dispose();
} catch (error) {
  process.stderr.write(String(error.stack || error));
  process.exitCode = 1;
}
