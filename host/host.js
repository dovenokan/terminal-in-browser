// Native messaging host: starts the PTY bridge on request, allows the calling extension's origin, returns the token.
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const serverDir = path.join(__dirname, '..', 'server');
const PORT = 7681;
const FIREFOX_ID = 'terminal-in-browser@local.addon';
// Chromium passes the caller origin ("chrome-extension://<id>/"); Firefox passes [manifest path, add-on id].
const caller = process.argv.slice(2);

function send(obj) {
  const b = Buffer.from(JSON.stringify(obj));
  const h = Buffer.alloc(4); h.writeUInt32LE(b.length);
  process.stdout.write(Buffer.concat([h, b]));
}
const listening = () => new Promise((res) => {
  const s = net.connect(PORT, '127.0.0.1');
  s.once('connect', () => { s.destroy(); res(true); });
  s.once('error', () => res(false));
});
const token = () => { try { return fs.readFileSync(path.join(serverDir, '.token'), 'utf8').trim(); } catch { return ''; } };

// Firefox gives every install a random moz-extension:// UUID, so the bridge learns it from here.
function allowOrigin(origin) {
  const chromium = caller.find((a) => a.startsWith('chrome-extension://'));
  const ok = chromium
    ? origin === chromium.replace(/\/$/, '')
    : caller.includes(FIREFOX_ID) && /^moz-extension:\/\/[0-9a-f-]{36}$/.test(origin);
  if (!ok) return;
  const file = path.join(serverDir, 'allowed-origins.txt');
  let list = [];
  try { list = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch {}
  if (!list.includes(origin)) fs.appendFileSync(file, origin + '\n');
}

// Which of the bridge's shells are on PATH (the extension only offers those).
const onPath = (exe) => (process.env.PATH || '').split(';').some((d) => d && fs.existsSync(path.join(d, exe)));
const shells = () => ({ powershell: onPath('powershell.exe'), pwsh: onPath('pwsh.exe'), cmd: onPath('cmd.exe') });

// WMI-created processes live outside the browser's job object, so they survive the browser closing.
function wmiStart(commandLine, dir) {
  const q = (s) => `'${s.replace(/'/g, "''")}'`;
  return `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${q(commandLine)}; CurrentDirectory = ${q(dir)}; ProcessStartupInformation = $si } | Out-Null`;
}

async function start() {
  if (!(await listening())) {
    // Start the bridge directly (hidden, ~1 s) and the tray next to it (it keeps the bridge alive; a second copy exits).
    const ps = [
      '$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }',
      wmiStart(`"${process.execPath}" server.js`, serverDir),
      wmiStart(`wscript.exe "${path.join(__dirname, '..', 'launch.vbs')}"`, path.join(__dirname, '..')),
    ].join('; ');
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], { stdio: 'ignore', windowsHide: true }).unref();
    for (let i = 0; i < 240 && !(await listening()); i++) await new Promise((r) => setTimeout(r, 100));
  }
  return { ok: await listening(), token: token() };
}

let buf = Buffer.alloc(0);
process.stdin.on('data', async (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
    const n = buf.readUInt32LE(0);
    const msg = JSON.parse(buf.subarray(4, 4 + n).toString());
    buf = buf.subarray(4 + n);
    if (msg.cmd === 'start') {
      if (typeof msg.origin === 'string') try { allowOrigin(msg.origin); } catch {}
      send(await start());
    } else if (msg.cmd === 'shells') send({ ok: true, shells: shells() });
  }
});
process.stdin.on('end', () => process.exit(0));
