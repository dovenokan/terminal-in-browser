// Terminal settings shared by terminal.html and options.html (stored in storage.local under "settings").
const CAMPBELL = {
  black: '#0c0c0c', red: '#c50f1f', green: '#13a10e', yellow: '#c19c00', blue: '#0037da', magenta: '#881798', cyan: '#3a96dd', white: '#cccccc',
  brightBlack: '#767676', brightRed: '#e74856', brightGreen: '#16c60c', brightYellow: '#f9f1a5', brightBlue: '#3b78ff', brightMagenta: '#b4009e', brightCyan: '#61d6d6', brightWhite: '#f2f2f2',
};
const THEMES = {
  powershell: { label: 'PowerShell blue', background: '#012456', foreground: '#cccccc', ...CAMPBELL },
  campbell: { label: 'Campbell (dark)', background: '#0c0c0c', foreground: '#cccccc', ...CAMPBELL },
  'one-half-dark': {
    label: 'One Half Dark', background: '#282c34', foreground: '#dcdfe4', cursor: '#a3b3cc', selectionBackground: '#474e5d',
    black: '#282c34', red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#dcdfe4',
    brightBlack: '#5a6374', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#dcdfe4',
  },
  'one-half-light': {
    label: 'One Half Light', background: '#fafafa', foreground: '#383a42', cursor: '#4f525d', selectionBackground: '#bfceff',
    black: '#383a42', red: '#e45649', green: '#50a14f', yellow: '#c18301', blue: '#0184bc', magenta: '#a626a4', cyan: '#0997b3', white: '#fafafa',
    brightBlack: '#4f525d', brightRed: '#df6c75', brightGreen: '#98c379', brightYellow: '#e4c07a', brightBlue: '#61afef', brightMagenta: '#c577dd', brightCyan: '#56b5c1', brightWhite: '#ffffff',
  },
};
const DEFAULTS = {
  theme: 'campbell',   // classic black terminal
  fontFamily: '"Cascadia Mono", Consolas, monospace',
  fontSize: 14,
  cursorStyle: 'block',
  cursorBlink: true,
  copyOnSelect: false,
  scrollback: 10000,
};
const settingsApi = globalThis.browser ?? chrome;

function normalizeSettings(raw) {
  const s = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  const num = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, Math.round(+v))) : d);
  return {
    theme: s.theme === 'auto' || s.theme in THEMES ? s.theme : DEFAULTS.theme,
    fontFamily: String(s.fontFamily || '').trim().slice(0, 200) || DEFAULTS.fontFamily,
    fontSize: num(s.fontSize, 8, 40, DEFAULTS.fontSize),
    cursorStyle: ['block', 'bar', 'underline'].includes(s.cursorStyle) ? s.cursorStyle : DEFAULTS.cursorStyle,
    cursorBlink: !!s.cursorBlink,
    copyOnSelect: !!s.copyOnSelect,
    scrollback: num(s.scrollback, 0, 100000, DEFAULTS.scrollback),
  };
}
const themeFor = (name, shell) => {
  const defaultTheme = 'campbell';
  const { label, ...colors } = THEMES[name === 'auto' ? defaultTheme : name];
  return colors;
};
async function loadSettings() {
  try { return normalizeSettings((await settingsApi.storage.local.get('settings')).settings); } catch { return normalizeSettings(); }
}
const saveSettings = (s) => settingsApi.storage.local.set({ settings: normalizeSettings(s) });
const onSettingsChanged = (fn) => settingsApi.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) fn(normalizeSettings(changes.settings.newValue));
});
