// Kursor product scripts — minimal XML property-list reader/writer for Info.plist edits.
// Deterministic on every host (plutil/PlistBuddy only exist on macOS); output uses Apple's own
// layout (tabs, one element per line) so a diff against the original shows only the changed values.
//
//   dict    → Map (key order preserved)        array → Array
//   string  → string                           true/false → boolean
//   integer/real/date/data → PlistScalar { tag, text } (kept verbatim)

export class PlistScalar {
  constructor(tag, text) { this.tag = tag; this.text = text; }
}

const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function parsePlist(xml) {
  const tokens = [];
  const re = /<\?[\s\S]*?\?>|<![\s\S]*?>|<\/?[A-Za-z][\w:-]*(?:\s[^>]*?)?\/?>|[^<]+/g;
  for (const m of xml.matchAll(re)) {
    const t = m[0];
    if (t.startsWith('<?') || t.startsWith('<!')) continue;
    if (!t.startsWith('<') && !t.trim()) continue; // whitespace between elements
    tokens.push(t);
  }
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const tagName = (t) => /^<\/?([A-Za-z][\w:-]*)/.exec(t)[1];
  const expectClose = (name) => {
    const t = next();
    if (t !== `</${name}>`) throw new Error(`plist: expected </${name}>, got ${t}`);
  };
  // Text content of a simple element whose opening tag was consumed.
  const text = (name) => {
    let s = '';
    if (!peek().startsWith('<')) s = next();
    expectClose(name);
    return unescape(s);
  };
  function value() {
    const t = next();
    if (!t || !t.startsWith('<')) throw new Error(`plist: unexpected ${t}`);
    const name = tagName(t);
    const selfClosing = t.endsWith('/>');
    switch (name) {
      case 'dict': {
        const d = new Map();
        if (selfClosing) return d;
        while (peek() !== '</dict>') {
          const k = next();
          if (tagName(k) !== 'key') throw new Error(`plist: expected <key>, got ${k}`);
          d.set(text('key'), value());
        }
        next();
        return d;
      }
      case 'array': {
        const a = [];
        if (selfClosing) return a;
        while (peek() !== '</array>') a.push(value());
        next();
        return a;
      }
      case 'string': return selfClosing ? '' : text('string');
      case 'true': return true;
      case 'false': return false;
      case 'integer': case 'real': case 'date': case 'data':
        return new PlistScalar(name, selfClosing ? '' : text(name));
      default: throw new Error(`plist: unsupported element <${name}>`);
    }
  }
  const open = next();
  if (tagName(open) !== 'plist') throw new Error('plist: missing <plist> root');
  const root = value();
  expectClose('plist');
  return root;
}

export function serializePlist(root) {
  const lines = [];
  const emit = (v, depth) => {
    const ind = '\t'.repeat(depth);
    if (v instanceof Map) {
      if (!v.size) return lines.push(`${ind}<dict/>`);
      lines.push(`${ind}<dict>`);
      for (const [k, val] of v) { lines.push(`${ind}\t<key>${escape(k)}</key>`); emit(val, depth + 1); }
      lines.push(`${ind}</dict>`);
    } else if (Array.isArray(v)) {
      if (!v.length) return lines.push(`${ind}<array/>`);
      lines.push(`${ind}<array>`);
      for (const val of v) emit(val, depth + 1);
      lines.push(`${ind}</array>`);
    } else if (typeof v === 'string') {
      lines.push(`${ind}<string>${escape(v)}</string>`);
    } else if (typeof v === 'boolean') {
      lines.push(`${ind}<${v}/>`);
    } else if (v instanceof PlistScalar) {
      lines.push(`${ind}<${v.tag}>${escape(v.text)}</${v.tag}>`);
    } else {
      throw new Error(`plist: cannot serialize ${typeof v}`);
    }
  };
  emit(root, 0);
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + '<plist version="1.0">\n' + lines.join('\n') + '\n</plist>\n';
}
