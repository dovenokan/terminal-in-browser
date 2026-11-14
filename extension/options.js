// Options page: edits the shared settings (settings.js); terminal tabs pick changes up via storage.onChanged.
const form = document.getElementById('f');
const status = document.getElementById('status');
const PALETTE = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];

for (const [id, t] of Object.entries(THEMES)) form.theme.add(new Option(t.label, id));

function fill(s) {
  for (const [k, v] of Object.entries(s)) {
    const field = form.elements[k];
    if (field.type === 'checkbox') field.checked = v; else field.value = v;
  }
  preview(s);
}
function read() {
  const s = {};
  for (const k of Object.keys(DEFAULTS)) {
    const field = form.elements[k];
    s[k] = field.type === 'checkbox' ? field.checked : field.value;
  }
  return normalizeSettings(s);
}
function preview(s) {
  const t = themeFor(s.theme, '');
  const box = document.getElementById('preview'), sample = document.getElementById('sample');
  box.style.background = t.background;
  sample.style.color = t.foreground;
  sample.style.fontFamily = s.fontFamily;
  sample.style.fontSize = `${s.fontSize}px`;
  sample.querySelector('b').style.color = t.yellow;
  sample.querySelector('i').style.color = t.brightBlack;
  document.getElementById('chips').replaceChildren(...PALETTE.map((c) => {
    const chip = document.createElement('span');
    chip.style.background = t[c];
    chip.title = c;
    return chip;
  }));
}

let timer = 0;
async function save(s) {
  preview(s);
  try { await saveSettings(s); status.textContent = 'Saved'; } catch (e) { status.textContent = 'Could not save: ' + e.message; }
  clearTimeout(timer);
  timer = setTimeout(() => { status.textContent = ''; }, 1500);
}
form.addEventListener('input', () => save(read()));
form.addEventListener('change', () => fill(read()));   // show the clamped values once editing is done
form.addEventListener('submit', (e) => e.preventDefault());
document.getElementById('reset').addEventListener('click', () => { fill(DEFAULTS); save(DEFAULTS); });
loadSettings().then(fill);
