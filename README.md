# Forge Agent

Forge Agent is a VS Code extension that turns **TrueForge agent sessions** into a reviewed, workspace-aware coding workflow. It provides local MCP editor tools, explicit diff approval, command confirmation, and undo support.

**Current model configuration:** Primary and Inline agents use Groq (groq/gpt-oss-120b), Fallback uses Google Gemini (google-gemini/gemini-3-5-flash).

## Features

- Agent mode with workspace search and context-aware ranked retrieval
- Inline editing for the selected text
- Exact or full-file code proposals through a reviewable diff
- Per-hunk Accept/Reject controls
- Explicit approval for shell commands
- Undo for accepted Forge edits
- Groq-only provider configuration
- MCP loopback communication with bearer authentication
- Automatic setup retry and bounded fallback handling

## Requirements

- Windows, macOS, or Linux
- Node.js 22.14 or newer
- VS Code 1.90 or newer
- Git
- A Groq API key
- Python 3 for the optional Flask demo

## Quick start

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

The tested TrueForge and SDK versions are `0.182.0`.

**Windows PowerShell**

```powershell
$env:OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'
npx @truefoundry/trueforge@0.182.0
```

**macOS/Linux**

```bash
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' npx @truefoundry/trueforge@0.182.0
```

TrueForge opens at `http://localhost:8790`. The loopback host allowlist is required for Forge's local MCP editor server.

### 3. Configure Groq

On Windows PowerShell, run:

```powershell
powershell -NoProfile -File .\scripts\configure-groq.ps1
```

The script prompts for the key without displaying it. On macOS/Linux, set the key in the process environment and run:

```bash
GROQ_API_KEY="<your-api-key>" node scripts/configure-groq.cjs
```

The setup helper:

- verifies Groq model access
- sends the key only to Groq and the loopback TrueForge server
- starts the local Groq compatibility adapter
- creates or updates the Groq TrueForge provider
- synchronizes the committed agent manifests
- does not write the key into the repository or VS Code settings

The key remains in TrueForge's local provider configuration outside this repository.

> Keep `GROQ_API_KEY` out of files, shell history where possible, and source control.

### 4. Start the compatibility adapter

The adapter is usually started by the setup helper. Restart it manually if TrueForge is restarted after a machine restart:

```bash
node scripts/groq-adapter.cjs
```

It listens only on `127.0.0.1:8791` and forwards requests to Groq using the configured loopback provider.

### 5. Launch the extension

Open this repository in VS Code and press **F5** to start the Extension Development Host.

Alternatively:

```bash
code --new-window --extensionDevelopmentPath="/absolute/path/to/VS-CODE-EXTENSION" "/absolute/path/to/workspace"
```

The extension registers the local `forge-editor` MCP server, authenticates that registration with TrueForge, and synchronizes `agents/*.json`.

## Groq model configuration

All roles use the same Groq model:

| Role | TrueForge agent | Groq model ID |
|---|---|---|
| Primary | `groq/gpt-oss-120b` | `openai/gpt-oss-120b` |
| Inline | `groq/gpt-oss-120b` | `openai/gpt-oss-120b` |
| Fallback | `groq/gpt-oss-120b` | `openai/gpt-oss-120b` |

The provider base URL is:

```text
http://127.0.0.1:8791/v1
```

`config.example.json` is a configuration checklist, not an importable TrueForge manifest.

## Usage

### Agent mode

Run **Forge: Open Agent Panel** from the Command Palette.

- Searches the workspace and collects ranked context
- Reads bounded file slices and symbols
- Creates exact edit proposals or complete files
- Opens proposals for review before changing the workspace

You can add context directly with `@file:path` or `@symbol:name`.

### Inline edit

Select text, then run **Forge: Inline Edit Selection**:

- macOS: `Cmd+K`, `Cmd+I`
- Windows/Linux: `Ctrl+K`, `Ctrl+I`

The inline agent is limited to the selected edit and supports one reviewed proposal.

### Review and apply

`propose_write` produces a virtual diff:

1. Review each proposed hunk.
2. Accept or reject individual hunks.
3. Confirm the overall result.
4. Forge applies only accepted hunks.

Existing line endings and trailing-newline style are preserved.

### Commands

Commands require explicit confirmation before execution. Forge:

- runs commands in the workspace root
- caps returned output at 8 KiB
- supports cancellation
- stops the process tree after 120 seconds or when Stop is used

Commands run with your operating-system permissions. Approval is confirmation of intent, not an OS sandbox.

### Undo

Run **Forge: Undo last applied change** to restore the most recently applied Forge edit.

- Tracks up to 50 changes
- Refuses to overwrite later manual edits
- Works across editor reopen while the extension remains active
- Is not persisted across extension reload

Native VS Code `Ctrl+Z`/`Cmd+Z` remains available for normal undo behavior.


## Context assembly

Forge Agent automatically selects relevant workspace context before executing a turn in Agent mode:

1. **Explicit mentions**: Explicit `@file:path` and `@symbol:name` mentions are granted top priority. File slices are capped at 40 lines plus top-level signatures; symbols provide a bounded window around the target symbol.
2. **Ranked candidate shortlist**: Keywords extracted from the prompt are searched across the repository using ripgrep. Hits are scored by term matches, path matches, top-level symbol definitions matching keywords, and importing files (downstream consumers of modified modules). Dense hit windows are capped at 40 lines; symbols are capped at 25 signatures.
3. **Repo map**: A compact file-tree overview is budgeted to at most 20% of the token allocation.
4. **Token budgeting**: A greedy packer fills items by priority within the configured token budget (default `6000` tokens, or `1500` tokens for the Groq fallback, estimated at ~4 characters per token). Items that exceed available headroom are line-truncated if at least 80 tokens remain, or safely dropped.
5. **Context used block in the panel**: The Agent chat panel displays a collapsible **Context used** block detailing:
   - A budget summary line: `Context: <N> items, <used> of <budget> estimated tokens`
   - Each selected item with its path/slice, estimated token size, and rationale (why it was chosen).
   - Real TrueForge harness events (subagent lifecycle lines like `Subagent search started` and compaction lines like `Context compacted`) and session identity (`Session: <id>`).



## Extension settings

| Setting | Default | Description |
|---|---|---|
| `forge.baseUrl` | `http://localhost:8790` | TrueForge server URL |
| `forge.agentName` | `forge-agent` | Primary agent |
| `forge.fallbackAgentName` | `forge-agent-fallback` | Fallback agent |
| `forge.contextBudget` | `2000` | Agent context token estimate |
| `forge.fallbackContextBudget` | `1500` | Groq fallback context token estimate |

The context budget is estimated from characters (`characters / 4`). It is not an exact provider tokenizer limit.

## Performance tuning

The extension incorporates latency optimizations without weakening safety:

- **Context assembly scans**: Ripgrep literal keyword searches and module importer queries are combined into single alternated executions rather than spawning separate processes per keyword, preserving ranking inputs and cancellation responsiveness.
- **Per-request read cache**: File contents and top-level symbol parses are cached in memory for the duration of a single `assembleContext` run and discarded at turn completion, preventing duplicate disk reads and regex AST parses without retaining stale data across requests.
- **Lower default context budget**: Default `forge.contextBudget` is set to `2000` tokens (down from 6000), reducing initial prompt token payloads while keeping `forge.fallbackContextBudget` at `1500`.
- **Fast retry and fail-fast resilience**: Permanent HTTP errors (401, 403, 400, 404) fail fast without retrying on the primary model, immediately falling back. Quota (429) wait hints are bounded to 12s (capped from 60s), adapter retries are capped at 2 attempts, and double-retry stacking across primary and fallback models is eliminated, dropping worst-case retry latency to ~20–30s.
- **Tuned fallback agent**: Fallback agent reasoning effort is set to `low` and `max_tokens` is capped at `10000`, speeding up recovery turns.
- **Safety rules unchanged**: MCP tool names (`read_file`, `list_dir`, `search_workspace`, `propose_write`, `run_command`), approval flows, serialized writes/commands, and per-hunk diff review remain strictly intact.

## Groq compatibility behavior

TrueForge 0.182.0 compatibility is handled through `scripts/groq-adapter.cjs`. The adapter:

- strips incompatible assistant reasoning fields
- removes unsupported reasoning parameters
- preserves Groq tool calls and Server-Sent Events
- honors quota retry hints
- aborts waits when the downstream connection closes
- retries recognized tool-schema generation errors at most two times
- does not replay visible text output

Groq account quotas and single-request token limits remain provider-side constraints. The adapter cannot create additional quota.

## Safety and recovery

Forge does not operate as an OS sandbox.

- File proposals are checked against the reviewed base before application
- Outside paths and symlinks are rejected
- Commands require a fresh single-use approval
- Approved commands can modify files or otherwise affect the system
- Command effects cannot always be rolled back automatically
- Cancelled or failed runs can retain previously approved effects

Inspect `git status` after failed or cancelled operations and use **Undo last applied change** for Forge file edits.

Provider output is not evidence that a workspace edit was saved. Confirm the returned tool result and inspect the workspace.

## Development checks

```bash
npm ci
npm run typecheck
npm test
npm run build
```

The test suite covers agents, context assembly, retries, cancellation, review behavior, command safety, MCP integration, and configuration contracts.

## Flask demo

An optional Flask 3.1.3 demo is documented in [scripts/demo.md](scripts/demo.md). Demo setup and verification also use:

- [docs/RUBRIC.md](docs/RUBRIC.md)
- [docs/LIVE_TESTS.md](docs/LIVE_TESTS.md)
- [docs/AUDIT.md](docs/AUDIT.md)
- [docs/SUBMISSION_STATUS.md](docs/SUBMISSION_STATUS.md)
- [docs/WRITEUP.md](docs/WRITEUP.md)

## License

MIT
