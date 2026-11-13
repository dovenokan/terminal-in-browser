// Terminal tab: xterm.js front end for the local bridge (protocol: see server/server.js).
const api = globalThis.browser ?? chrome;   // Firefox: promise-based `browser`; Chromium: `chrome`
const PORT = 7681;
const ACK_EVERY = 32 * 1024;                // flow control: ack processed output in chunks
const params = new URLSearchParams(location.search);
const SHELL = params.get('shell') || '';
const CWD = params.get('cwd') || '';
const TITLE = { pwsh: 'PowerShell 7', cmd: 'Command Prompt' }[SHELL] || 'PowerShell';
const enc = new TextEncoder(), dec = new TextDecoder();
const ctl = (m) => enc.encode(JSON.stringify(m));   // control messages travel as binary frames

const el = document.getElementById('t');
const term = new Terminal({
  fontFamily: DEFAULTS.fontFamily, fontSize: DEFAULTS.fontSize, cursorBlink: DEFAULTS.cursorBlink, scrollback: DEFAULTS.scrollback,
  theme: themeFor('auto', SHELL),
  allowProposedApi: true,   // search match highlighting uses the decoration API
});
document.body.style.background = term.options.theme.background;
const fit = new FitAddon.FitAddon();
const serializer = new SerializeAddon.SerializeAddon();
term.loadAddon(fit);
term.loadAddon(serializer);
term.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => {
  if (e.ctrlKey || e.metaKey) window.open(uri, '_blank', 'noopener,noreferrer');   // Ctrl+click, like Windows Terminal
}));
term.open(el);
try {
  const gl = new WebglAddon.WebglAddon();
  gl.onContextLoss(() => gl.dispose());
  term.loadAddon(gl);
} catch {} // no WebGL: xterm keeps its DOM renderer
fit.fit();
term.focus();
document.title = TITLE;
term.onTitleChange((t) => { document.title = t || TITLE; });

let raf = 0;
new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => fit.fit()); }).observe(el);

// User settings (options page); changes apply live to every open tab.
let settings = normalizeSettings();
function applySettings(s) {
  settings = s;
  const theme = themeFor(s.theme, SHELL);
  Object.assign(term.options, {
    theme, fontFamily: s.fontFamily, fontSize: s.fontSize, cursorStyle: s.cursorStyle, cursorBlink: s.cursorBlink, scrollback: s.scrollback,
  });
  document.body.style.background = theme.background;
  fit.fit();
}
const settingsReady = loadSettings().then(applySettings);
onSettingsChanged(applySettings);

// Reloading the tab reattaches to the same shell: keep the session id and a snapshot of the screen per tab.
let session = sessionStorage.getItem('session');
try { term.options.windowsPty = JSON.parse(sessionStorage.getItem('pty')) || {}; } catch {}   // before any resize
if (session) term.write(sessionStorage.getItem('screen') || '');
addEventListener('pagehide', () => {
  if (session) try { sessionStorage.setItem('screen', serializer.serialize({ scrollback: 2000 })); } catch {}
});
function forget() {
  session = null;
  sessionStorage.removeItem('session');
  sessionStorage.removeItem('screen');
}

const note = (msg) => term.write(`\r\n\x1b[2m[${msg}]\x1b[0m\r\n`);
const onKeyOnce = (fn) => { const d = term.onData(() => { d.dispose(); fn(); }); };

// --- token + bridge startup -----------------------------------------------------------------
let memToken = '';   // survives a broken/unavailable storage area
async function storedToken() {
  try { return (await api.storage.local.get('token')).token || memToken; } catch { return memToken; }
}
async function saveToken(token) {
  memToken = token;
  try { await api.storage.local.set({ token }); } catch {}
}
async function askToken() {
  const token = (prompt('Paste the token printed by the bridge server (tray icon: right-click > Copy token):') || '').trim();
  await saveToken(token);
  return token;
}
async function startServer() {
  // The native host starts the tray/bridge if needed, allows our origin and hands back the token.
  try {
    const r = await api.runtime.sendNativeMessage('com.okan.pstab', { cmd: 'start', origin: location.origin });
    if (r && r.token) await saveToken(r.token);
  } catch {} // host not installed: fall back to a manually started server
}
const tokenFromHash = (async () => {   // the tray passes the token in the URL fragment
  if (location.hash.length > 1) {
    const token = decodeURIComponent(location.hash.slice(1));
    history.replaceState(null, '', location.pathname + location.search);
    await saveToken(token);
  }
})();

// --- connection -----------------------------------------------------------------------------
let attempts = 0;
async function connect(viaHost = false) {
  if (viaHost) await startServer();
  let token = await storedToken();
  if (!token) {
    if (!viaHost) return connect(true);
    token = await askToken();
  }
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
  ws.binaryType = 'arraybuffer';
  let opened = false, exitCode = null, processed = 0;
  const send = (m) => ws.readyState === WebSocket.OPEN && ws.send(m);
  const subs = [
    term.onData((d) => send(d)),
    term.onResize(({ cols, rows }) => send(ctl({ t: 'resize', cols, rows }))),
  ];
  ws.onopen = () => {
    opened = true;
    send(ctl({ t: 'hello', token, cols: term.cols, rows: term.rows, cwd: CWD, shell: SHELL, session }));
  };
  ws.onmessage = ({ data }) => {
    if (typeof data === 'string') {
      term.write(data, () => {
        processed += data.length;
        if (processed >= ACK_EVERY) { send(ctl({ t: 'ack', n: processed })); processed = 0; }
      });
      return;
    }
    const m = JSON.parse(dec.decode(data));
    if (m.t === 'ready') {
      attempts = 0;
      if (session && !m.resumed) note('previous session ended; new shell');
      session = m.session;
      sessionStorage.setItem('session', session);
      if (m.pty) { term.options.windowsPty = m.pty; sessionStorage.setItem('pty', JSON.stringify(m.pty)); }
    } else if (m.t === 'exit') exitCode = m.code;
  };
  ws.onclose = (e) => {
    subs.forEach((s) => s.dispose());
    if (exitCode !== null) {
      forget();
      note(`process exited with code ${exitCode}; press any key for a new shell`);
      return onKeyOnce(() => connect());
    }
    switch (e.code) {
      case 4401:   // stale token: ask the native host for the current one before bothering the user
        if (!viaHost) return connect(true);
        note('bad token; press any key to paste the current one');
        return onKeyOnce(() => askToken().then(() => connect()));
      case 4409:
        note('this session was opened in another tab; press any key to take it back');
        return onKeyOnce(() => connect());
      case 4429:
        note('too many open sessions; close some terminal tabs, then press any key');
        return onKeyOnce(() => connect());
      case 4500:
        forget();
        note(/not found/i.test(e.reason) && SHELL === 'pwsh'
          ? 'PowerShell 7 is not installed (winget install Microsoft.PowerShell); press any key to retry'
          : `could not start the shell: ${e.reason}; press any key to retry`);
        return onKeyOnce(() => connect());
    }
    if (!opened && !viaHost) return connect(true);   // bridge down (or origin not yet allowed): let the native host fix it
    if (++attempts <= 6) {
      if (attempts === 1) note('connection lost; reconnecting...');
      return void setTimeout(() => connect(true), Math.min(250 * 2 ** attempts, 5000));
    }
    attempts = 0;
    note('disconnected; press any key to reconnect');
    onKeyOnce(() => connect(true));
  };
}
Promise.all([tokenFromHash, settingsReady]).then(() => connect());   // settings first: they decide cols/rows

// --- clipboard: Ctrl+C copies a selection, Ctrl+V pastes, right-click copies or pastes ------------
const copy = (text) => navigator.clipboard.writeText(text).catch(() => {});
term.onSelectionChange(() => { if (settings.copyOnSelect && term.hasSelection()) copy(term.getSelection()); });
term.attachCustomKeyEventHandler((e) => {
  if (e.type !== 'keydown' || !e.ctrlKey || e.altKey || e.metaKey) return true;
  const k = e.key.toLowerCase();
  if (k === 'c' && (term.hasSelection() || e.shiftKey)) {
    if (term.hasSelection()) { copy(term.getSelection()); term.clearSelection(); }
    e.preventDefault();
    return false;
  }
  if (k === 'v') return false;   // the browser then fires `paste`, which xterm handles (bracketed paste included)
  if (k === 'f' && e.shiftKey) { e.preventDefault(); openFind(); return false; }
  if (k === 'm' && e.shiftKey) { e.preventDefault(); renderOutput(); return false; }
  return true;
});
el.addEventListener('contextmenu', async (e) => {
  e.preventDefault();
  if (term.hasSelection()) { copy(term.getSelection()); term.clearSelection(); return; }
  try { const text = await navigator.clipboard.readText(); if (text) term.paste(text); } catch {}
});

// --- find (Ctrl+Shift+F); the search addon loads on first use ----------------------------------
const find = document.getElementById('find'), q = document.getElementById('q'), count = document.getElementById('count');
const DECORATIONS = {
  matchBackground: '#614d00', matchOverviewRuler: '#d9b200',
  activeMatchBackground: '#b36b00', activeMatchColorOverviewRuler: '#ff9900',
};
let search = null;
const loadScript = (src) => new Promise((resolve, reject) => {
  const s = document.createElement('script');
  s.src = src; s.onload = resolve; s.onerror = reject;
  document.head.append(s);
});
async function openFind() {
  if (!search) {
    await loadScript('vendor/addon-search.js');
    search = new SearchAddon.SearchAddon();
    term.loadAddon(search);
    search.onDidChangeResults(({ resultIndex, resultCount }) => {
      count.textContent = q.value ? `${resultCount ? resultIndex + 1 : 0}/${resultCount}` : '';
    });
  }
  if (term.hasSelection()) q.value = term.getSelection().split('\n')[0];
  find.hidden = false;
  q.select();
  q.focus();
}
function findStep(dir) {
  if (!q.value) { search.clearDecorations(); count.textContent = ''; return; }
  const opts = { decorations: DECORATIONS, incremental: dir === 'incremental' };
  if (dir === 'prev') search.findPrevious(q.value, opts); else search.findNext(q.value, opts);
}
function closeFind() {
  search.clearDecorations();
  find.hidden = true;
  term.focus();
}
q.addEventListener('input', () => findStep('incremental'));
q.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? 'prev' : 'next'); }
  else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});
find.addEventListener('click', (e) => {
  const dir = e.target.dataset && e.target.dataset.dir;
  if (dir === 'close') closeFind(); else if (dir) { findStep(dir); q.focus(); }
});
