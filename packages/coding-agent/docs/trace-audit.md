# Trace audit tools

`trace-pi` includes the 19 audit tools from the original Trace SDK application as the `builtin:trace-audit` extension. The extension loads by default in interactive, print, JSON, and RPC modes. It uses the active Pi working directory and session ID; a separate Trace web service is not required.

## Tools

| Tool | Purpose |
| --- | --- |
| `project_overview` | Read project structure, Git version, and working-tree status |
| `code_outline` | Read Tree-sitter symbols and exact source ranges, including Git revisions |
| `read_symbol` | Read a function, class, or method with source hashes and overload disambiguation |
| `find_references` | Find same-name source candidates while filtering comments and strings |
| `semantic_references` | Resolve definitions and references through a real language server |
| `build_call_graph` | Build a static call graph and save all nodes, edges, and unresolved calls as JSON |
| `query_call_graph` | Query upstream/downstream/transitive calls and check source freshness |
| `semantic_search` | Incrementally index and search code/docs using local neural embeddings |
| `git_refs` | List local branches, remote-tracking branches, and tags |
| `git_history` | Search local commit messages, changed text, and paths |
| `git_patch` | Read and persist commit patches or revision diffs |
| `search_fix_sources` | Search GitHub advisories, commits, issues/PRs, and OSV |
| `read_fix_source` | Read canonical source records and persist raw evidence and available patches |
| `verify_fix_source` | Check source identity, repository, commit, and explicit claim links separately |
| `check_fix_applicability` | Check patch applicability without applying it and run supplied predicates |
| `compare_patch` | Run identical probes on isolated tracked Git snapshots before and after a patch |
| `run_command` | Execute literal argv with persistent logs, timeout, and cancellation |
| `record_finding` | Save or update findings and their evidence |
| `audit_notes` | Read or replace durable progress notes |

The native Pi tools remain available. Use `--tools` or `--exclude-tools` to select tools. Disabling extension discovery with `--no-extensions` also disables the audit extension; explicitly load it with `-e builtin:trace-audit` when needed.

## Sessions and evidence

Configuration stays under `~/.pi/agent`. The CLI name produces the environment overrides `TRACE_PI_CODING_AGENT_DIR` and `TRACE_PI_CODING_AGENT_SESSION_DIR`.

Audit data defaults to `<agentDir>/audit`. `AUDIT_DATA_DIR` overrides this root:

```text
audit/
  indexes/                       Incremental embedding indexes
  models/                        Downloaded embedding weights
  servers/                       Managed JDT LS installation
  sessions/<native-pi-session-id>/
    notes.md
    findings.json
    artifacts/                   Command logs, graphs, patches, source captures, manifests
    experiments/                 Before/after tracked Git snapshots
```

Resume the same Pi session with `trace-pi --continue`, `--resume`, or `--session`. Its ID selects the same evidence directory. A new session has a separate notebook and findings. Saved notes and findings are supplied to the next Agent run. `--no-session` still permits tools to persist evidence under that ephemeral session's ID.

Call graphs serve the Agent through `build_call_graph` and `query_call_graph`. The build result includes `artifact` and `fullOutputPath`; the old Trace web viewer is not included. Static graphs retain unresolved calls and are not complete runtime traces. Queries detect added, modified, or deleted source files in the indexed scope.

## Runtime dependencies

Install with `npm ci --ignore-scripts`. Runtime dependency versions are pinned in the package manifest and lockfiles. ONNX CPU binaries and Tree-sitter WASM ship in their packages; no dependency install scripts are required for the Node CLI's CPU embedding path.

`rg` is required for source enumeration and candidate references; Git tools need `git`; online fix sources use `curl`; patch experiments use `git` and `tar` plus the runtime required by the supplied probe.

| Language | Syntax symbols | Semantic server |
| --- | --- | --- |
| JavaScript / TypeScript / TSX | Bundled WASM | Bundled typescript-language-server and a separately pinned TypeScript LSP runtime |
| Python | Bundled WASM | Bundled Pyright |
| PHP / PHTML | Bundled WASM | Bundled Intelephense |
| Go | Bundled WASM | Install `gopls` or set `GOPLS_PATH` |
| Java | Bundled WASM | JDK 21+ and JDT LS; use the setup command or set `JDTLS_HOME` |

From the repository root, install the pinned, SHA-256-verified JDT LS distribution:

```bash
npm --prefix packages/coding-agent run setup:java
```

An existing local archive can be supplied after `--`. `JAVA_HOME` selects the JDK. `AUDIT_LSP_SERVERS` accepts a JSON mapping of language names to executable/argv arrays; Java commands may use `{workspace}` for their temporary workspace.

`semantic_search` uses the pinned `Xenova/multilingual-e5-small` revision, q8 CPU inference, 384-dimensional normalized embeddings, and cosine similarity. First use downloads weights. `AUDIT_EMBED_MODEL`, `AUDIT_EMBED_REVISION`, and `AUDIT_EMBED_PROXY` override its model and download configuration. Index refreshes reuse unchanged chunks and remove deleted files.

GitHub requests preserve Trace's proxy default, `http://127.0.0.1:7890`; set `GITHUB_PROXY` to the proxy available on your machine. `OSV_PROXY` and `AUDIT_EMBED_PROXY` default to that proxy and may be set to an empty string for direct access. `GITHUB_TOKEN` is optional.

Source records, advisory version claims, and passing probes remain evidence for the Agent to evaluate; tools do not automatically declare a checkout vulnerable or fixed.

## Verification in this checkout

Verified on 2026-11-07 with Node.js 24.18.0: root `npm run check`, the complete offline build, 154 targeted local regression tests, a fresh install of packed workspace packages outside the repository, source/npm CLI startup, RPC startup, and installed Tree-sitter assets. Real embedding inference produced 384-dimensional vectors and correctly reused and removed indexed chunks. No real model-provider requests were made; 18 provider API tests were skipped.

Real language-server checks passed for TypeScript, PHP, Python, Go, and Java. The Java check used JDK 25.0.1 and the pinned JDT LS 1.63.0 installation. That local installation exited with code 13 under JDK 21.0.8; use a compatible JDK through `JAVA_HOME` when reusing it. Native Bun binaries and Nix builds were not executed on this machine.
