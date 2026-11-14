// Toolbar button opens a terminal tab; its right-click menu picks the shell (only installed ones) or opens settings.
const api = globalThis.browser ?? chrome;
const SHELLS = { powershell: 'New Windows PowerShell tab', pwsh: 'New PowerShell 7 tab', cmd: 'New Command Prompt tab' };

// A file: URL starts the shell in that folder (a file URL uses its parent); anything else -> ''. Result is a Windows path.
function cwdFromUrl(url) {
  let u;
  try { u = new URL(url); } catch { return ''; }
  if (u.protocol !== 'file:') return '';
  let p;
  try { p = decodeURIComponent(u.pathname); } catch { return ''; }
  if (!p.endsWith('/') && /\.[^/]*$/.test(p)) p = p.slice(0, p.lastIndexOf('/') + 1);   // 'x.json' is a file; 'dir' is a folder
  p = p.replace(/^\/(?=[a-z]:)/i, '').replace(/\/+$/, '');
  if (u.host && u.host !== 'localhost') p = '//' + u.host + p;   // UNC share
  p = p.replace(/\//g, '\\');
  return /^[a-z]:$/i.test(p) ? p + '\\' : p;   // drive root keeps its slash
}

// The clicked tab's URL is readable thanks to activeTab (granted by the click or the shortcut).
function open(shell, tab) {
  const q = new URLSearchParams();
  if (shell) q.set('shell', shell);
  const cwd = tab && tab.url ? cwdFromUrl(tab.url) : '';
  if (cwd) q.set('cwd', cwd);
  const qs = q.toString();
  return api.tabs.create({ url: api.runtime.getURL('terminal.html' + (qs ? '?' + qs : '')) });
}

async function buildMenu() {
  let available = null;
  try { available = (await api.runtime.sendNativeMessage('com.pstab.bridge', { cmd: 'shells' })).shells; } catch {} // no host: offer all
  await api.contextMenus.removeAll();
  for (const [id, title] of Object.entries(SHELLS)) {
    if (!available || available[id] !== false) api.contextMenus.create({ id, title, contexts: ['action'] });
  }
  api.contextMenus.create({ id: 'settings', title: 'Terminal settings', contexts: ['action'] });
}

api.action.onClicked.addListener((tab) => open('', tab));
api.runtime.onInstalled.addListener(buildMenu);
api.runtime.onStartup.addListener(buildMenu);   // picks up shells installed since last time
api.contextMenus.onClicked.addListener(({ menuItemId }, tab) => {
  if (menuItemId === 'settings') api.runtime.openOptionsPage();
  else if (menuItemId in SHELLS) open(menuItemId, tab);
});
