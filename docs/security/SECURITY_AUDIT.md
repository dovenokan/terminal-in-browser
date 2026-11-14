# Security Audit & Remediation Report — Terminal in Browser

**Repository:** `terminal-in-browser` (`pstab-bridge` v1.1.0 / extension v1.2.0)  
**Audit Scope:** Full execution path (`Browser -> Extension -> WebSocket -> Node.js -> node-pty -> Windows Shell` and `Extension -> Native Messaging -> Windows Host -> Bridge/Tray`)  
**Date:** 2026-11-14

---

## Executive Summary

A comprehensive security audit of `server/`, `host/`, `extension/`, and root launcher scripts identified **11 confirmed security vulnerabilities** (1 Critical, 6 High, 3 Medium, 1 Low). All 11 vulnerabilities have been remediated in source code, dependencies have been updated to eliminate known CVEs, and an automated security test suite has been added under `tests/security.test.js`.

| ID | Title | Severity | Status |
|---|---|---|---|
| V-01 | Missing caller validation in Native Messaging host | Critical | Fixed |
| V-02 | Token exposure in URL fragment, process command line, and logs | High | Fixed |
| V-03 | Unhandled `null`/non-object WebSocket control frames crash server & negative `ack` freeze | High | Fixed |
| V-04 | Unbounded Native Messaging frame length, unhandled JSON parse, and async race | High | Fixed |
| V-05 | Static non-expiring token, missing auth rate limiting, and unauthenticated connection DoS | High | Fixed |
| V-06 | Missing session-to-origin binding and `session`/`cwd` input validation | High | Fixed |
| V-07 | Vulnerable `dompurify` (<=3.4.16) and `katex` (<0.18.2) dependencies | High | Fixed |
| V-08 | Unqualified shell executable names (`powershell.exe`, `pwsh.exe`, `cmd.exe`) and orphaned PTYs | Medium | Fixed |
| V-09 | Persistent token storage in `chrome.storage.local` | Medium | Fixed |
| V-10 | CSS injection via `style.cssText` in `options.js` & unhardened `render.js` / `WebLinksAddon` | Medium | Fixed |
| V-11 | Unvalidated extension ID in `install.ps1` & indiscriminate `Server-Pid` kill in `tray.ps1` | Low | Fixed |

---

## Detailed Findings & Remediations

### V-01: Missing Caller Validation in Native Messaging Host (Critical)
- **Affected Files:** `host/host.js`
- **Root Cause:** `host.js` only checked `process.argv.slice(2)` inside `allowOrigin()`, and never verified Chromium's `chrome-extension://<id>/` argument against `extension-id.txt`. Any local process invoking `host.bat` (even with no arguments) could send `{"cmd":"start"}` to launch the bridge and receive the authentication token in stdout.
- **Attack Scenario:** A low-privilege local process or another application invokes `host/host.bat` directly over stdio, sends `{"cmd":"start"}`, receives `.token`, and connects to `ws://127.0.0.1:7681` (or spoofs a `chrome-extension://` argument to add an arbitrary origin to `allowed-origins.txt`).
- **Fix Implemented:** Added `readPinnedChromeId()`, `getCallerType()`, and `isAuthorizedCaller()` in `host/host.js`. The host now validates `process.argv.slice(2)` against the pinned Chromium extension ID in `extension-id.txt` (matching `^[a-p]{32}$`) or `FIREFOX_ID` (`pstab@pstab.local`) at startup and before handling any command, exiting immediately on unauthorized callers.

### V-02: Token Exposure in URL Fragment, Process Command Line, and Logs (High)
- **Affected Files:** `tray.ps1`, `server/server.js`, `extension/terminal.js`
- **Root Cause:**
  1. `tray.ps1` launched the browser with `chrome-extension://$extId/terminal.html#$(Token)`, exposing the raw token in the browser process `CommandLine` and browser history.
  2. `server/server.js` printed the raw token to stdout (`console.log('Token ...: ' + token)`), persisting it in log files (`srv.log`).
- **Attack Scenario:** Any local process or monitoring tool inspecting process command lines (`Win32_Process`) or reading `srv.log` obtains the plaintext bridge token.
- **Fix Implemented:** Removed `#$(Token)` from `tray.ps1` `Open-Term` and removed `tokenFromHash` ingestion from `extension/terminal.js`. Updated `server/server.js` to log only the `.token` file path rather than the secret value.

### V-03: Unhandled `null`/Non-Object Control Frames & Negative `ack` DoS (High)
- **Affected Files:** `server/server.js`
- **Root Cause:** After authentication, `server.js` parsed binary frames with `JSON.parse(data)` and immediately accessed `m.t`. Sending binary `null`, `123`, or `true` threw an unhandled `TypeError`, crashing the entire Node.js bridge. Additionally, `m.t === 'ack'` accepted negative `m.n` values, inflating `s.unacked` above `HIGH` and permanently pausing PTY output, and `ws` sockets lacked an `'error'` listener (allowing oversized frames to emit unhandled `'error'` events).
- **Attack Scenario:** An authenticated tab or script sends a 4-byte binary frame `null`, terminating the bridge and killing all active terminal sessions.
- **Fix Implemented:** Added `isPlainObject()` checks on all JSON control frames, strict validation of `m.t` (`resize`, `ack`) and positive bounded `m.n` (`0 < n <= 10 MiB`), `MAX_INPUT_BYTES` (64 KiB) cap on `pty.write()`, `MAX_PAYLOAD_BYTES` reduced from 4 MiB to 512 KiB, and `ws.on('error', ...)` termination handling.

### V-04: Unbounded Native Messaging Buffer, Unhandled JSON Parse, and Async Race (High)
- **Affected Files:** `host/host.js`
- **Root Cause:** `host.js` read `UInt32LE` frame lengths without an upper bound (up to 4 GiB), called `JSON.parse()` without `try/catch`, and mutated `buf` inside an `async` `stdin` `data` handler.
- **Attack Scenario:** Sending a malformed length header (e.g. `0xFFFFFFFF` or `0x00000000`) or invalid JSON crashes `host.js` or triggers excessive memory allocation.
- **Fix Implemented:** Implemented `createMessageProcessor()` with `MAX_MSG_BYTES` (64 KiB) enforcement, zero-length rejection, `try/catch` JSON parsing, plain-object and `cmd` allowlist validation (`start`, `shells`), and sequential promise-queued message handling.

### V-05: Static Token, Missing Auth Rate Limiting, and Unauthenticated Connection DoS (High)
- **Affected Files:** `server/server.js`
- **Root Cause:** `.token` was generated once (192-bit) and never rotated or expired. Failed auth attempts had no rate limiting, `ws.close(4401)` did not force-terminate unresponsive sockets, and unlimited unauthenticated WebSocket connections were accepted.
- **Attack Scenario:** A malicious local client opens hundreds of unauthenticated connections or brute-forces tokens without throttling.
- **Fix Implemented:** Upgraded token size to 256-bit (`crypto.randomBytes(32)`), added token rotation on startup (`PSTAB_ROTATE_ON_START !== '0'`) and TTL expiration (`PSTAB_TOKEN_TTL_MS`, default 24h) with `0o600` file mode, added `MAX_UNAUTHED_CONNS` (16), failed-auth lockout (`MAX_AUTH_FAILURES = 5`, `AUTH_LOCKOUT_MS = 10s`), and `forceClose()` with `ws.terminate()` fallback.

### V-06: Missing Session-to-Origin Binding & Input Validation (High)
- **Affected Files:** `server/server.js`, `extension/terminal.js`
- **Root Cause:** `attach()` did not bind sessions to the creating `origin` and did not validate `m.session` format or `m.cwd` for null bytes/type.
- **Attack Scenario:** A different allowed origin (e.g. Firefox vs Chrome) with a known session ID could hijack an active terminal session.
- **Fix Implemented:** Bound each session to `s.origin`, enforced `SESSION_ID_RE` (`^[0-9a-f]{32}$`), rejected cross-origin reattachment with `4403`, and added `validateCwd()` (type, length, and null-byte checks).

### V-07: Vulnerable Third-Party Dependencies (High)
- **Affected Files:** `server/package.json`, `server/package-lock.json`, `extension/vendor/*`
- **Root Cause:** `dompurify` (`3.2.6`) had multiple known XSS/mXSS/prototype-pollution advisories (`<=3.4.16`), and `katex` (`0.16.22`) had a low-severity trust-bypass advisory (`<0.18.2`).
- **Fix Implemented:** Upgraded `dompurify` and `katex` to latest patched versions and re-ran `npm --prefix server run vendor` to update `extension/vendor/`. `npm audit` now reports `0 vulnerabilities`.

### V-08: Relative Shell Executables & Orphaned PTY Processes (Medium)
- **Affected Files:** `server/server.js`
- **Root Cause:** `SHELLS` used unqualified `'powershell.exe'`, `'pwsh.exe'`, `'cmd.exe'` (susceptible to `cwd`/`PATH` search-order hijacking), and `server.js` had no `SIGINT`/`SIGTERM` cleanup to kill active PTYs.
- **Fix Implemented:** Added `getShellSpec()` resolving `powershell.exe` and `cmd.exe` via `%SystemRoot%\System32\...` and `pwsh.exe` via `ProgramFiles` or absolute `PATH` entries only. Added `bridge.close()` and `SIGINT`/`SIGTERM` handlers to terminate all active PTYs cleanly.

### V-09: Persistent Token Storage in `chrome.storage.local` (Medium)
- **Affected Files:** `extension/terminal.js`
- **Root Cause:** The bridge token was persisted unencrypted on disk in `api.storage.local`.
- **Fix Implemented:** Switched token storage to `api.storage.session` (in-memory per browser session) with `memToken` fallback, and actively removed any legacy `token` key from `api.storage.local`.

### V-10: CSS Injection in `options.js` & Unhardened `render.js` / `WebLinksAddon` (Medium)
- **Affected Files:** `extension/options.js`, `extension/render.js`, `extension/terminal.js`
- **Root Cause:** `options.js` interpolated `s.fontFamily` into `sample.style.cssText`. `render.js` did not explicitly set `trust: false` on KaTeX or `FORBID_TAGS` on DOMPurify. `WebLinksAddon` did not validate `^https?:\/\/` before `window.open`.
- **Fix Implemented:** Replaced `cssText` with individual DOM style properties, added `trust: false` and `FORBID_TAGS` in `render.js`, and enforced `^https?:\/\/` in `WebLinksAddon`.

### V-11: Unvalidated Extension ID in `install.ps1` & Indiscriminate `Server-Pid` Kill (Low)
- **Affected Files:** `host/install.ps1`, `tray.ps1`
- **Root Cause:** `install.ps1` did not validate `extension-id.txt` format; `tray.ps1` killed any process listening on port 7681 on `Quit`.
- **Fix Implemented:** Added `^[a-p]{32}$` validation in `install.ps1` and verified `ProcessName -eq 'node'` in `tray.ps1` `Server-Pid`.

---

## Remaining Risks & Operational Assumptions

1. **Same-User Trust Boundary:** The bridge runs under the current Windows user account and stores `.token` in `server/.token`. Any process running as the same Windows user with filesystem read access to `server/.token` can read the token.
2. **Localhost Unencrypted Transport (`ws://`):** Communication between the extension and `127.0.0.1:7681` uses unencrypted WebSocket (`ws://`) on loopback. This is standard for local browser-to-daemon bridges on Windows, as loopback traffic does not leave the host, though local packet capture with admin privileges could observe it.
3. **UNC Paths in `cwd`:** By design (documented in `README.md`), clicking the extension on a `file://server/share/` tab passes that path as `cwd` to `fs.statSync(rawCwd)`, which initiates an SMB connection if the user explicitly triggers the extension on such a tab.
4. **Manual Browser Extension Reload:** After updating `extension/` and `host/host.js`, the unpacked extension must be reloaded in the browser and `host/install.ps1` re-run if not already registered.
