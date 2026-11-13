// Copies the xterm.js build + addons from node_modules into extension/vendor (run after upgrading them).
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, '..', 'extension', 'vendor');
const files = {
  'xterm.js': '@xterm/xterm/lib/xterm.js',
  'xterm.css': '@xterm/xterm/css/xterm.css',
  'addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js',
  'addon-webgl.js': '@xterm/addon-webgl/lib/addon-webgl.js',
  'addon-web-links.js': '@xterm/addon-web-links/lib/addon-web-links.js',
  'addon-search.js': '@xterm/addon-search/lib/addon-search.js',
  'addon-serialize.js': '@xterm/addon-serialize/lib/addon-serialize.js',
  'marked.min.js': 'marked/marked.min.js',
  'purify.min.js': 'dompurify/dist/purify.min.js',
  'katex.min.js': 'katex/dist/katex.min.js',
  'katex.min.css': 'katex/dist/katex.min.css',
};
for (const [name, src] of Object.entries(files)) {
  fs.copyFileSync(path.join(__dirname, 'node_modules', src), path.join(out, name));
  console.log(`${name} <- ${src}`);
}
// KaTeX's stylesheet loads its fonts relative to itself.
const fontsOut = path.join(out, 'fonts');
fs.mkdirSync(fontsOut, { recursive: true });
const fontsIn = path.join(__dirname, 'node_modules', 'katex', 'dist', 'fonts');
for (const f of fs.readdirSync(fontsIn)) fs.copyFileSync(path.join(fontsIn, f), path.join(fontsOut, f));
console.log(`fonts/ <- katex/dist/fonts (${fs.readdirSync(fontsIn).length} files)`);
