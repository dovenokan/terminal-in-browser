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
const { execFile } = require('child_process');

const DEFAULT_PORT = Number(process.env.PORT || 7681);
const DEFAULT_GRACE_MS = Number(process.env.PSTAB_GRACE_MS || 60000);
const DEFAULT_TOKEN_TTL_MS = Number(process.env.PSTAB_TOKEN_TTL_MS || 24 * 60 * 60 * 1000);
const AUTH_MS = 5000;
const MAX_SESSIONS = 32;
const MAX_UNAUTHED_CONNS = 16;
const MAX_AUTH_FAILURES = 5;
const AUTH_LOCKOUT_MS = 10000;
const MAX_PAYLOAD_BYTES = 512 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_ACK_BYTES = 10 * 1024 * 1024;
const FLUSH_MS = 4;               // coalesce PTY output into fewer frames
const FLUSH_BYTES = 64 * 1024;
const HIGH = 512 * 1024, LOW = 128 * 1024;   // unacked output watermarks (flow control)
const DETACHED_MAX = 1024 * 1024;           // backlog kept while no tab is attached; the shell pauses beyond it

const CHROME_ORIGIN_RE = /^chrome-extension:\/\/[a-p]{32}$/;
const MOZ_ORIGIN_RE = /^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_ID_RE = /^[0-9a-f]{32}$/;

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isAllowedOriginFormat(origin) {
  return CHROME_ORIGIN_RE.test(origin) || MOZ_ORIGIN_RE.test(origin);
}

function resolveWindowsSystemExe(subpath) {
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  return path.join(sysRoot, 'System32', subpath);
}

function resolvePwshExe() {
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'PowerShell', '7', 'pwsh.exe'),
  ];
  for (const dir of (process.env.PATH || '').split(';')) {
    const trimmed = dir.trim();
    if (!trimmed || !path.isAbsolute(trimmed)) continue;
    candidates.push(path.join(trimmed, 'pwsh.exe'));
  }
  for (const p of candidates) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

function getShellSpec(name) {
  if (name === 'pwsh') {
    const pwsh = resolvePwshExe();
    if (!pwsh) throw new Error('PowerShell 7 (pwsh.exe) not found');
    return [pwsh, ['-NoLogo']];
  }
  if (name === 'cmd') {
    return [resolveWindowsSystemExe('cmd.exe'), []];
  }
  return [resolveWindowsSystemExe(path.join('WindowsPowerShell', 'v1.0', 'powershell.exe')), ['-NoLogo']];
}

function validateCwd(rawCwd) {
  const fallback = process.env.USERPROFILE || process.cwd();
  if (typeof rawCwd !== 'string' || !rawCwd || rawCwd.length > 32767 || rawCwd.includes('\0')) {
    return fallback;
  }
  if (process.env.PSTAB_ALLOW_UNC !== '1' && (/^\\\\/.test(rawCwd) || /^\/\//.test(rawCwd))) {
    return fallback;
  }
  try {
    if (fs.statSync(rawCwd).isDirectory()) return rawCwd;
  } catch {}
  return fallback;
}

function createBridge(opts = {}) {
  const port = opts.port !== undefined ? opts.port : DEFAULT_PORT;
  const graceMs = opts.graceMs !== undefined ? opts.graceMs : DEFAULT_GRACE_MS;
  const authMs = opts.authMs !== undefined ? opts.authMs : AUTH_MS;
  const tokenTtlMs = opts.tokenTtlMs !== undefined ? opts.tokenTtlMs : DEFAULT_TOKEN_TTL_MS;
  const authLockoutMs = opts.authLockoutMs !== undefined ? opts.authLockoutMs : AUTH_LOCKOUT_MS;
  const rotateOnStart = opts.rotateOnStart !== undefined ? opts.rotateOnStart : process.env.PSTAB_ROTATE_ON_START !== '0';

  const root = opts.root || path.join(__dirname, '..');
  const tokenFile = opts.tokenFile || path.join(__dirname, '.token');
  const originsFile = opts.originsFile || path.join(__dirname, 'allowed-origins.txt');
  const extIdFile = opts.extIdFile || path.join(root, 'extension-id.txt');
  const extraOrigins = Array.isArray(opts.extraOrigins) ? opts.extraOrigins : [];

  // Bundled OpenConsole (newer than the inbox conhost: faster, better VT support, clean kill). PSTAB_CONPTY_DLL=0 opts out.
  let conptyDll = process.env.PSTAB_CONPTY_DLL !== '0';
  const defaultSpawnPty = (file, args, spawnOpts) => {
    if (conptyDll) {
      try { return pty.spawn(file, args, { ...spawnOpts, useConptyDll: true }); } catch (e) {
        if (!/conpty\.dll/i.test(e.message)) throw e;
        conptyDll = false;
        console.error('Bundled conpty.dll not found, using the inbox console host');
      }
    }
    return pty.spawn(file, args, spawnOpts);
  };
  const spawnPty = opts.spawnPty || defaultSpawnPty;
  const ptyInfo = () => ({ backend: 'conpty', buildNumber: conptyDll ? 99999 : Number(os.release().split('.')[2]) || 0 });

  let token = '';
  let tokenExpiresAt = 0;

  function writeToken(newToken) {
    token = newToken;
    tokenExpiresAt = Date.now() + tokenTtlMs;
    fs.writeFileSync(tokenFile, token, { encoding: 'utf8', mode: 0o600 });
    if (process.platform === 'win32') {
      const user = os.userInfo().username;
      const icacls = resolveWindowsSystemExe('icacls.exe');
      execFile(icacls, [tokenFile, '/inheritance:r', '/grant:r', `${user}:(R,W)`], { windowsHide: true }, () => {});
    }
  }

  function loadOrRotateToken(forceRotate = false) {
    if (!forceRotate) {
      try {
        const st = fs.statSync(tokenFile);
        const existing = fs.readFileSync(tokenFile, 'utf8').trim();
        if (existing && /^[0-9a-f]{48,128}$/i.test(existing) && (Date.now() - st.mtimeMs) < tokenTtlMs) {
          token = existing;
          tokenExpiresAt = st.mtimeMs + tokenTtlMs;
          return token;
        }
      } catch {}
    }
    const fresh = crypto.randomBytes(32).toString('hex');
    writeToken(fresh);
    return token;
  }

  loadOrRotateToken(rotateOnStart);

  function rotateToken() {
    return loadOrRotateToken(true);
  }

  function tokenOk(t) {
    if (typeof t !== 'string' || !t) return false;
    if (Date.now() >= tokenExpiresAt) {
      rotateToken();
    }
    const given = Buffer.from(t, 'utf8');
    const want = Buffer.from(token, 'utf8');
    return given.length === want.length && crypto.timingSafeEqual(given, want);
  }

  let originsCache = { mtime: -1, set: new Set() };
  function allowedOrigins() {
    let mtime = 0;
    try { mtime = fs.statSync(originsFile).mtimeMs; } catch {}
    if (mtime !== originsCache.mtime) {
      const list = [...extraOrigins, ...(process.env.PSTAB_ORIGINS || '').split(',')];
      try {
        const id = fs.readFileSync(extIdFile, 'utf8').trim();
        if (/^[a-p]{32}$/.test(id)) list.push('chrome-extension://' + id);
      } catch {}
      try { list.push(...fs.readFileSync(originsFile, 'utf8').split(/\r?\n/)); } catch {}
      const normalized = new Set();
      for (const raw of list) {
        const o = raw.trim().replace(/\/$/, '');
        if (o && (isAllowedOriginFormat(o) || extraOrigins.includes(o))) {
          normalized.add(o);
        }
      }
      originsCache = { mtime, set: normalized };
    }
    return originsCache.set;
  }

  function isHostAllowed(hostHeader, boundPort) {
    if (typeof hostHeader !== 'string') return false;
    return hostHeader === `127.0.0.1:${boundPort}` || hostHeader === `localhost:${boundPort}`;
  }

  const sessions = new Map();
  let unauthedConns = 0;
  let authFailures = 0;
  let authBlockedUntil = 0;

  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port,
    maxPayload: MAX_PAYLOAD_BYTES,
    verifyClient: ({ origin, req }) => {
      if (!req || req.method !== 'GET') return false;
      if (typeof origin !== 'string' || !origin) return false;
      const cleanOrigin = origin.trim().replace(/\/$/, '');
      const addr = wss.address();
      const actualPort = addr && typeof addr === 'object' ? addr.port : port;
      return allowedOrigins().has(cleanOrigin) && isHostAllowed(req.headers.host, actualPort);
    },
  });

  const sendCtl = (ws, msg) => ws.readyState === ws.OPEN && ws.send(Buffer.from(JSON.stringify(msg)), { binary: true });
  const dim = (n, max) => {
    if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
    const v = Math.floor(n);
    return v >= 1 ? Math.min(max, v) : undefined;
  };

  function forceClose(ws, code, reason) {
    try { ws.close(code, reason); } catch {}
    const t = setTimeout(() => { try { ws.terminate(); } catch {} }, 250);
    if (t.unref) t.unref();
  }

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
    else if (s.backlogLen + data.length <= DETACHED_MAX * 2) {
      s.backlog.push(data); s.backlogLen += data.length;
    }
    flowControl(s);
  }

  function spawnSession(m, origin) {
    const shellName = typeof m.shell === 'string' && (m.shell === 'powershell' || m.shell === 'pwsh' || m.shell === 'cmd')
      ? m.shell : 'powershell';
    const [file, args] = getShellSpec(shellName);
    const cwd = validateCwd(m.cwd);
    const s = {
      id: crypto.randomBytes(16).toString('hex'),
      origin,
      shell: shellName,
      ws: null, out: [], outLen: 0, flushTimer: null, backlog: [], backlogLen: 0, unacked: 0, paused: false, expire: null,
      exited: false,
    };
    s.pty = spawnPty(file, args, {
      name: 'xterm-256color', cols: dim(m.cols, 1000) || 80, rows: dim(m.rows, 500) || 24, cwd,
      env: { ...process.env, COLORTERM: 'truecolor', TERM_PROGRAM: 'pstab' },
    });
    s.pty.onData((d) => {
      if (!s.ws) {
        if (s.backlogLen + d.length <= DETACHED_MAX * 2) {
          s.backlog.push(d); s.backlogLen += d.length;
        }
        flowControl(s);
        return;
      }
      s.out.push(d); s.outLen += d.length;
      if (s.outLen >= FLUSH_BYTES) flush(s);
      else if (!s.flushTimer) s.flushTimer = setTimeout(flush, FLUSH_MS, s);
    });
    s.pty.onExit(({ exitCode }) => {
      flush(s);
      clearTimeout(s.expire);
      sessions.delete(s.id);
      s.exited = true;
      if (s.ws) { sendCtl(s.ws, { t: 'exit', code: exitCode }); forceClose(s.ws, 1000, 'exited'); }
    });
    sessions.set(s.id, s);
    return s;
  }

  function attach(ws, m, origin) {
    let s = null;
    if (m.session !== undefined && m.session !== null) {
      if (typeof m.session !== 'string' || !SESSION_ID_RE.test(m.session)) {
        forceClose(ws, 1008, 'invalid session id');
        return null;
      }
      s = sessions.get(m.session);
      if (s && s.origin !== origin) {
        forceClose(ws, 4403, 'session origin mismatch');
        return null;
      }
    }
    const resumed = !!s;
    if (s) {
      if (s.ws) { const old = s.ws; detach(s, old); forceClose(old, 4409, 'attached elsewhere'); }
      clearTimeout(s.expire);
    } else {
      if (sessions.size >= MAX_SESSIONS) { forceClose(ws, 4429, 'too many sessions'); return null; }
      try { s = spawnSession(m, origin); } catch (e) {
        forceClose(ws, 4500, String(e.message || e).replace(/[^ -~]/g, '?').slice(0, 120));
        return null;
      }
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
    if (!s.exited) s.expire = setTimeout(() => { sessions.delete(s.id); try { s.pty.kill(); } catch {} }, graceMs);
  }

  function resize(s, { cols, rows }) {
    cols = dim(cols, 1000); rows = dim(rows, 500);
    if (cols && rows && !s.exited) try { s.pty.resize(cols, rows); } catch {}
  }

  wss.on('connection', (ws, req) => {
    if (unauthedConns >= MAX_UNAUTHED_CONNS) {
      forceClose(ws, 4429, 'too many pending connections');
      return;
    }
    unauthedConns++;
    let countedUnauthed = true;
    const decUnauthed = () => { if (countedUnauthed) { countedUnauthed = false; unauthedConns = Math.max(0, unauthedConns - 1); } };

    const origin = String(req.headers.origin || '').trim().replace(/\/$/, '');
    let s = null, authed = false, rejected = false;
    const authTimer = setTimeout(() => {
      rejected = true;
      decUnauthed();
      forceClose(ws, 4408, 'auth timeout');
    }, authMs);

    ws.on('message', (data, isBinary) => {
      if (rejected) return;
      if (!authed) {
        clearTimeout(authTimer);
        decUnauthed();
        if (Date.now() < authBlockedUntil) {
          rejected = true;
          forceClose(ws, 4429, 'too many auth failures');
          return;
        }
        let m = null;
        try { if (isBinary) m = JSON.parse(data); } catch {}
        if (!isPlainObject(m) || m.t !== 'hello' || !tokenOk(m.token)) {
          rejected = true;
          authFailures++;
          if (authFailures >= MAX_AUTH_FAILURES) {
            authBlockedUntil = Date.now() + authLockoutMs;
          }
          forceClose(ws, 4401, 'bad token');
          return;
        }
        authFailures = 0;
        authBlockedUntil = 0;
        authed = true;
        s = attach(ws, m, origin);
        if (!s) rejected = true;
        return;
      }
      if (!s || s.ws !== ws || s.exited) return;
      if (!isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (buf.length > MAX_INPUT_BYTES) {
          forceClose(ws, 1009, 'input too large');
          return;
        }
        s.pty.write(buf.toString('utf8'));
        return;
      }
      let m;
      try { m = JSON.parse(data); } catch { forceClose(ws, 1008, 'malformed control message'); return; }
      if (!isPlainObject(m) || typeof m.t !== 'string') {
        forceClose(ws, 1008, 'invalid control message');
        return;
      }
      if (m.t === 'resize') {
        resize(s, m);
      } else if (m.t === 'ack') {
        if (typeof m.n !== 'number' || !Number.isFinite(m.n) || m.n <= 0 || m.n > MAX_ACK_BYTES) {
          forceClose(ws, 1008, 'invalid ack');
          return;
        }
        s.unacked = Math.max(0, s.unacked - Math.floor(m.n));
        flowControl(s);
      } else {
        forceClose(ws, 1008, 'unknown control message');
      }
    });

    ws.on('error', () => {
      try { ws.terminate(); } catch {}
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      decUnauthed();
      if (s) detach(s, ws);
    });
  });

  function close() {
    for (const sess of sessions.values()) {
      clearTimeout(sess.expire);
      clearTimeout(sess.flushTimer);
      try { sess.pty.kill(); } catch {}
    }
    sessions.clear();
    for (const client of wss.clients) {
      try { client.terminate(); } catch {}
    }
    return new Promise((resolve) => wss.close(() => resolve()));
  }

  return {
    wss,
    sessions,
    getToken: () => token,
    rotateToken,
    close,
  };
}

if (require.main === module) {
  const bridge = createBridge();
  bridge.wss.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${DEFAULT_PORT} is already in use (bridge already running?)` : e);
    process.exit(e.code === 'EADDRINUSE' ? 0 : 1);
  });
  const shutdown = () => {
    bridge.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`PowerShell bridge on ws://127.0.0.1:${DEFAULT_PORT}`);
  console.log(`Bridge token stored in ${path.join(__dirname, '.token')}`);
}

module.exports = {
  createBridge,
  isPlainObject,
  isAllowedOriginFormat,
  getShellSpec,
  validateCwd,
  MAX_PAYLOAD_BYTES,
  MAX_INPUT_BYTES,
};
