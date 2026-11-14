// Native messaging host: starts the PTY bridge on request, allows the calling extension's origin, returns the token.
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_SERVER_DIR = path.join(__dirname, '..', 'server');
const DEFAULT_EXT_ID_FILE = path.join(__dirname, '..', 'extension-id.txt');
const PORT = 7681;
const FIREFOX_ID = 'pstab@pstab.local';
const MAX_MSG_BYTES = 64 * 1024;
const CHROME_ID_RE = /^[a-p]{32}$/;
const MOZ_ORIGIN_RE = /^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readPinnedChromeId(extIdFile = DEFAULT_EXT_ID_FILE) {
  try {
    const id = fs.readFileSync(extIdFile, 'utf8').trim();
    return CHROME_ID_RE.test(id) ? id : '';
  } catch {
    return '';
  }
}

function getCallerType(caller, pinnedChromeId) {
  if (!Array.isArray(caller) || caller.length === 0) return null;
  if (pinnedChromeId) {
    const expectedOrigin = `chrome-extension://${pinnedChromeId}`;
    const matched = caller.find((a) => typeof a === 'string' && a.replace(/\/$/, '') === expectedOrigin);
    if (matched) return { browser: 'chromium', origin: expectedOrigin };
  }
  if (caller.includes(FIREFOX_ID)) {
    return { browser: 'firefox', origin: null };
  }
  return null;
}

function isAuthorizedCaller(caller, extIdFile = DEFAULT_EXT_ID_FILE) {
  return getCallerType(caller, readPinnedChromeId(extIdFile)) !== null;
}

function send(obj, out = process.stdout) {
  const b = Buffer.from(JSON.stringify(obj));
  const h = Buffer.alloc(4);
  h.writeUInt32LE(b.length, 0);
  out.write(Buffer.concat([h, b]));
}

const listening = () => new Promise((res) => {
  const s = net.connect(PORT, '127.0.0.1');
  s.once('connect', () => { s.destroy(); res(true); });
  s.once('error', () => res(false));
});

const readToken = (serverDir = DEFAULT_SERVER_DIR) => {
  try { return fs.readFileSync(path.join(serverDir, '.token'), 'utf8').trim(); } catch { return ''; }
};

// Firefox gives every install a random moz-extension:// UUID, so the bridge learns it from here.
function allowOriginForCaller(origin, caller, opts = {}) {
  if (typeof origin !== 'string') return false;
  const cleanOrigin = origin.trim().replace(/\/$/, '');
  const pinnedId = readPinnedChromeId(opts.extIdFile);
  const callerInfo = getCallerType(caller, pinnedId);
  if (!callerInfo) return false;

  const ok = callerInfo.browser === 'chromium'
    ? cleanOrigin === callerInfo.origin
    : MOZ_ORIGIN_RE.test(cleanOrigin);
  if (!ok) return false;

  const serverDir = opts.serverDir || DEFAULT_SERVER_DIR;
  const file = path.join(serverDir, 'allowed-origins.txt');
  let list = [];
  try { list = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch {}
  if (!list.includes(cleanOrigin)) fs.appendFileSync(file, cleanOrigin + '\n');
  return true;
}

// Which of the bridge's shells are on PATH (the extension only offers those).
const onPath = (exe) => (process.env.PATH || '').split(';').some((d) => d && path.isAbsolute(d.trim()) && fs.existsSync(path.join(d.trim(), exe)));
const shells = () => {
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  return {
    powershell: fs.existsSync(path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')),
    pwsh: onPath('pwsh.exe') || fs.existsSync(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')),
    cmd: fs.existsSync(path.join(sysRoot, 'System32', 'cmd.exe')),
  };
};

// WMI-created processes live outside the browser's job object, so they survive the browser closing.
function wmiStart(commandLine, dir) {
  const q = (s) => `'${s.replace(/'/g, "''")}'`;
  return `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${q(commandLine)}; CurrentDirectory = ${q(dir)}; ProcessStartupInformation = $si } | Out-Null`;
}

async function start(serverDir = DEFAULT_SERVER_DIR) {
  if (!(await listening())) {
    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    const psExe = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const wscriptExe = path.join(sysRoot, 'System32', 'wscript.exe');
    const rootDir = path.join(__dirname, '..');
    const ps = [
      '$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }',
      wmiStart(`"${process.execPath}" server.js`, serverDir),
      wmiStart(`"${wscriptExe}" "${path.join(rootDir, 'launch.vbs')}"`, rootDir),
    ].join('; ');
    spawn(psExe, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], { stdio: 'ignore', windowsHide: true }).unref();
    for (let i = 0; i < 240 && !(await listening()); i++) await new Promise((r) => setTimeout(r, 100));
  }
  return { ok: await listening(), token: readToken(serverDir) };
}

function createMessageProcessor(opts = {}) {
  const caller = opts.caller || [];
  const extIdFile = opts.extIdFile || DEFAULT_EXT_ID_FILE;
  const serverDir = opts.serverDir || DEFAULT_SERVER_DIR;
  const startFn = opts.startFn || (() => start(serverDir));
  const shellsFn = opts.shellsFn || shells;
  const sendFn = opts.sendFn || send;
  const onFatal = opts.onFatal || (() => process.exit(1));

  let buf = Buffer.alloc(0);
  let queue = Promise.resolve();

  async function handleMessage(msg) {
    if (!isAuthorizedCaller(caller, extIdFile)) {
      sendFn({ ok: false, error: 'unauthorized caller' });
      onFatal(1);
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.cmd !== 'string') {
      sendFn({ ok: false, error: 'invalid message' });
      return;
    }
    if (msg.cmd === 'start') {
      if (typeof msg.origin === 'string') {
        try { allowOriginForCaller(msg.origin, caller, { extIdFile, serverDir }); } catch {}
      }
      sendFn(await startFn());
    } else if (msg.cmd === 'shells') {
      sendFn({ ok: true, shells: shellsFn() });
    } else {
      sendFn({ ok: false, error: 'unknown command' });
    }
  }

  function pushChunk(chunk) {
    if (buf.length + chunk.length > MAX_MSG_BYTES + 4) {
      sendFn({ ok: false, error: 'message too large' });
      buf = Buffer.alloc(0);
      onFatal(1);
      return queue;
    }
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const n = buf.readUInt32LE(0);
      if (n === 0 || n > MAX_MSG_BYTES) {
        sendFn({ ok: false, error: 'invalid message size' });
        buf = Buffer.alloc(0);
        onFatal(1);
        return queue;
      }
      if (buf.length < 4 + n) break;
      const raw = buf.subarray(4, 4 + n).toString('utf8');
      buf = buf.subarray(4 + n);
      let msg = null;
      try {
        msg = JSON.parse(raw);
      } catch {
        queue = queue.then(() => sendFn({ ok: false, error: 'malformed json' }));
        continue;
      }
      queue = queue.then(() => handleMessage(msg));
    }
    return queue;
  }

  return { pushChunk, handleMessage };
}

if (require.main === module) {
  const caller = process.argv.slice(2);
  if (!isAuthorizedCaller(caller)) {
    send({ ok: false, error: 'unauthorized caller' });
    process.exit(1);
  }
  const processor = createMessageProcessor({ caller });
  process.stdin.on('data', (d) => { processor.pushChunk(d); });
  process.stdin.on('end', () => process.exit(0));
}

module.exports = {
  MAX_MSG_BYTES,
  FIREFOX_ID,
  readPinnedChromeId,
  getCallerType,
  isAuthorizedCaller,
  allowOriginForCaller,
  createMessageProcessor,
  send,
};
