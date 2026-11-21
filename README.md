# Forge Agent

Forge Agent is a VS Code extension that turns **TrueForge agent sessions** into an interactive, reviewed coding workflow. The agent loop runs on a local TrueForge server, which orchestrates the model, subagents, and context compaction, while the editor exposes local workspace capabilities as Model Context Protocol (MCP) tools. The extension provides automated context assembly, per-hunk interactive diff review, explicit command approvals, multi-step undo, and resilient model fallback.

- **Demo video**: [TODO: video link]
- **Write-up (PDF)**: docs/WRITEUP.pdf

## Starting point

Written from scratch for Round 1 of the Techfest 2026-27 TrueFoundry Forge-a-thon. No upstream fork. Released under the MIT license.

## Team

**Team name**: Git Push, VIT Vellore

| Member | Role | GitHub |
|---|---|---|
| B. Sunil Kumar (Team Leader) | Lead developer of the extension core (TrueForge integration, MCP editor tools, context retrieval, diff review) | [s2kumar2007](https://github.com/s2kumar2007) |
| Eric Bejoy | Testing, documentation and demo video [TODO: confirm role] | [TODO: GitHub handle] |
| Ashmit Sharma | Resilience and model fallback code | [TODO: GitHub handle] |
| Shaurya Singla | Context and TrueForge session visibility code | [TODO: GitHub handle] |

## Architecture summary

The extension integrates VS Code with the TrueForge agent framework through a client-server architecture:

- **TrueForge client**: Connects to the local TrueForge daemon (`@truefoundry/trueforge-sdk` 0.182.0) over HTTP/SSE. The extension starts sessions (`sessions.create`), streams turns (`createTurnStream`), and sends tool approval results in resume turns via `user.tool_approval` messages.
- **Editor MCP tools**: Hosts a stateless loopback MCP server (`http://127.0.0.1:<port>/mcp`) registered via `PUT /api/v1/settings/mcp-servers` using a randomized bearer token. It exposes five editor tools:
  - `read_file`: Bounded file reads with line-range limits (max 40 lines per slice, max 80 for whole files) to conserve model context.
  - `list_dir`: Directory listing with strict workspace path containment.
  - `search_workspace`: Text and symbol search powered by ripgrep with ranked matches.
  - `propose_write`: Virtual diff generation for proposed file changes without modifying files on disk.
  - `run_command`: Shell command execution in the workspace root with timeout and process-tree termination.
- **Approval-driven per-hunk diff review**: `propose_write` opens an interactive side-by-side diff review panel. Users can accept or reject individual hunks independently. Only accepted hunks are applied atomically via `vscode.workspace.applyEdit`.
- **Undo**: A custom `forge.undoLast` stack stores up to 50 edits in memory, verifies base text integrity before reverting, restores original line endings (CRLF/LF), and deletes newly created files on undo. Normal VS Code undo (`Ctrl+Z`/`Cmd+Z`) remains fully functional.
- **Streaming and cancellation**: Model responses stream live into the chat panel. Pressing **Stop** calls `sessions.cancel`, clears review state, aborts pending approvals, and terminates running command process trees.

## Context assembly

Before executing a turn in Agent mode, Forge Agent automatically gathers relevant workspace context:

1. **Explicit mentions**: `@file:path` and `@symbol:name` mentions in the prompt are parsed first and given top priority (capped at 40 lines for files, 25 signatures for symbols).
2. **Ranked candidate shortlist**: Keywords extracted from the prompt are searched across the repository using ripgrep. Matches are ranked by term frequency, file path relevance, top-level symbol definitions, and module importer relationships (downstream dependencies). Dense hit windows are capped at 40 lines.
3. **Repo map**: A compact overview of workspace directory structure is budgeted up to 20% of the token allocation.
4. **Per-request caching**: File contents and symbol AST parses are cached in memory for the duration of a single `assembleContext` run and immediately discarded.
5. **Token budgeting**: The default context budget is `2000` tokens (`forge.contextBudget`), estimated at ~4 characters per token. For the fallback agent, the budget is `1500` tokens (`forge.fallbackContextBudget`).
6. **Context used block in the panel**: The chat panel displays a collapsible **Context used** block detailing:
   - Budget summary: `Context: <N> items, <used> of <budget> estimated tokens`
   - Per-item path, rationale, and estimated token size
   - Session identity (`Session: <id>`) and real harness events (subagent lifecycle lines like `Subagent <title> started/finished` and compaction lines like `Context compacted`)

## Model setup

- **Models used**:
  - Primary agent (`forge-agent`): Google Gemini `google-gemini/gemini-3-5-flash`, temperature 0.2, serialized tool calls (`parallel_tool_calls: false`), `reasoning_effort: "low"`, `max_tokens: 10000`.
  - Inline agent (`forge-inline`): Google Gemini `google-gemini/gemini-3-5-flash`, temperature 0.2.
  - Fallback agent (`forge-agent-fallback`): NVIDIA NIM `meta/llama-3.3-70b-instruct` (configured name: `forge-fallback/meta/llama-3.3-70b-instruct`), temperature 0.2, `max_tokens: 8000`.
- **Where they run**: Primary and inline models run on Google cloud APIs (`google-gemini/gemini-3-5-flash`). The fallback model runs on NVIDIA NIM cloud APIs (`forge-fallback/meta/llama-3.3-70b-instruct`). TrueForge runs locally on `127.0.0.1`. (The Groq adapter `scripts/groq-adapter.cjs` is optional and not used on the default path).
- **Cost**: Google Gemini and NVIDIA NIM free tiers, approximately INR 0.
- **How to switch models**:
  - To change provider models, edit the model fields in `agents/*.json` or update providers in the TrueForge UI (`http://localhost:8790`).
  - To configure the fallback agent with NVIDIA NIM (or another OpenAI-compatible provider), set `FALLBACK_BASE_URL`, `FALLBACK_MODEL` and `FALLBACK_API_KEY`, then run `node scripts/configure-fallback.cjs`. The extension preserves this selection during agent synchronization.
- **How the fallback works and its real limits**:
  - If the primary model encounters a permanent error (HTTP 401, 403, 413), it fails fast without retrying and immediately launches the fallback agent in a fresh session.
  - If the primary encounters transient errors (HTTP 429, 500, 502, 503, network drop), it retries with exponential backoff up to a 12s cap. If failures persist, it transitions to `forge-agent-fallback` on the independent second provider (NVIDIA NIM).
  - **Replay guard**: To prevent duplicate side effects, automatic retry and fallback are disabled once a `propose_write` or `run_command` has been approved.

## Performance tuning

The extension incorporates latency and token optimizations without weakening safety:

- **Combined ripgrep scans**: Ripgrep keyword and importer scans run as single alternated executions rather than spawning separate processes per keyword, preserving ranking inputs and cancellation responsiveness.
- **Per-request read cache**: File contents and symbol definitions are cached during context assembly and cleared at turn completion, avoiding redundant disk I/O.
- **Lower default context budget**: Default `forge.contextBudget` is set to `2000` tokens (down from 6000), reducing prompt payload size while maintaining retrieval quality.
- **Fast retry and fail-fast resilience**: Permanent HTTP errors fail fast without retry loops. Quota (429) retry waits are capped at 12s (down from 60s), adapter retries are capped at 2, and double-retry stacking across primary and fallback models is eliminated.
- **Tuned model parameters**: Primary agent parameters are set to `reasoning_effort: "low"` and `max_tokens: 10000`, while the fallback agent uses `max_tokens: 8000` and compaction trigger `30000`, reducing recovery and response latency.
- **Uncompromised safety rules**: MCP tool names (`read_file`, `list_dir`, `search_workspace`, `propose_write`, `run_command`), approval flows, serialized tool calls, and per-hunk diff review remain strictly enforced.

## Setup from a clean clone

### Prerequisites

- Node.js 22.14 or newer
- VS Code 1.90 or newer
- Git
- Python 3 with `pip` and `venv` (for Flask demo verification)
- A Google Gemini API key (for primary and inline models)
- An NVIDIA NIM API key (for the fallback model; free tier at https://build.nvidia.com)
- Optional: A Groq API key (optional alternative provider; not used on default path)

### 1. Install and build

```bash
git clone https://github.com/s2kumar2007/VS-CODE-EXTENSION.git
cd VS-CODE-EXTENSION
npm ci
npm run typecheck
npm test
npm run build
```

### 2. Start TrueForge

The extension requires TrueForge version `0.182.0`. Set the outbound host allowlist to permit loopback MCP connections:

**Windows PowerShell**
```powershell
$env:OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'
npx @truefoundry/trueforge@0.182.0
```

**macOS/Linux**
```bash
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' npx @truefoundry/trueforge@0.182.0
```

TrueForge will start on `http://localhost:8790`.

### 3. Configure providers without committing keys

#### A. Primary provider: Google Gemini
1. Open the TrueForge UI in your browser at `http://localhost:8790`.
2. Navigate to **Settings** -> **Model Providers**.
3. Add a **Google** provider named `google-gemini`, enter your Gemini API key, and ensure `gemini-3-5-flash` is enabled.

#### B. Fallback provider: NVIDIA NIM (Second Provider)
Configure NVIDIA NIM as the independent fallback provider using the helper script:

**Windows PowerShell**
```powershell
$env:FALLBACK_BASE_URL="https://integrate.api.nvidia.com/v1"
$env:FALLBACK_MODEL="meta/llama-3.3-70b-instruct"
$env:FALLBACK_API_KEY="<your-nvidia-nim-api-key>"
node scripts/configure-fallback.cjs
```

**macOS/Linux**
```bash
FALLBACK_BASE_URL="https://integrate.api.nvidia.com/v1" \
FALLBACK_MODEL="meta/llama-3.3-70b-instruct" \
FALLBACK_API_KEY="<your-nvidia-nim-api-key>" \
node scripts/configure-fallback.cjs
```

The script registers `forge-fallback` in TrueForge and points `forge-agent-fallback` to `forge-fallback/meta/llama-3.3-70b-instruct`. Credentials are saved only in TrueForge.

*(Optional: Groq adapter `scripts/groq-adapter.cjs` and setup scripts `scripts/configure-groq.*` are retained in the repo for alternative setups, but are not used on the default path.)*

### 4. Load agent definitions and launch

Open the repository folder in VS Code and press **F5** to start the Extension Development Host (or run `code --extensionDevelopmentPath=. <workspace-folder>`).

The extension synchronizes `agents/*.json` with TrueForge and registers the `forge-editor` MCP server automatically upon activation.

## How to run the three fixed tasks against Flask 3.1.3

### Workspace setup

```bash
git clone https://github.com/pallets/flask.git
cd flask
git checkout 22d924701a6ae2e4cd01e9a15bbaf3946094af65
python -m venv .venv
```

Activate the virtual environment:
- Windows PowerShell: `.venv\Scripts\Activate.ps1`
- macOS/Linux: `source .venv/bin/activate`

Install Flask dependencies (pinning pytest < 9 for Flask 3.1.3 compatibility):
```bash
pip install -e . "pytest<9" python-dotenv asgiref
```

Open the Flask repository in the Extension Development Host.

### Task A — Inline edit

1. Open `src/flask/helpers.py` and select the `get_debug_flag` function.
2. Trigger inline edit (`Ctrl+K Ctrl+I` on Windows/Linux, `Cmd+K Cmd+I` on macOS).
3. Enter the exact prompt:
   ```
   Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.
   ```
4. Review the proposed diff in the side-by-side editor. Accept the desired hunks and confirm.
5. Verification:
   - Windows PowerShell:
     ```powershell
     $env:PYTHONPATH="src"
     python <extension-repo>\scripts\verify-flask-demo.py A
     ```
   - macOS/Linux:
     ```bash
     PYTHONPATH=src python <extension-repo>/scripts/verify-flask-demo.py A
     ```
6. Test undo: run `Forge: Undo last applied change` from the Command Palette.
7. Reset workspace:
   ```bash
   git checkout .
   git clean -fd
   ```

### Task B — Agent mode (no files mentioned)

1. Open the chat panel (`Forge: Open Agent Panel`).
2. Enter the exact prompt:
   ```
   Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.
   ```
3. Expand **Context used** to verify discovered files, reasons, and token budget.
4. Review proposed changes across `src/flask/cli.py`, `tests/test_cli.py`, and `docs/cli.rst`. Accept hunks and confirm.
5. Approve the test execution command when prompted.
6. Verification:
   ```bash
   python -m pytest tests/test_cli.py -q
   python -m flask --help
   ```
   - Windows PowerShell:
     ```powershell
     $env:PYTHONPATH="src"
     python <extension-repo>\scripts\verify-flask-demo.py B
     ```
   - macOS/Linux:
     ```bash
     PYTHONPATH=src python <extension-repo>/scripts/verify-flask-demo.py B
     ```
7. Reset workspace:
   ```bash
   git checkout .
   git clean -fd
   ```

### Task C — Resilience and failure handling

1. Set an invalid primary key in TrueForge provider settings (leaving the fallback provider valid).
2. Repeat the exact Task A inline-edit request on `get_debug_flag` in `src/flask/helpers.py`.
3. Observe initial retry notice, then the takeover notice: `Primary model failed, using fallback`. The request completes in a fresh session on the fallback model.
4. Reject proposed writes to keep the checkout clean.
5. Reset workspace:
   ```bash
   git checkout .
   git clean -fd
   ```

## Known limitations

- **Command permissions**: Shell commands run with the host user's permissions. Path preflight checks reject obvious parent traversal and external paths, but `run_command` is not an OS sandbox. Approved command effects cannot be rolled back automatically.
- **Undo persistence**: The custom undo stack (`forge.undoLast`) persists up to 50 operations in workspaceState across extension reloads, but will refuse to overwrite files if subsequent external manual edits were made.
- **Approved operation guard**: To prevent duplicate external mutations, automatic retry and fallback are disabled once an approval has been granted for a write or command; cancelled or failed runs can retain previously approved effects.
- **Provider rate limits**: Primary (Google Gemini) and fallback (NVIDIA NIM) run on independent providers to protect against single-provider outages, but each remains subject to its respective provider quotas and rate limits.
- **Context estimation**: Token budgeting uses a character-based heuristic (~4 characters per token) rather than provider-specific BPE tokenizers.
- **Single active request**: Only one request can be processed per workspace at a time.
- **Dynamic subagents**: Subagent handling is implemented and tested, but subagent spawning is dynamic and may not trigger on smaller tasks within token limits.

## AI tools used

- GitHub Copilot
- ChatGPT
- [TODO: confirm all AI tools]

## Licence

MIT License. See [LICENSE](LICENSE) for details.
