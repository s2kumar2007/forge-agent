# Demo script — Flask 3.1.3

This script guides the official demonstration video and local reproduction against pallets/flask 3.1.3.

## Video recording rules

- **Maximum duration**: 4 minutes (240 seconds) maximum.
- **Strict presentation order**: Task A (inline edit), then Task B (agent mode), then Task C (resilience/fallback).
- **Continuous footage**: Do not cut between entering an instruction and the diff review appearing.
- **TrueForge visibility**: Show the TrueForge session during Task B, highlighting session identity, turns, and real harness events.

## Setup

1. Follow README instructions: `npm ci`, `npm run typecheck`, `npm test`, `npm run build`.
2. Start TrueForge on `http://localhost:8790` with outbound host allowlist:
   ```bash
   OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","integrate.api.nvidia.com"]' npx @truefoundry/trueforge@0.182.0
   ```
3. Configure model providers locally without committing credentials:
   - In TrueForge (`http://localhost:8790` -> Settings -> Model Providers), configure fallback provider `google-gemini` with your Gemini API key and ensure `gemini-3-8-flash` is enabled.
   - Launch extension once (press F5) to register the `forge-editor` MCP server.
   - Configure primary provider `forge-nvidia` (NVIDIA NIM with `nvidia/nemotron-3.5-lightning-30b-a3b`):
     - Windows PowerShell:
       ```powershell
       $env:PROVIDER_BASE_URL="https://integrate.api.nvidia.com/v1"
       $env:PROVIDER_MODEL="nvidia/nemotron-3.5-lightning-30b-a3b"
       $env:PROVIDER_API_KEY="<your-nvidia-nim-api-key>"
       node scripts/configure-provider.cjs
       ```
     - macOS/Linux:
       ```bash
       PROVIDER_BASE_URL="https://integrate.api.nvidia.com/v1" \
       PROVIDER_MODEL="nvidia/nemotron-3.5-lightning-30b-a3b" \
       PROVIDER_API_KEY="<your-nvidia-nim-api-key>" \
       node scripts/configure-provider.cjs
       ```
   - Reload extension (`Ctrl+R` in extension host).
4. Clone Flask repository and checkout tag 3.1.3:
   ```bash
   git clone https://github.com/pallets/flask.git
   cd flask
   git checkout 22d924701a6ae2e4cd01e9a15bbaf3946094af65
   ```
5. Create and activate a Python virtual environment:
   - Windows PowerShell: `python -m venv .venv; .venv\Scripts\Activate.ps1`
   - macOS/Linux: `python3 -m venv .venv && source .venv/bin/activate`
   Install dependencies (pinning pytest < 9 for Flask 3.1.3):
   ```bash
   pip install -e . "pytest<9" python-dotenv asgiref
   ```
6. Open Flask in the Extension Development Host (`code --extensionDevelopmentPath=<repo> .`). Confirm `git status --short` is clean.

## Task A — Inline edit

1. Open `src/flask/helpers.py` and select the `get_debug_flag` function.
2. Invoke `Forge: Inline Edit Selection` (`Ctrl+K Ctrl+I` on Windows/Linux, `Cmd+K Cmd+I` on macOS).
3. Enter the exact prompt:
   ```
   Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.
   ```
4. Continuous footage: keep camera on the editor while the request streams. Review the side-by-side diff. Demonstrate accepting and rejecting individual hunks, then confirm. Nothing is applied before confirmation.
5. Run the independent verification with `PYTHONPATH` pointing to Flask's `src`:
   - Windows PowerShell:
     ```powershell
     $env:PYTHONPATH="src"
     python <extension-repo>\scripts\verify-flask-demo.py A
     ```
   - macOS/Linux:
     ```bash
     PYTHONPATH=src python <extension-repo>/scripts/verify-flask-demo.py A
     ```
6. Demonstrate undo: run `Forge: Undo last applied change` from the Command Palette, or use VS Code undo.
7. **Reset between tasks**:
   ```bash
   git checkout .
   git clean -fd
   ```

## Task B — Agent mode (no files mentioned)

1. Open the chat panel (`Forge: Open Agent Panel`).
2. Enter the exact prompt:
   ```
   Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.
   ```
3. Expand **Context used**: show discovered file paths, code snippets, selection rationales, and the token budget. Point out the TrueForge session ID (`Session: <id>`) and open the TrueForge dashboard at `http://localhost:8790` to show the running session and turn history during Task B.
4. Review proposed changes across `src/flask/cli.py`, `tests/test_cli.py`, and `docs/cli.rst`. Accept desired hunks and confirm.
5. Approve the test execution command (`python -m pytest tests/test_cli.py -q`) when prompted.
6. Verify test results and CLI behavior:
   ```bash
   python -m pytest tests/test_cli.py -q
   python -m flask --help
   ```
   Run independent verification:
   - Windows PowerShell:
     ```powershell
     $env:PYTHONPATH="src"
     python <extension-repo>\scripts\verify-flask-demo.py B
     ```
   - macOS/Linux:
     ```bash
     PYTHONPATH=src python <extension-repo>/scripts/verify-flask-demo.py B
     ```
7. Verify modified files: `git diff --name-only` must show at least `src/flask/cli.py`, `tests/test_cli.py`, and `docs/cli.rst`.
8. **Reset between tasks**:
   ```bash
   git checkout .
   git clean -fd
   ```

## Task C — Resilience and failure handling

1. In TrueForge settings, make the primary provider unreachable (e.g. by setting an invalid API key for `forge-nvidia`) while keeping the fallback provider (`google-gemini`) valid.
2. Repeat the exact Task A inline-edit request above on the selected get_debug_flag function.
3. Observe initial retry notice with bounded backoff, followed by the takeover notice: `Primary model failed, using fallback`.
4. Observe the request completing through a fresh session on the fallback model.
5. Reject the proposed edits to ensure the checkout remains unmodified.
6. Check `git status --short`; verify the repository remains clean.
7. **Reset between tasks**:
   ```bash
   git checkout .
   git clean -fd
   ```

## Automated evidence (no keys)

Run the full local test suite:
```bash
npm run typecheck
npm test
npm run build
```

All 192 tests pass across 24 test files.
