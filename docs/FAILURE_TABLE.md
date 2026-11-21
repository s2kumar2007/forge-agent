# Failure Recovery & Provider Resilience Table

This document details how Forge Agent handles upstream model, provider, network, and token limit failures with automatic, safe fallbacks (specifically Task C).

---

## 1. Failure Recovery Matrix

| Failure Mode | Trigger / Error Signature | Agent Action | Workspace State | Fallback Provider | Circuit Breaker |
|---|---|---|---|---|---|
| **Invalid API Key / Unauthorized** | HTTP 401 / 403, `unauthorized`, `forbidden` | Immediate failover without retrying | Untouched (clean) | Google Gemini / Groq | Trips for 5 min |
| **Network Partition / Host Down** | `ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`, `fetch failed` | Immediate failover without retrying | Untouched (clean) | Google Gemini / Groq | Trips for 5 min |
| **Server Error** | HTTP 500, 502, 503, 504 | Immediate failover | Untouched (clean) | Google Gemini / Groq | Trips for 5 min |
| **Payload Too Large** | HTTP 413, `request entity too large` | Immediate failover with compact context | Untouched (clean) | Google Gemini / Groq | Trips for 5 min |
| **Iteration Limit** | `iteration limit of 60` | Stops cleanly; informs user to request again | Untouched (clean) | Does NOT fallback | Does NOT trip |
| **Mid-Turn Replay Guard** | Failure occurs after user approved a write/command | Refuses replay; informs user to undo or inspect | Prior approved ops kept | No automatic replay | Trips |
| **Compiler / Test Failure** | Linter error or test failure after edit | Automatic verify-and-repair loop (up to 2 rounds) | Reviewed changes kept | Same active agent | Does NOT trip |

---

## 2. Task C: Automatic Fallback Reproduction

Task C demonstrates that when the primary provider has an invalid key or becomes unreachable, Forge Agent automatically and seamlessly switches to the fallback provider without corrupting or leaving partial state in the workspace.

### Reproduction Steps

#### Option A: Using `forge.faultInjection` (Deterministic & Offline)
1. Open VS Code Settings (`Ctrl+,`).
2. Search for `forge.faultInjection`.
3. Set `forge.faultInjection` to `"auth"` (to simulate an HTTP 401 invalid key) or `"network"` (to simulate connection failure).
4. Send any request in Forge Agent (e.g., "Refactor helper flag").
5. **Observed Behavior**:
   - The primary agent fails immediately without redundant retries.
   - The circuit breaker trips for 5 minutes (`Primary unavailable, using fallback`).
   - A non-blocking notice is surfaced: `Primary model failed, using fallback: google-gemini/gemini-3-8-flash`.
   - The fallback agent answers in a new session.
   - Your workspace remains completely intact.
6. Reset `forge.faultInjection` to `"none"`.

#### Option B: Real TrueForge Key Failure
1. In TrueForge UI (`http://localhost:8790`), configure an invalid API key for the primary model provider (NVIDIA NIM).
2. Send a coding request in Forge Agent.
3. Observe that the primary provider returns 401/403, and Forge Agent immediately routes the request to Google Gemini (`google-gemini/gemini-3-8-flash`).
