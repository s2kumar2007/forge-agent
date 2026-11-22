# Forge Agent — Write-up

## 1. Team

- **Team name**: Git Push
- **Institution**: VIT Vellore
- **Members**:
  - B. Sunil Kumar (Team leader, GitHub: [s2kumar2007](https://github.com/s2kumar2007)): Team leader.
  - Eric Bejoy (GitHub: [ericjbejoy-ux](https://github.com/ericjbejoy-ux)): Testing, documentation and demo video.
  - Ashmit Sharma (GitHub: [ASH10022008](https://github.com/ASH10022008)): Resilience and model fallback code.
  - Shaurya Singla (GitHub: [shauryasingla505](https://github.com/shauryasingla505)): Context and TrueForge session visibility code.

## 2. Starting point

Written from scratch for Round 1 of the Techfest 2026-27 TrueFoundry Forge-a-thon. There is no upstream fork. Released under the MIT license. Core dependencies: `@truefoundry/trueforge-sdk` (0.182.0), `@modelcontextprotocol/sdk` (1.32.2), `@vscode/ripgrep` (1.18.0), `diff` (9.0.0), `three` (0.187.0), and `zod` (4.6.7).

## 3. Architecture on TrueForge

Forge Agent coordinates between VS Code and TrueForge using an asynchronous client-server architecture:
- **Sessions, turns, and approvals**: The extension manages agent sessions via `@truefoundry/trueforge-sdk` over local HTTP/SSE (`http://localhost:8790`). Sessions are created with `sessions.create` and processed via `createTurnStream`. As streamed events arrive, `turnRunner` processes text deltas and tracks active tool calls in an id-keyed event index. When a tool call requires user confirmation, the turn pauses; upon user approval, a resume turn is dispatched containing `user.tool_approval` payloads using the pending event's `threadId` and `sourceEventId`.
- **Editor MCP tools**: The extension runs an authenticated loopback MCP endpoint (`http://127.0.0.1:<port>/mcp`) registered dynamically via `PUT /api/v1/settings/mcp-servers` with a random bearer token. Ten editor tools are exposed across core and advanced suites:
  - `read_file`: Bounded workspace file inspection with mandatory line ranges for files exceeding 80 lines (max 80 lines per slice, or `outline=true` for definitions) to prevent token exhaustion. Secret-like files are refused.
  - `list_dir`: Directory listing with realpath containment and secret-file omission.
  - `search_workspace`: Text and symbol search powered by ripgrep with ranking heuristics and secret-path omission.
  - `propose_write`: Virtual diff creation supporting whole files, exact-anchor search/replace, or line ranges `{ startLine, endLine, newText }`, guarded by SHA-256 base hashes against stale external edits.
  - `run_command`: Workspace-root shell command execution with cancellation and process-tree termination.
  - `propose_changes`: Atomic multi-file proposals across multiple workspace files with unified hunk review.
  - `search_symbols`: Workspace symbol search leveraging native language servers and indexers with definition snippets.
  - `find_references`: Workspace symbol reference search for downstream impact analysis.
  - `get_diagnostics`: Real-time compiler and linter diagnostics for workspace files.
  - `run_tests`: Framework-aware test runner (`pytest`, `vitest`, `jest`, `npm`) with confirmation gating.
- **Approval gates**: Read directly from the agent manifests: `forge-agent` and `forge-agent-fallback` require user approval for `propose_write`, `propose_changes`, `run_command`, and `run_tests`; `forge-inline` requires user approval for `propose_write`.
- **Mutation lock**: A shared `withMutationLock` queue serializes mutating operations (`propose_write`, `propose_changes`, `run_command`, `run_tests`), preventing file write races while allowing concurrent read-only queries.
- **Undo and cancellation**: `forge.undoLast` maintains an in-memory stack of up to 50 operations in `workspaceState`, checks current text before reverting, restores original CRLF/LF line endings, and deletes newly created files on undo. Pressing Stop calls `sessions.cancel`, clears review state, aborts pending approvals, and terminates running command process trees.
- **Secret file protection**: Across context assembly, directory listings, searches, and file reads/writes, sensitive paths (`.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `credentials*`, `*.p12`, `.git`) are strictly filtered and refused, while allowing legitimate configuration files such as `config.py`.
- **Harness features**: Agent manifests declare `preload: true` to avoid runtime discovery round-trips; context compaction triggers (40000 tokens for primary, 30000 for fallback, 5500 for inline); large tool response handling enabled (`large_tool_response: { enabled: true }`); dynamic subagents enabled where configured (`forge-agent` and `forge-agent-fallback`); and iteration limits (60 for `forge-agent` and `forge-agent-fallback`, 12 for `forge-inline`).

## 4. How context is selected

Agent mode automatically gathers workspace context using a multi-stage retrieval pipeline:
- **Retrieval pipeline**:
  1. *Explicit mentions*: `@file:path` and `@symbol:name` mentions in the user prompt are parsed first and given top priority (capped at 40 lines for files, 25 signatures for symbols).
  2. *Ranked candidate shortlist*: Keywords extracted from the prompt are queried across the workspace using ripgrep. Matches are ranked by keyword frequency, inverse document frequency weight (`keywordWeight(df, N) = clamp(ln((N+1)/(df+1)) / ln(N+1) * 2, 0.15, 1.5)`), symbol definitions, and downstream module importers. Snippets from the same file are merged into non-overlapping windows before token budgeting, with dense windows capped at 40 lines.
  3. *Repo map*: A compact directory tree overview budgeted to at most 20% of the total context budget.
  4. *Cross-request cache*: `WorkspaceCache` validates file lists and file contents against disk `mtimeMs` and `size`, with automatic invalidation on file-change events and applied diffs.
  5. *Secret-file exclusion*: Sensitive paths are excluded from file lists, searches, and candidate windows.
- **Budgets and packing**: Context is budgeted against a default limit of `2000` tokens (`forge.contextBudget`), estimated at ~4 characters per token (`CHARS_PER_TOKEN = 4`). Fallback sessions use `1500` tokens (`forge.fallbackContextBudget`). For complex multi-file or test requests, `computeAdaptiveBudget` dynamically adds up to 1000 tokens of headroom (capped at 4000). Read-only tool exploration is bounded by `forge.explorationBudget` (default 12 calls). Items are packed greedily by priority; items exceeding remaining headroom are line-truncated or safely dropped.
- **Context used block**: The panel renders an interactive **Context used** block displaying budget utilization (`Context: <N> items, <used> of <budget> estimated tokens`), individual item paths, estimated token counts, and selection rationales.

## 5. Model setup

- **Configured models**:
  - Primary agent (`forge-agent`): NVIDIA NIM `forge-nvidia/nemotron-3-5-lightning-30b-a3b` (`nvidia/nemotron-3.5-lightning-30b-a3b`), cloud API, temperature 0.2, parallel tool calls true, max tokens 8000, compaction trigger 40000.
  - Inline agent (`forge-inline`): NVIDIA NIM `forge-nvidia/nemotron-3-5-lightning-30b-a3b`, cloud API, temperature 0.2, compaction trigger 5500.
  - Fallback agent (`forge-agent-fallback`): Google Gemini `google-gemini/gemini-3-8-flash`, cloud API, temperature 0.2, parallel tool calls true, max tokens 8000, compaction trigger 30000.
- **Where they run and cost**: Primary and inline models execute on NVIDIA NIM cloud APIs (`https://integrate.api.nvidia.com/v1`). The fallback model executes on Google Gemini cloud APIs. TrueForge (`http://localhost:8790`) runs locally. Both run on free tiers (approximately INR 0 within free allowances).
- **Model switching**: Providers and models can be configured via `node scripts/configure-provider.cjs` or in TrueForge settings. When synchronizing agent manifests, deprecated Gemini model identifiers (`gemini-2.5-flash`) are migrated to `google-gemini/gemini-3-8-flash`, while custom opt-in fallback models are preserved.
- **Fallback behavior**:
  - *Permanent errors*: Status 400, 401, 403, 404, 413, 422, unprocessable entity, or unconfigured model errors are classified as permanent (`isPermanentError() = true`). They are never retried and switch immediately to the fallback target.
  - *Transient errors*: Status 429, 500, 502, 503, and network disconnects retry with exponential backoff up to a 12s cap, limited to 2 retries per target.
  - *Circuit breaker*: When an agent encounters a connection failure, timeout, 401/403, 413, or 5xx, it is marked unhealthy for 5 minutes in memory, routing subsequent requests directly to fallback without attempting the primary.
  - *Watchdog and budgets*: Monitored by `forge.firstTokenTimeoutMs` (45s), `forge.stallTimeoutMs` (75s), and `forge.failoverBudgetMs` (120s). Failover budget deduction starts when failover begins and excludes user approval wait time.
  - *Handoff brief and replay guard*: On fallback, a continuation brief containing read files, searches, and unapplied diffs (bounded by `forge.fallbackContextBudget`, 1500 tokens) is passed to the fallback session. To prevent duplicate mutations, retry and fallback are disabled once an approval has been granted. Reaching the 60-step iteration limit stops without triggering fallback.
- **Evidence**: All claims are verifiable via 347 automated tests passing across 40 test files (`npm test`), independent verification script `python scripts/verify-flask-demo.py` (verifying Task A inline edits and Task B CLI command on Flask 3.1.3), deterministic fault injection (`forge.faultInjection`: `"none"`, `"auth"`, `"network"`, `"server"`, `"timeout"`), and dated live run logs in `docs/` (`docs/live-A-exact-edits.json`, `docs/live-B-verified.json`, `docs/live-C-official-recheck.json`).

## 6. Scorecard

| Criterion | Video time | One-line claim |
|---|---|---|
| A1 Inline edit | [00:15] | Scoped inline edit on get_debug_flag with diff review, verified by test script. |
| A2 Agent mode | [01:20] | Multi-file discovery and atomic propose_changes for flask config without file hints. |
| A3 Streaming and cancellation | [02:30] | Streamed deltas, responsive panel timeline, and clean stop cancellation. |
| B1 Context assembly | [00:45] | Ranked keyword and importer retrieval packed within deterministic token budgets. |
| B2 Diff safety | [01:50] | Single-use approval tokens, base-hash stale guards, and multi-step undo. |
| B3 Resilience | [03:00] | Fast failover on permanent errors, 5-minute circuit breaker, and handoff brief. |
| B4 TrueForge integration depth | [02:10] | TrueForge sessions and turns, loopback MCP tools, and visible lifecycle events. |
| C1 Video | [03:30] | Four-minute demo demonstrating Tasks A, B, and C with session visibility. |
| C2 Write-up | [03:50] | Structured technical write-up covering architecture, context, and models. |

## 7. Tools used

TrueForge 0.182.0, `@truefoundry/trueforge-sdk` 0.182.0, VS Code Extension API 1.90.0, `@modelcontextprotocol/sdk` 1.32.2, `@vscode/ripgrep` 1.18.0, `diff` 9.0.0, `three` 0.187.0, `zod` 4.6.7, TypeScript 7.0.2, esbuild 0.28.2, Vitest 5.0.5 (347 tests passing across 40 test files), Node.js 22.14+, Git, ReportLab. AI tools: GitHub Copilot, ChatGPT and Claude (Anthropic).

## 8. Known limitations and what we would do with another month

- **Known limitations**: `run_command` executes with host user permissions and is not an OS sandbox; approved command side-effects cannot be rolled back automatically. The custom undo stack persists up to 50 operations in memory across reloads, but will refuse to overwrite files if subsequent external edits occurred. Primary (NVIDIA NIM) and fallback (Google Gemini) operate on independent providers, but both are subject to free-tier rate limits and quotas. Task B multi-file exploration can take minutes and approach the 60-step iteration limit on large repositories. Tool execution depends on model capability to emit valid JSON tool calls. The extension processes one request at a time per workspace, applies line-based diffs, and relies on a character-based token estimate (~4 chars/token).
- **With another month**: Containerized command execution inside ephemeral Docker or WebAssembly sandboxes; persistent disk-backed undo journals surviving editor restarts; semantic AST and vector embedding retrieval alongside ripgrep; interactive in-diff adjustments during hunk review; and dynamic multi-provider latency-routed fallback pools.
