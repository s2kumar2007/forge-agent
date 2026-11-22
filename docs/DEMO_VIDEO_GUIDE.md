Internal working notes, not part of the submission.

# Official Demo Video Recording Guide — Forge Agent

> **For the Video Creator / Team Member**  
> This document gives you the complete setup, step-by-step instructions, exact prompts, terminal commands, and camera rules needed to record the official **Techfest 2026-27 TrueFoundry Forge-a-thon** demo video.

---

## 1. Essential Competition Video Rules

Judges grade strictly against the official rubric. Keep these 5 rules in mind while recording:

1. **Maximum Duration**: Strictly **under 4 minutes** (≤ 240 seconds). Aim for ~3m 30s.
2. **Strict Presentation Order**:
   - **Task A**: Inline Edit (~1 min)
   - **Task B**: Agent Mode (~1 min 45s)
   - **Task C**: Model Resilience / Fallback (~50s)
3. **Continuous Footage**: **Do not jump-cut** between submitting an instruction and the diff review appearing. Let the viewer see the real-time response.
4. **TrueForge Visibility**: During **Task B**, briefly show the TrueForge Web Dashboard (`http://localhost:8790`) side-by-side or on screen to show the live session ID and turn stream.
5. **No Visible API Keys**: Never display API keys, `.env` files, or terminal commands containing secrets on camera.

---

## 2. Prerequisites & Setup (Before Recording)

### A. Tools Required
- **Node.js** v22.14 or newer (`node -v`)
- **VS Code** 1.90 or newer
- **Python** 3.10+ with `pip` and `venv`
- **Git**
- Screen recording software (e.g. OBS Studio, Windows Xbox Game Bar `Win+G`, or QuickTime)

### B. API Keys Needed
- **Google Gemini API Key** (Free tier from [Google AI Studio](https://aistudio.google.com/app/apikey))
- **NVIDIA NIM API Key** (Free tier from [NVIDIA Build](https://build.nvidia.com))

---

## 3. Step-by-Step Environment Setup

### Step 1: Clone and Build Forge Agent
Open a terminal and set up the extension repository:

```bash
git clone https://github.com/s2kumar2007/forge-agent.git
cd forge-agent
npm ci
npm run typecheck
npm test
npm run build
```
*(Verify that all 192 tests pass).*

---

### Step 2: Start TrueForge Daemon
Open a dedicated terminal window and run:

**Windows PowerShell:**
```powershell
$env:OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","integrate.api.nvidia.com"]'
npx @truefoundry/trueforge@0.182.0
```

**macOS / Linux:**
```bash
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","integrate.api.nvidia.com"]' npx @truefoundry/trueforge@0.182.0
```
*Leave this terminal running in the background. TrueForge will be available at `http://localhost:8790`.*

---

### Step 3: Configure Providers in TrueForge

1. **Configure Google Gemini (Fallback Provider)**:
   - Open browser: `http://localhost:8790`
   - Navigate to **Settings** → **Model Providers**.
   - Add/edit provider **`google-gemini`**, enter your Gemini API key, and ensure `gemini-3-8-flash` is enabled.

2. **Launch Extension Once**:
   - Press **F5** in VS Code to start the extension host once so it registers the `forge-editor` MCP server.

3. **Configure NVIDIA NIM (Primary & Inline Provider)**:
   - In a terminal in the `forge-agent` directory, run:
   
   **Windows PowerShell:**
   ```powershell
   $env:PROVIDER_BASE_URL="https://integrate.api.nvidia.com/v1"
   $env:PROVIDER_MODEL="nvidia/nemotron-3.5-lightning-30b-a3b"
   $env:PROVIDER_API_KEY="<your-nvidia-nim-api-key>"
   node scripts/configure-provider.cjs
   ```
   
   **macOS / Linux:**
   ```bash
   PROVIDER_BASE_URL="https://integrate.api.nvidia.com/v1" \
   PROVIDER_MODEL="nvidia/nemotron-3.5-lightning-30b-a3b" \
   PROVIDER_API_KEY="<your-nvidia-nim-api-key>" \
   node scripts/configure-provider.cjs
   ```
   *Expected output: `Registered provider forge-nvidia for model nvidia/nemotron-3.5-lightning-30b-a3b as forge-nvidia/nemotron-3-5-lightning-30b-a3b; updated agents: forge-agent, forge-inline.`*

4. **Reload Extension**:
   - Press `Ctrl+R` (or `Cmd+R`) in the extension host.

---

### Step 4: Clone & Prepare Flask 3.1.3 Target (CRITICAL)

In a separate directory (outside of `forge-agent`), clone the exact Flask commit:

```bash
git clone https://github.com/pallets/flask.git
cd flask
git checkout 22d924701a6ae2e4cd01e9a15bbaf3946094af65
python -m venv .venv
```

Activate the environment:
- **Windows PowerShell:** `.venv\Scripts\Activate.ps1`
- **macOS / Linux:** `source .venv/bin/activate`

Install dependencies:
```bash
pip install -e . "pytest<9" python-dotenv asgiref
```

> [!IMPORTANT]
> **CRITICAL WORKSPACE RULE**: When you open VS Code for the demo, you MUST open the **`flask` repository folder directly as the root folder** (where `src/` and `tests/` are at top level). Do **NOT** open a parent directory containing `flask/`.

---

### Step 5: Launch Extension Host
1. Open the `forge-agent` folder in VS Code.
2. Press `F5` (or run `code --extensionDevelopmentPath=<path-to-forge-agent> <path-to-flask>`).
3. In the new VS Code window that opens, open the **`flask`** checkout.

---

## 4. Video Recording Script (Action-by-Action)

### 🎬 TASK A: Inline Edit Selection (~1:00 min)

1. **Open File**:
   - In the Flask project, open `src/flask/helpers.py`.
   - Scroll down and **highlight/select the entire `get_debug_flag` function** (approx lines 23–45).

2. **Trigger Inline Edit**:
   - Press `Ctrl+K Ctrl+I` (Windows/Linux) or `Cmd+K Cmd+I` (macOS).
   - An inline input box will appear above the selection.

3. **Paste Exact Prompt**:
   ```text
   Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.
   ```
   - Press `Enter`.

4. **Demonstrate on Screen**:
   - Keep camera on editor while the response streams.
   - The side-by-side interactive diff review panel opens.
   - Point cursor to individual hunks: demonstrate accepting or rejecting individual hunks.
   - Click **Confirm / Apply**.

5. **Terminal Verification**:
   - Open the integrated terminal in Flask and run:
     - **Windows PowerShell:**
       ```powershell
       $env:PYTHONPATH="src"
       python <path-to-forge-agent>\scripts\verify-flask-demo.py A
       ```
     - **macOS / Linux:**
       ```bash
       PYTHONPATH=src python <path-to-forge-agent>/scripts/verify-flask-demo.py A
       ```
     *(Show the test passing: `OK: Task A verification passed`)*.

6. **Demonstrate Undo**:
   - Press `Ctrl+Shift+P` → run **`Forge: Undo last applied change`**.
   - Show the file revert back to its original state.

7. **Reset Workspace for Task B**:
   ```bash
   git checkout .
   git clean -fd
   ```

---

### 🎬 TASK B: Agent Mode (No File Hints) (~1:45 min)

1. **Open Chat Panel**:
   - Press `Ctrl+Shift+P` → run **`Forge: Open Agent Panel`** (panel opens in sidebar).

2. **Paste Exact Prompt (Filename-Free)**:
   ```text
   Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.
   ```
   - Press `Enter`.

3. **Demonstrate Context & TrueForge Visibility (CRITICAL)**:
   - In the chat panel, expand the **Context used** collapsible block:
     - Point out: discovered files, selection reasons, and token budget (`Context: ... estimated tokens`).
     - Point out: the **TrueForge Session ID** (e.g. `Session: 01m...`).
   - Switch briefly to browser window with `http://localhost:8790` to show the running session and live turns.

4. **Review Proposed Diffs**:
   - The extension opens interactive diff reviews across 3 discovered files:
     1. `src/flask/cli.py`
     2. `tests/test_cli.py`
     3. `docs/cli.rst`
   - Accept the hunks and click **Confirm**.

5. **Approve Test Command**:
   - An approval box appears asking to run `python -m pytest tests/test_cli.py -q`.
   - Click **Approve**.
   - Show the tests passing inside the panel.

6. **Independent Terminal Verification**:
   - In terminal, run:
     ```bash
     python -m pytest tests/test_cli.py -q
     python -m flask --help
     ```
   - Run verification script:
     - **Windows:**
       ```powershell
       $env:PYTHONPATH="src"
       python <path-to-forge-agent>\scripts\verify-flask-demo.py B
       ```
     - **macOS / Linux:**
       ```bash
       PYTHONPATH=src python <path-to-forge-agent>/scripts/verify-flask-demo.py B
       ```
     *(Show `OK: Task B verification passed`)*.

7. **Reset Workspace for Task C**:
   ```bash
   git checkout .
   git clean -fd
   ```

---

### 🎬 TASK C: Resilience & Model Fallback (~50 sec)

1. **Simulate Primary Provider Failure**:
   - In browser at `http://localhost:8790` (TrueForge Settings → Model Providers → `forge-nvidia`):
   - Temporarily change the NVIDIA NIM API key to an invalid string like `invalid-test-key` and save. *(Keep `google-gemini` valid).*

2. **Trigger Exact Task A Request**:
   - In `src/flask/helpers.py`, select the `get_debug_flag` function again.
   - Press `Ctrl+K Ctrl+I` and paste the exact Task A prompt:
     ```text
     Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.
     ```
   - Press `Enter`.

3. **Observe Failover on Screen**:
   - Show the notification: bounded backoff retry notice.
   - Show the failover takeover notice:
     `Primary model failed, using fallback`
   - Show the request completes smoothly in a fresh session using the Google Gemini fallback model (`gemini-3-8-flash`).

4. **Reject and Prove Clean Workspace**:
   - In the diff review, click **Reject / Close** (do not apply).
   - In terminal, run:
     ```bash
     git status --short
     ```
   - Point out that the output is completely empty — proving clean workspace preservation.

---

## 5. Final Quality Checklist Before Submitting

- [ ] Video duration is **under 4 minutes** (≤ 240 seconds).
- [ ] Tasks are shown in exact order: **A → B → C**.
- [ ] No cuts between prompt submission and review streaming.
- [ ] TrueForge session ID and turn events are clearly visible during Task B.
- [ ] No API keys or secrets were exposed on camera.
- [ ] Audio/voiceover or captions clearly explain what is happening at each step.
- [ ] Upload video (unlisted or public on YouTube/Google Drive) and paste link into `README.md` (`[TODO: video link]`).
