// Writing HTML by hand. Everything that came from a person or a file goes through esc().
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);

/** A template tag: interpolated values are escaped unless they are already `raw`. */
export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((value, i) => {
    out += render(value) + strings[i + 1];
  });
  return raw(out);
}

class Raw {
  constructor(text) {
    this.text = text;
  }
  toString() {
    return this.text;
  }
}
export const raw = (text) => new Raw(String(text));
function render(value) {
  if (value == null || value === false) return '';
  if (value instanceof Raw) return value.text;
  if (Array.isArray(value)) return value.map(render).join('');
  return esc(value);
}

export const money = (cents) => (cents == null ? '' : `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

/** Text with blank lines as paragraphs and single breaks kept. */
export const paragraphs = (text) => String(text ?? '').split(/\n{2,}/).filter((p) => p.trim()).map((p) => html`<p>${raw(esc(p.trim()).replace(/\n/g, '<br>'))}</p>`);

export function ago(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
