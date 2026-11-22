# Forge Agent

Forge Agent is a VS Code extension that turns **TrueForge agent sessions** into an interactive, reviewed coding workflow. The agent loop runs on a local TrueForge server, which orchestrates the model, subagents, and context compaction, while the editor exposes local workspace capabilities as Model Context Protocol (MCP) tools. The extension provides automated context assembly, per-hunk interactive diff review, explicit command approvals, multi-step undo, and resilient model fallback.

- **Demo video**: https://drive.google.com/file/d/1MDwhOBLavXx0RgBdyjqqmzzy4vKF1Lid/view?usp=drive_link
- **Write-up (PDF)**: docs/WRITEUP.pdf

## Team

**Team name**: Git Push, VIT Vellore

| Member | Role | GitHub |
|---|---|---|
| B. Sunil Kumar (Team Leader) | Team leader | [s2kumar2007](https://github.com/s2kumar2007) |
| Eric Bejoy | Testing, documentation and demo video | [ericjbejoy-ux](https://github.com/ericjbejoy-ux) |
| Ashmit Sharma | Resilience and model fallback code | [ASH10022008](https://github.com/ASH10022008) |
| Shaurya Singla | Context and TrueForge session visibility code | [shauryasingla505](https://github.com/shauryasingla505) |

## Starting point

Written from scratch for Round 1 of the Techfest 2026-27 TrueFoundry Forge-a-thon. There is no upstream fork. Released under the MIT license. Core dependencies: `@truefoundry/trueforge-sdk` (0.182.0), `@modelcontextprotocol/sdk` (1.32.2), `@vscode/ripgrep` (1.18.0), `diff` (9.0.0), `three` (0.187.0), and `zod` (4.6.7).

## Architecture summary

The extension integrates VS Code with the TrueForge agent framework through an asynchronous client-server architecture:

```
[Developer / VS Code] <---> [Webview Chat Panel / Inline Edit]
                                     |
                         [Forge Agent Controller]
                         /          |           \
           [Circuit Breaker]  [Hunk Review & Undo]  [Loopback MCP: forge-editor]
                  |                 |                      |
      [TrueForge Server] <----------+            [Workspace FS / Tools]
        (sessions/turns)                          (ripgrep, symbols, diags)
         /             \
 [Primary Model]   [Fallback Model]
  (NVIDIA NIM)      (Google Gemini)
```

- **TrueForge client**: Connects to the local TrueForge daemon (`@truefoundry/trueforge-sdk` 0.182.0) over HTTP/SSE (`http://localhost:8790`). The extension creates sessions (`sessions.create`), streams turns (`createTurnStream`), and sends tool approval decisions in resume turns via `user.tool_approval` messages.
- **Editor MCP tools**: Hosts a stateless loopback MCP server (`http://127.0.0.1:<port>/mcp`) registered via `PUT /api/v1/settings/mcp-servers` using a randomized bearer token. It exposes ten tools:
  - **Core tools**:
    - `read_file`: Bounded file reads with line-range limits (max 80 lines per slice, or outline=true for definitions) to conserve model context. Refuses secret-like files.
    - `list_dir`: Directory listing with strict workspace path containment and secret-file omission.
    - `search_workspace`: Text and symbol search powered by ripgrep with ranked matches, omitting secret files.
    - `propose_write`: Virtual diff generation supporting whole-file replacements, exact-anchor search/replace, or line ranges `{ startLine, endLine, newText }` with SHA-256 stale-file guards.
    - `run_command`: Shell command execution in the workspace root with timeout and process-tree termination.
  - **Advanced tools**:
    - `propose_changes`: Atomic multi-file proposals across multiple workspace files with unified hunk review.
    - `search_symbols`: Workspace symbol search leveraging native language servers and indexers.
    - `find_references`: Workspace symbol reference search for impact analysis.
    - `get_diagnostics`: Real-time compiler and linter diagnostics for workspace files.
    - `run_tests`: Framework-aware test runner (`pytest`, `vitest`, `jest`, `npm`) with confirmation gating.
- **Approval gates**: Enforced per agent manifest. In `forge-agent` and `forge-agent-fallback`, `propose_write`, `propose_changes`, `run_command`, and `run_tests` require explicit user confirmation. In `forge-inline`, `propose_write` requires user confirmation.
- **Mutation lock**: A shared `withMutationLock` queue serializes mutating operations (`propose_write`, `propose_changes`, `run_command`, `run_tests`) to prevent write races.
- **Secret file protection**: Context assembly, directory listings, searches, and file reads strictly skip and refuse sensitive files matching `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `credentials*`, `*.p12`, and anything under `.git`, while allowing legitimate configuration files (e.g. `config.py`).
- **Cross-request workspace cache**: `WorkspaceCache` caches the workspace file list and file text across requests, validated on every lookup by file modification time (`mtimeMs`) and byte size (`size`), with automatic invalidation on VS Code file-change events and proposed edits.
- **Approval-driven per-hunk diff review**: `propose_write` and `propose_changes` open an interactive side-by-side diff review panel with automated confidence scoring (`HIGH`, `MEDIUM`, `LOW`). Users can accept or reject individual hunks independently. Only accepted hunks are applied atomically via `vscode.workspace.applyEdit`.
- **Undo**: A custom `forge.undoLast` stack stores up to 50 edits in memory (`workspaceState`), verifies base text integrity before reverting, restores original line endings (CRLF/LF), and deletes newly created files on undo. Normal VS Code undo (`Ctrl+Z` / `Cmd+Z`) remains fully functional.
- **Streaming and cancellation**: Model responses stream live into the chat panel with real-time diff previews. Pressing **Stop** calls `sessions.cancel`, clears review state, aborts pending approvals, and terminates running command process trees.

## Webview Panel Features

The chat webview panel (`src/panel/ChatPanel.ts`, `media/`) provides:
- **Native VS Code styling**: Fully integrated using `--vscode-*` CSS theme variables.
- **Progress timeline**: 5-step operational timeline (`Context` -> `Model` -> `Tools` -> `Review` -> `Done`).
- **Session & model status**: TrueForge session identity (`Session: <id>`), active model indicator, and token usage progress bar.
- **Collapsible Context Used block**: Details total estimated tokens vs. budget, individual file items, line ranges, and selection rationales.
- **Lifecycle events**: Displays real harness events including subagent executions (`Subagent <title> started/finished`) and compaction notices (`Context compacted`).
- **Confidence-tagged diff cards**: Side-by-side diff reviews with `HIGH`, `MEDIUM`, or `LOW` confidence ratings and individual hunk toggles.
- **Header controls**: Theme selection (`Auto` / `Light` / `Dark`) mapped to `forge.panel.theme`, and optional 3D procedural guide character (`forge.guide.character3d: false` by default, with 2D SVG fallback).
- **Prompt chips & utilities**: Quick-action prompt suggestions and response copy buttons.

## Context Assembly

Before executing a turn in Agent mode, Forge Agent automatically gathers relevant workspace context:

1. **Explicit mentions**: `@file:path` and `@symbol:name` mentions in the prompt are parsed first and given top priority (capped at 40 lines for files, 25 signatures for symbols).
2. **Ranked candidate shortlist**: Keywords extracted from the prompt are searched across the repository using ripgrep. Matches are ranked by term frequency, inverse document frequency weight (`keywordWeight`), top-level symbol definitions, and module importer relationships. Hit windows from the same file are merged without overlapping before token budgeting, with dense windows capped at 40 lines.
3. **Repo map**: A compact overview of workspace directory structure budgeted up to 20% of the token allocation.
4. **Cross-request caching**: Workspace file lists and file contents are cached across requests by `WorkspaceCache` validated by file `mtimeMs` and `size`.
5. **Secret file exclusion**: Context assembly strictly excludes secret-like files (`.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `credentials*`, `*.p12`, `.git`).
6. **Token budgeting**: Base budget of `2000` tokens (`forge.contextBudget`), estimated at ~4 characters per token (`CHARS_PER_TOKEN = 4`). For fallback sessions, the budget is `1500` tokens (`forge.fallbackContextBudget`). Complex requests dynamically receive up to 1000 tokens of headroom via `computeAdaptiveBudget` (capped at 4000).

## Model Setup & Fallback

- **Models used**:
  - Primary agent (`forge-agent`): NVIDIA NIM `forge-nvidia/nemotron-3-5-lightning-30b-a3b` (`nvidia/nemotron-3.5-lightning-30b-a3b`), cloud API, temperature 0.2, parallel tool calls true, max tokens 8000, context compaction trigger 40000.
  - Inline agent (`forge-inline`): NVIDIA NIM `forge-nvidia/nemotron-3-5-lightning-30b-a3b`, cloud API, temperature 0.2, compaction trigger 5500.
  - Fallback agent (`forge-agent-fallback`): Google Gemini `google-gemini/gemini-3-8-flash`, cloud API, temperature 0.2, parallel tool calls true, max tokens 8000, context compaction trigger 30000.
- **Where they run & cost**: Primary and inline models run on NVIDIA NIM cloud APIs (`https://integrate.api.nvidia.com/v1`). The fallback model runs on Google Gemini cloud APIs. TrueForge runs locally on `http://localhost:8790`. Both operate on provider free tiers (approximately INR 0 within free limits).
- **Model switching**: Run `node scripts/configure-provider.cjs` or update provider settings in TrueForge. The synchronization logic automatically migrates deprecated Gemini identifiers (`gemini-2.5-flash`) to `google-gemini/gemini-3-8-flash` while preserving custom opt-in fallback models.
- **Fallback behavior**:
  - **Permanent errors**: HTTP 400, 401, 403, 404, 413, 422, unprocessable entity, and unconfigured model errors are recognized as permanent (`isPermanentError() = true`). They bypass retries and switch immediately to the fallback model.
  - **Transient errors**: HTTP 429, 500, 502, 503, and network disconnects retry with exponential backoff up to 12s, capped at 2 retries per target.
  - **Circuit breaker**: An in-memory circuit breaker marks an agent unhealthy for 5 minutes after a connection error, timeout, 401/403, 413, or 5xx, routing subsequent requests directly to fallback.
  - **Watchdog timers**: `forge.firstTokenTimeoutMs` (45000ms), `forge.stallTimeoutMs` (75000ms), and `forge.failoverBudgetMs` (120000ms) protect against unresponsive streaming. Failover budget deducts only during active failover turns.
  - **Handoff brief & replay guard**: Fallback sessions receive a continuation brief summarizing read files, searches, and unapplied diffs up to `forge.fallbackContextBudget` (1500 tokens). To prevent duplicate external mutations, retry and fallback are disabled once an approval has been granted. Reaching the 60-step iteration limit stops cleanly without triggering fallback.

## Commands & Keybindings

Contributed commands from `package.json`:
- `forge.openPanel`: "Forge: Open Agent Panel"
- `forge.inlineEdit`: "Forge: Inline Edit Selection" — bound to `Ctrl+K Ctrl+I` (Windows/Linux) or `Cmd+K Cmd+I` (macOS) when `editorTextFocus && editorHasSelection`
- `forge.undoLast`: "Forge: Undo last applied change"
- `forge.testProviders`: "Forge: Test providers"
- `forge.showTimings`: "Forge: Show last run timings"

## Configuration Settings

Settings and defaults from `package.json`:

| Setting | Type | Default | Description |
|---|:---:|:---:|---|
| `forge.baseUrl` | `string` | `"http://localhost:8790"` | TrueForge server URL |
| `forge.agentName` | `string` | `"forge-agent"` | Name of the primary agent registered in TrueForge |
| `forge.fallbackAgentName` | `string` | `"forge-agent-fallback"` | Name of the fallback agent registered in TrueForge |
| `forge.fallbackModel` | `string` | `"google-gemini/gemini-3-8-flash"` | Fallback model name when primary fails |
| `forge.fallbackModels` | `array` | `["forge-fallback/mistral-large-4-1t-a52b", "google-gemini/gemini-3-8-flash"]` | Ordered fallback models to try before exhausting options |
| `forge.firstTokenTimeoutMs` | `number` | `45000` | Max milliseconds to wait for the first event before failing over |
| `forge.stallTimeoutMs` | `number` | `75000` | Max milliseconds between streaming events before aborting a stalled model turn |
| `forge.failoverBudgetMs` | `number` | `120000` | Total wall-clock failover budget in ms across all retries and fallback attempts |
| `forge.contextBudget` | `number` | `2000` | Token budget (~4 chars/token) for automatically assembled context |
| `forge.fallbackContextBudget` | `number` | `1500` | Token budget (~4 chars/token) for context when using the fallback agent |
| `forge.explorationBudget` | `number` | `12` | Maximum read-only tool calls allowed per run before requiring write proposals |
| `forge.faultInjection` | `string` | `"none"` | Fault injection mode for resilience testing (`"none"`, `"auth"`, `"network"`, `"server"`, `"timeout"`) |
| `forge.guide.character3d` | `boolean` | `false` | Show procedural 3D character guide beside chat |
| `forge.panel.theme` | `string` | `"auto"` | Panel color theme override (`"auto"`, `"light"`, `"dark"`) |

## Setup from a clean clone

### Prerequisites

- Node.js 22.14 or newer
- VS Code 1.90 or newer
- Git
- Python 3 with `pip` and `venv` (for Flask demo verification)
- An NVIDIA NIM API key (for primary and inline models; free tier at https://build.nvidia.com)
- A Google Gemini API key (for the fallback model; free tier at https://aistudio.google.com)

### 1. Install and build

Clone the repository and install dependencies:

**Windows PowerShell**
```powershell
git clone https://github.com/s2kumar2007/VS-CODE-EXTENSION.git
cd VS-CODE-EXTENSION\forge-agent
npm ci
npm run typecheck
npm test
npm run build
```

**macOS/Linux**
```bash
git clone https://github.com/s2kumar2007/VS-CODE-EXTENSION.git
cd VS-CODE-EXTENSION/forge-agent
npm ci
npm run typecheck
npm test
npm run build
```

### 2. Setup order

Follow these steps in order:

#### Step 1: Start TrueForge with outbound host allowlist
Start TrueForge version `0.182.0`. Set `OUTBOUND_URL_ALLOWED_HOSTS` to permit loopback MCP connections and NVIDIA NIM endpoints, and set `NODE_OPTIONS=--dns-result-order=ipv4first` if needed:

**Windows PowerShell**
```powershell
$env:OUTBOUND_URL_ALLOWED_HOSTS = '["127.0.0.1","integrate.api.nvidia.com"]'
$env:NODE_OPTIONS = "--dns-result-order=ipv4first"
npx @truefoundry/trueforge@0.182.0
```

**macOS/Linux**
```bash
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","integrate.api.nvidia.com"]' NODE_OPTIONS="--dns-result-order=ipv4first" npx @truefoundry/trueforge@0.182.0
```

TrueForge starts on `http://localhost:8790`.

#### Step 2: Add Google Gemini provider in TrueForge settings
1. Open the TrueForge UI in your browser at `http://localhost:8790`.
2. Navigate to **Settings** -> **Model Providers**.
3. Add a **Google** provider named `google-gemini`, enter your Gemini API key, and ensure `gemini-3-8-flash` is enabled.

#### Step 3: Launch extension once (press F5)
Open the `forge-agent` folder in VS Code and press **F5** to start the Extension Development Host. The extension activates and registers the loopback `forge-editor` MCP server with TrueForge.

#### Step 4: Run provider setup script
With TrueForge running and `forge-editor` registered, configure NVIDIA NIM as the primary provider:

**Windows PowerShell**
```powershell
$env:PROVIDER_BASE_URL = "https://integrate.api.nvidia.com/v1"
$env:PROVIDER_MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b"
$env:PROVIDER_API_KEY = "<your-nvidia-nim-api-key>"
node scripts/configure-provider.cjs
```

**macOS/Linux**
```bash
PROVIDER_BASE_URL="https://integrate.api.nvidia.com/v1" \
PROVIDER_MODEL="nvidia/nemotron-3.5-lightning-30b-a3b" \
PROVIDER_API_KEY="<your-nvidia-nim-api-key>" \
node scripts/configure-provider.cjs
```

Credentials are saved in TrueForge, never committed to the repository.

#### Step 5: Restart the extension
Press `Ctrl+R` (or `Cmd+R` on macOS) in the Extension Development Host to reload the extension with the synchronized agent manifests.

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

Install Flask dependencies:
```bash
pip install -e . "pytest<9" python-dotenv asgiref
```

Open the Flask folder in the Extension Development Host.

### Task A — Inline edit

1. Open `src/flask/helpers.py` and select the `get_debug_flag` function.
2. Trigger inline edit (`Ctrl+K Ctrl+I` on Windows/Linux, `Cmd+K Cmd+I` on macOS).
3. Enter the exact prompt:
   ```
   Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.
   ```
4. Review the proposed diff in the side-by-side editor, accept hunks, and confirm.
5. Verification:
   - Windows PowerShell:
     ```powershell
     $env:PYTHONPATH = "src"
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
3. Expand **Context used** to inspect discovered files, reasons, and token budget.
4. Review proposed changes across `src/flask/cli.py`, `tests/test_cli.py`, and `docs/cli.rst`. Accept hunks and confirm.
5. Approve the test execution command when prompted.
6. Verification:
   ```bash
   python -m pytest tests/test_cli.py -q
   python -m flask --help
   ```
   - Windows PowerShell:
     ```powershell
     $env:PYTHONPATH = "src"
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

1. Set an invalid primary key in TrueForge provider settings (for `forge-nvidia`, keeping `google-gemini` valid).
2. Repeat the Task A inline-edit request on `get_debug_flag` in `src/flask/helpers.py`.
3. Observe the notice: `Primary unavailable, continuing on fallback (reusing N files already read)` (or `Primary unavailable, continuing on fallback` if no files were read). The request continues in a session on the fallback model.
4. Reject proposed writes to keep the checkout clean.
5. Reset workspace:
   ```bash
   git checkout .
   git clean -fd
   ```

## Verification & Test Results

- Automated test suite: **347 tests passing across 40 test files** (`npm test`).
- Typecheck: clean (`tsc --noEmit`).
- Production build: clean (`node esbuild.js`).
- Flask verification: independent verification script `python scripts/verify-flask-demo.py` confirms Task A and Task B specifications.
- Fault simulation: tested deterministically via `forge.faultInjection` (`"none"`, `"auth"`, `"network"`, `"server"`, `"timeout"`).
- Live run artifacts: recorded in `docs/` (`docs/live-A-exact-edits.json`, `docs/live-B-verified.json`, `docs/live-C-official-recheck.json`).

## Known Limitations

- **Command permissions**: Shell commands run with the host user's permissions. Path checks reject directory traversal, but `run_command` is not an OS sandbox. Approved command side-effects cannot be rolled back automatically.
- **Undo persistence**: The undo stack (`forge.undoLast`) stores up to 50 operations in memory across reloads, but will refuse to overwrite files if subsequent external edits occurred.
- **Approved operation guard**: Automatic retry and fallback are disabled once an approval has been granted for a write or command, preventing duplicate external mutations; cancelled or failed runs can retain previously approved effects.
- **Provider rate limits**: Primary (NVIDIA NIM) and fallback (Google Gemini) run on independent providers, but each is subject to its respective provider free-tier quotas and rate limits.
- **Context estimation**: Token budgeting uses a character-based heuristic (~4 characters per token).
- **Single active request**: One active request is processed per workspace at a time.
- **Dynamic subagents**: Subagent handling is implemented, but model initiation of subagents is dynamic and depends on model instruction following.

## AI Tools Declared

- GitHub Copilot
- ChatGPT
- Claude (Anthropic)

## Licence

MIT License. See [LICENSE](LICENSE) for details.
