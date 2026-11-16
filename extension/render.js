// Markdown + LaTeX viewer. A shell prints OSC 7770 with base64 UTF-8 Markdown; the terminal opens it as a rendered panel.
// Math: $inline$, \(inline\), $$display$$, and \[display\] (KaTeX). Output is sanitized with DOMPurify before it touches the page.
const RENDER_OSC = 7770;
const RENDER_MAX_BYTES = 2 * 1024 * 1024;

function renderMath(tex, displayMode) {
  return katex.renderToString(tex, {
    displayMode,
    throwOnError: false,
    trust: false,
    output: 'htmlAndMathml',
  });
}

function firstIndexOf(src, tokens) {
  let min = -1;
  for (const tok of tokens) {
    const idx = src.indexOf(tok);
    if (idx !== -1 && (min === -1 || idx < min)) min = idx;
  }
  return min;
}

marked.use({
  extensions: [
    {
      name: 'mathBlock',
      level: 'block',
      start: (src) => firstIndexOf(src, ['$$', '\\[']),
      tokenizer(src) {
        let m = /^[ \t]{0,3}\$\$\s*\n?([\s\S]+?)\n?\$\$[ \t]*(?:\n+|$)/.exec(src);
        if (m) return { type: 'mathBlock', raw: m[0], text: m[1].trim() };
        m = /^[ \t]{0,3}\\\[\s*\n?([\s\S]+?)\n?\\\][ \t]*(?:\n+|$)/.exec(src);
        if (m) return { type: 'mathBlock', raw: m[0], text: m[1].trim() };
      },
      renderer: (t) => `${renderMath(t.text, true)}\n`,
    },
    {
      name: 'mathInline',
      level: 'inline',
      start: (src) => firstIndexOf(src, ['$', '\\(', '\\[']),
      tokenizer(src) {
        let m = /^\$\$([\s\S]+?)\$\$/.exec(src);
        if (m) return { type: 'mathInline', raw: m[0], text: m[1].trim(), display: true };
        m = /^\\\(([\s\S]+?)\\\)/.exec(src);
        if (m) return { type: 'mathInline', raw: m[0], text: m[1].trim(), display: false };
        m = /^\\\[([\s\S]+?)\\\]/.exec(src);
        if (m) return { type: 'mathInline', raw: m[0], text: m[1].trim(), display: true };
        // $x$ where the opening $ is not followed by a space and the closing $ is not preceded by one
        m = /^\$(?!\$)(?=[^\s$])((?:\\.|[^\\$\n])+?)(?<=[^\s\\])\$/.exec(src);
        if (m) return { type: 'mathInline', raw: m[0], text: m[1], display: false };
      },
      renderer: (t) => renderMath(t.text, !!t.display),
    },
  ],
  gfm: true,
  breaks: false,
});

// Links open in a new tab, never inside the terminal page.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

function renderMarkdown(text) {
  const html = marked.parse(text, { async: false });
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, mathMl: true, svg: true },
    FORBID_TAGS: ['style', 'form', 'input', 'textarea', 'select', 'button', 'iframe', 'object', 'embed', 'foreignobject'],
  });
}

function wrapTables(root) {
  for (const table of root.querySelectorAll('table')) {
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    table.replaceWith(wrap);
    wrap.append(table);
  }
}

function decodeBase64Utf8(b64) {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

// --- panel -----------------------------------------------------------------------------------
let panel = null;
let docTheme = null;
function closeRender() {
  if (panel) { panel.remove(); panel = null; }
  term.focus();
}
function openRender(text, title) {
  closeRender();
  const initialTheme = docTheme || (typeof settings !== 'undefined' && settings.theme === 'one-half-light' ? 'light' : 'dark');
  panel = document.createElement('section');
  panel.id = 'doc';
  panel.dataset.theme = initialTheme;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', title);

  const bar = document.createElement('header');
  const h = document.createElement('strong');
  h.textContent = title;

  const actions = document.createElement('div');
  actions.className = 'doc-actions';

  const themeBtn = document.createElement('button');
  themeBtn.type = 'button';
  themeBtn.className = 'doc-btn';
  const syncThemeBtn = () => {
    const isLight = panel.dataset.theme === 'light';
    themeBtn.textContent = isLight ? 'Dark' : 'Light';
    themeBtn.title = isLight ? 'Switch to dark theme' : 'Switch to light theme';
  };
  syncThemeBtn();
  themeBtn.addEventListener('click', () => {
    docTheme = panel.dataset.theme === 'light' ? 'dark' : 'light';
    panel.dataset.theme = docTheme;
    syncThemeBtn();
  });

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'doc-btn';
  copyBtn.textContent = 'Copy';
  copyBtn.title = 'Copy raw Markdown';
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(text).then(() => {
      copyBtn.textContent = 'Copied';
      setTimeout(() => { if (copyBtn.isConnected) copyBtn.textContent = 'Copy'; }, 1500);
    }).catch(() => {});
  });

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'doc-close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close');
  close.title = 'Close (Esc)';
  close.addEventListener('click', closeRender);

  actions.append(themeBtn, copyBtn, close);
  bar.append(h, actions);

  const scroll = document.createElement('div');
  scroll.className = 'doc-scroll';
  scroll.tabIndex = -1;

  const body = document.createElement('article');
  body.className = 'md';
  body.innerHTML = renderMarkdown(text);   // sanitized above
  wrapTables(body);

  scroll.append(body);
  panel.append(bar, scroll);
  document.body.append(panel);
  scroll.focus();
}
// Ctrl+Shift+M: render the selection, or the last 300 lines of output when nothing is selected.
const RENDER_LINES = 300;
function renderOutput() {
  let text = term.hasSelection() ? term.getSelection() : '';
  if (!text.trim()) {
    const buf = term.buffer.active;
    const lines = [];
    for (let i = Math.max(0, buf.length - RENDER_LINES); i < buf.length; i++) lines.push(buf.getLine(i).translateToString(true));
    text = lines.join('\n').replace(/\n+$/, '');
  }
  if (!text.trim()) return note('nothing to render');
  openRender(text, 'Rendered output');
}

// Capture phase: while the panel is open, Esc closes it and never reaches the shell.
addEventListener('keydown', (e) => {
  if (panel && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeRender(); }
}, true);

term.parser.registerOscHandler(RENDER_OSC, (data) => {
  try {
    const b64 = data.trim();
    if (b64.length > Math.ceil(RENDER_MAX_BYTES * 4 / 3)) throw new Error('too large');
    openRender(decodeBase64Utf8(b64), 'Rendered Markdown');
  } catch (e) {
    note(`could not render: ${e.message}`);
  }
  return true;
});
