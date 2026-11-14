// Markdown + LaTeX viewer. A shell prints OSC 7770 with base64 UTF-8 Markdown; the terminal opens it as a rendered panel.
// Math: $inline$ and $$display$$ (KaTeX). Output is sanitized with DOMPurify before it touches the page.
const RENDER_OSC = 7770;
const RENDER_MAX_BYTES = 2 * 1024 * 1024;

marked.use({
  extensions: [
    {
      name: 'mathBlock', level: 'block',
      start: (src) => src.indexOf('$$'),
      tokenizer(src) {
        const m = /^\$\$\s*\n?([\s\S]+?)\n?\$\$[ \t]*(?:\n+|$)/.exec(src);
        if (m) return { type: 'mathBlock', raw: m[0], text: m[1].trim() };
      },
      renderer: (t) => katex.renderToString(t.text, { displayMode: true, throwOnError: false, trust: false, output: 'htmlAndMathml' }),
    },
    {
      name: 'mathInline', level: 'inline',
      start: (src) => src.indexOf('$'),
      tokenizer(src) {
        // $x$ where the opening $ is not followed by a space and the closing $ is not preceded by one
        const m = /^\$(?!\$)(?=[^\s$])((?:\\.|[^\\$\n])+?)(?<=[^\s\\])\$/.exec(src);
        if (m) return { type: 'mathInline', raw: m[0], text: m[1] };
      },
      renderer: (t) => katex.renderToString(t.text, { displayMode: false, throwOnError: false, trust: false, output: 'htmlAndMathml' }),
    },
  ],
  gfm: true,
  breaks: false,
});

// Links open in a new tab, never inside the terminal page.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
});

function renderMarkdown(text) {
  const html = marked.parse(text, { async: false });
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, mathMl: true },
    FORBID_TAGS: ['style', 'form', 'input', 'textarea', 'select', 'button', 'iframe', 'object', 'embed'],
  });
}

function decodeBase64Utf8(b64) {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

// --- panel -----------------------------------------------------------------------------------
let panel = null;
function closeRender() {
  if (panel) { panel.remove(); panel = null; }
  term.focus();
}
function openRender(text, title) {
  closeRender();
  panel = document.createElement('section');
  panel.id = 'doc';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', title);
  const bar = document.createElement('header');
  const h = document.createElement('strong');
  h.textContent = title;
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.title = 'Close (Esc)';
  close.addEventListener('click', closeRender);
  bar.append(h, close);
  const body = document.createElement('article');
  body.className = 'md';
  body.innerHTML = renderMarkdown(text);   // sanitized above
  panel.append(bar, body);
  document.body.append(panel);
  close.focus();
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
