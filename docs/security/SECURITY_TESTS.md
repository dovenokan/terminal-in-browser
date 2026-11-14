# Security Test Suite & Verification — Terminal in Browser

**Test File:** `tests/security.test.js`  
**Test Runner:** Node.js built-in test runner (`node:test`)  
**Node.js Version Tested:** `v26.8.2`

---

## How to Run

From the repository root:

```powershell
npm --prefix server test
```

Or directly:

```powershell
node --test tests/security.test.js
```

To run dependency and syntax checks:

```powershell
npm --prefix server audit
node --check server/server.js
node --check host/host.js
node --check extension/terminal.js
node --check extension/options.js
node --check extension/render.js
```

---

## Test Cases

All tests use isolated temporary directories, ephemeral loopback ports (`port: 0`), and a mock PTY spawner (`createMockPtyFactory`) so no destructive shell commands are ever executed.

| # | Test Case | Security Property Verified |
|---|---|---|
| 1 | `WebSocket binds exclusively to 127.0.0.1` | Server `address()` is strictly `127.0.0.1` (no `0.0.0.0` or external interface binding). |
| 2 | `Rejects missing, malformed, and unauthorized Origin and Host headers` | Rejects missing `Origin`, `https://evil.example`, unknown `chrome-extension://` IDs, malformed origins, and DNS-rebinding `Host` headers with HTTP `401` before WebSocket upgrade; `spawnPty` is never called. |
| 3 | `Rejects invalid authentication tokens and prevents shell execution` | Bad token in `hello` closes socket with `4401`; subsequent text frames (`echo PWNED`) do not spawn a PTY or execute commands. |
| 4 | `Enforces auth timeout for silent unauthenticated connections` | Silent unauthenticated sockets are closed with `4408` after `authMs`. |
| 5 | `Rate-limits repeated authentication failures` | 5 consecutive failed auth attempts trigger temporary lockout (`4429`), blocking even valid tokens during the lockout window. |
| 6 | `Token rotation and expiration invalidate old tokens` | Expired tokens are rejected with `4401`, a fresh 256-bit hex token is rotated automatically, and the new token succeeds. |
| 7 | `Rejects malformed WebSocket control payloads without crashing server` | Binary `null` frame and negative `ack` (`n: -500`) are rejected with `1008` without crashing the server or freezing flow control. |
| 8 | `Rejects oversized WebSocket messages and oversized input frames` | Input frames `> 64 KiB` (`MAX_INPUT_BYTES`) and payloads `> 512 KiB` (`MAX_PAYLOAD_BYTES`) are rejected (`1009`/`1006`) without reaching `pty.write()`. |
| 9 | `Enforces session isolation across origins and handles disconnect/reconnect + process cleanup` | Another allowed origin (`moz-extension://...`) cannot attach to a `chrome-extension://` session (`4403`); same origin reconnects cleanly (`resumed: true`); expired grace period kills the PTY (`killed: true`) and clears `sessions`. |
| 10 | `Shell executable resolution uses absolute paths and validateCwd rejects null bytes` | `powershell.exe` and `cmd.exe` resolve to absolute `System32` paths; `validateCwd` rejects null bytes and non-string inputs. |
| 11 | `Native Messaging host rejects unauthorized callers and enforces size/JSON limits` | Rejects empty/unknown callers, blocks unauthorized `allowOriginForCaller`, rejects zero-length and `> 64 KiB` frames, handles malformed JSON safely, and rejects unknown commands. |

---

## Observed Verification Results

Executed on `2026-11-14`:

- `npm --prefix server test`: **11/11 passed, 0 failed** (duration: ~992 ms).
- `npm --prefix server audit`: **0 vulnerabilities** (0 critical, 0 high, 0 moderate, 0 low).
- `node --check` on `server/server.js`, `host/host.js`, `extension/terminal.js`, `extension/options.js`, `extension/render.js`, `extension/background.js`, `extension/settings.js`: **All exited with code 0**.
