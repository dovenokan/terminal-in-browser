// Local PTY bridge: WebSocket <-> shell. Localhost only, pinned extension origins + token.
// Protocol: text frames carry terminal data (both ways), binary frames carry JSON control messages.
//   client -> server: hello (must be first, within AUTH_MS), resize, ack
//   server -> client: ready, exit
// Sessions outlive their socket for GRACE_MS, so reloading the tab reattaches to the same shell.
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT || 7681);
const GRACE_MS = Number(process.env.PSTAB_GRACE_MS || 60000);
const SHELLS = {
  powershell: [process.env.SHELL_EXE || 'powershell.exe', ['-NoLogo']],
  pwsh: ['pwsh.exe', ['-NoLogo']],
  cmd: ['cmd.exe', []],
};
// Bundled OpenConsole (newer than the inbox conhost: faster, better VT support, clean kill). PSTAB_CONPTY_DLL=0 opts out.
// It's missing when npm skipped node-pty's install scripts; then we fall back to the inbox conhost.
let conptyDll = process.env.PSTAB_CONPTY_DLL !== '0';
function spawnPty(file, args, opts) {
  if (conptyDll) {
    try { return pty.spawn(file, args, { ...opts, useConptyDll: true }); } catch (e) {
      if (!/conpty\.dll/i.test(e.message)) throw e;
      conptyDll = false;
      console.error('Bundled conpty.dll not found, using the inbox console host');
    }
  }
  return pty.spawn(file, args, opts);
}
// Tells xterm.js how ConPTY reflows on resize (the bundled OpenConsole is always new enough; inbox depends on the OS build).
const ptyInfo = () => ({ backend: 'conpty', buildNumber: conptyDll ? 99999 : Number(os.release().split('.')[2]) || 0 });
const AUTH_MS = 5000;
const MAX_SESSIONS = 32;
const FLUSH_MS = 4;               // coalesce PTY output into fewer frames
const FLUSH_BYTES = 64 * 1024;
const HIGH = 512 * 1024, LOW = 128 * 1024;   // unacked output watermarks (flow control)
const DETACHED_MAX = 1024 * 1024;           // backlog kept while no tab is attached; the shell pauses beyond it

const root = path.join(__dirname, '..');
const tokenFile = path.join(__dirname, '.token');
let token;
try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch {}
if (!token) {
  token = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(tokenFile, token);
}
const tokenOk = (t) => {
  const given = Buffer.from(String(t || '')), want = Buffer.from(token);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
};

// Allowed origins: our pinned Chromium ID, plus any recorded by the native host (Firefox's per-install UUID) or PSTAB_ORIGINS.
const originsFile = path.join(__dirname, 'allowed-origins.txt');
let originsCache = { mtime: -1, set: new Set() };
function allowedOrigins() {
  let mtime = 0;
  try { mtime = fs.statSync(originsFile).mtimeMs; } catch {}
  if (mtime !== originsCache.mtime) {
    const list = (process.env.PSTAB_ORIGINS || '').split(',');
    try { list.push('chrome-extension://' + fs.readFileSync(path.join(root, 'extension-id.txt'), 'utf8').trim()); } catch {}
    try { list.push(...fs.readFileSync(originsFile, 'utf8').split(/\r?\n/)); } catch {}
    originsCache = { mtime, set: new Set(list.map((o) => o.trim().replace(/\/$/, '')).filter(Boolean)) };
  }
  return originsCache.set;
}
const hosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

const wss = new WebSocketServer({
  host: '127.0.0.1',
  port: PORT,
  maxPayload: 4 * 1024 * 1024,
  // Reject web pages, other extensions and DNS-rebinding hosts before the upgrade.
  verifyClient: ({ origin, req }) => allowedOrigins().has(origin) && hosts.has(req.headers.host),
});
wss.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use (bridge already running?)` : e);
  process.exit(e.code === 'EADDRINUSE' ? 0 : 1);
});

const sessions = new Map();
const sendCtl = (ws, msg) => ws.readyState === ws.OPEN && ws.send(Buffer.from(JSON.stringify(msg)), { binary: true });
const dim = (n, max) => { const v = Math.floor(Number(n)); return v >= 1 ? Math.min(max, v) : undefined; };

function flowControl(s) {
  const over = s.ws ? s.unacked > HIGH : s.backlogLen > DETACHED_MAX;
  const under = s.ws ? s.unacked < LOW : s.backlogLen <= DETACHED_MAX;
  if (!s.paused && over) { s.paused = true; s.pty.pause(); }
  else if (s.paused && under) { s.paused = false; s.pty.resume(); }
}

function flush(s) {
  clearTimeout(s.flushTimer); s.flushTimer = null;
  if (!s.out.length) return;
  const data = s.out.join(''); s.out = []; s.outLen = 0;
  if (s.ws && s.ws.readyState === s.ws.OPEN) { s.ws.send(data); s.unacked += data.length; }
  else { s.backlog.push(data); s.backlogLen += data.length; }
  flowControl(s);
}

function spawnSession(m) {
  const [file, args] = SHELLS[m.shell] || SHELLS.powershell;
  let cwd = process.env.USERPROFILE || process.cwd();
  try { if (m.cwd && fs.statSync(m.cwd).isDirectory()) cwd = m.cwd; } catch {}
  const s = {
    id: crypto.randomBytes(16).toString('hex'), shell: m.shell in SHELLS ? m.shell : 'powershell',
    ws: null, out: [], outLen: 0, flushTimer: null, backlog: [], backlogLen: 0, unacked: 0, paused: false, expire: null,
  };
  s.pty = spawnPty(file, args, {
    name: 'xterm-256color', cols: dim(m.cols, 1000) || 80, rows: dim(m.rows, 500) || 24, cwd,
    env: { ...process.env, COLORTERM: 'truecolor', TERM_PROGRAM: 'pstab' },
  });
  s.pty.onData((d) => {
    if (!s.ws) { s.backlog.push(d); s.backlogLen += d.length; flowControl(s); return; }
    s.out.push(d); s.outLen += d.length;
    if (s.outLen >= FLUSH_BYTES) flush(s);
    else if (!s.flushTimer) s.flushTimer = setTimeout(flush, FLUSH_MS, s);
  });
  s.pty.onExit(({ exitCode }) => {
    flush(s);
    clearTimeout(s.expire);
    sessions.delete(s.id);
    s.exited = true;
    if (s.ws) { sendCtl(s.ws, { t: 'exit', code: exitCode }); s.ws.close(1000, 'exited'); }
  });
  sessions.set(s.id, s);
  return s;
}

function attach(ws, m) {
  let s = sessions.get(m.session);
  const resumed = !!s;
  if (s) {
    if (s.ws) { const old = s.ws; detach(s, old); old.close(4409, 'attached elsewhere'); }
    clearTimeout(s.expire);
  } else {
    if (sessions.size >= MAX_SESSIONS) { ws.close(4429, 'too many sessions'); return null; }
    try { s = spawnSession(m); } catch (e) { ws.close(4500, String(e.message || e).replace(/[^ -~]/g, '?').slice(0, 120)); return null; }
  }
  s.ws = ws; s.unacked = 0;
  sendCtl(ws, { t: 'ready', session: s.id, shell: s.shell, resumed, pty: ptyInfo() });
  if (s.backlog.length) { const data = s.backlog.join(''); s.backlog = []; s.backlogLen = 0; ws.send(data); s.unacked = data.length; }
  if (resumed) resize(s, m);
  flowControl(s);
  return s;
}

function detach(s, ws) {
  if (s.ws !== ws) return;
  flush(s);
  s.ws = null; s.unacked = 0;
  flowControl(s);
  if (!s.exited) s.expire = setTimeout(() => { sessions.delete(s.id); try { s.pty.kill(); } catch {} }, GRACE_MS);
}

function resize(s, { cols, rows }) {
  cols = dim(cols, 1000); rows = dim(rows, 500);
  if (cols && rows && !s.exited) try { s.pty.resize(cols, rows); } catch {}
}

wss.on('connection', (ws) => {
  let s = null, authed = false;
  const authTimer = setTimeout(() => ws.close(4408, 'auth timeout'), AUTH_MS);
  ws.on('message', (data, isBinary) => {
    if (!authed) {
      clearTimeout(authTimer);
      let m = null;
      try { if (isBinary) m = JSON.parse(data); } catch {}
      if (!m || m.t !== 'hello' || !tokenOk(m.token)) { ws.close(4401, 'bad token'); return; }
      authed = true;
      s = attach(ws, m);
      return;
    }
    if (!s || s.ws !== ws || s.exited) return;
    if (!isBinary) { s.pty.write(data.toString()); return; }
    let m; try { m = JSON.parse(data); } catch { return; }
    if (m.t === 'resize') resize(s, m);
    else if (m.t === 'ack') { s.unacked = Math.max(0, s.unacked - (Number(m.n) || 0)); flowControl(s); }
  });
  ws.on('close', () => { clearTimeout(authTimer); if (s) detach(s, ws); });
});

console.log(`PowerShell bridge on ws://127.0.0.1:${PORT}`);
console.log(`Token (paste into the terminal tab once): ${token}`);
