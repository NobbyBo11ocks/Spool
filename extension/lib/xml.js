// A small, strict XML reader for DASH manifests. Written instead of using DOMParser because the extension's service
// worker has no DOM, and so the same code runs in the worker, the pages and the tests.
//
// Scope: elements, attributes, text, CDATA, comments, the XML prolog. Namespace prefixes are dropped (`cenc:pssh` -> `pssh`).
// Entities: the five predefined ones and numeric references. DOCTYPE declarations with an internal subset are rejected,
// and nothing is expanded beyond that, so there is no entity-expansion attack surface. Depth and size are capped.

const PREDEFINED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return PREDEFINED[body] ?? whole;
  });
}

const local = (qualified) => qualified.slice(qualified.indexOf(':') + 1);

/**
 * @typedef {{name: string, attrs: Record<string, string>, children: XmlElement[], text: string}} XmlElement
 * @returns {XmlElement} the root element
 */
/**
 * Calls `onAttribute(name, rawValue)` for each `name="value"` / `name='value'` pair in `text` from `start`. One linear
 * pass (a regex version took quadratic time on a long run of characters with no `=`); malformed bits are skipped.
 */
function readAttributes(text, start, onAttribute) {
  const n = text.length;
  const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  let i = start;
  while (i < n) {
    while (i < n && isSpace(text[i])) i++;
    const nameStart = i;
    while (i < n && text[i] !== '=' && !isSpace(text[i])) i++;
    const name = text.slice(nameStart, i);
    while (i < n && isSpace(text[i])) i++;
    if (text[i] !== '=') {
      if (i === nameStart) i++; // stray character: move on
      continue;
    }
    i++;
    while (i < n && isSpace(text[i])) i++;
    const quote = text[i];
    if (quote !== '"' && quote !== "'") continue;
    const end = text.indexOf(quote, i + 1);
    if (end === -1) return;
    if (name) onAttribute(name, text.slice(i + 1, end));
    i = end + 1;
  }
}

export function parseXml(source, { maxChars = 5_000_000, maxDepth = 64, maxElements = 200_000 } = {}) {
  if (typeof source !== 'string') throw new Error('XML source must be a string');
  if (source.length > maxChars) throw new Error('XML document is too large');
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;

  let root = null;
  let elements = 0;
  const stack = [];
  let i = 0;

  while (i < text.length) {
    const lt = text.indexOf('<', i);
    const chunk = text.slice(i, lt === -1 ? text.length : lt);
    if (chunk.trim() !== '') {
      if (!stack.length) throw new Error('Text outside the root element');
      stack[stack.length - 1].text += decodeEntities(chunk);
    }
    if (lt === -1) break;
    i = lt;

    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end === -1) throw new Error('Unterminated comment');
      i = end + 3;
    } else if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i + 9);
      if (end === -1) throw new Error('Unterminated CDATA section');
      if (!stack.length) throw new Error('CDATA outside the root element');
      stack[stack.length - 1].text += text.slice(i + 9, end);
      i = end + 3;
    } else if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2);
      if (end === -1) throw new Error('Unterminated processing instruction');
      i = end + 2;
    } else if (text.startsWith('<!', i)) {
      // <!DOCTYPE ...>: allowed only without an internal subset.
      const end = text.indexOf('>', i + 2);
      if (end === -1 || text.slice(i, end).includes('[')) throw new Error('DOCTYPE declarations are not supported');
      i = end + 1;
    } else if (text.startsWith('</', i)) {
      const end = text.indexOf('>', i + 2);
      if (end === -1) throw new Error('Unterminated end tag');
      const name = local(text.slice(i + 2, end).trim());
      const open = stack.pop();
      if (!open || open.name !== name) throw new Error(`Mismatched end tag </${name}>`);
      i = end + 1;
    } else {
      const end = findTagEnd(text, i + 1);
      if (end === -1) throw new Error('Unterminated start tag');
      let inner = text.slice(i + 1, end);
      const selfClosing = inner.endsWith('/');
      if (selfClosing) inner = inner.slice(0, -1);
      const nameMatch = /^[^\s/>]+/.exec(inner);
      if (!nameMatch) throw new Error('Element without a name');
      const element = { name: local(nameMatch[0]), attrs: {}, children: [], text: '' };
      readAttributes(inner, nameMatch[0].length, (key, value) => {
        if (key === 'xmlns' || key.startsWith('xmlns:')) return;
        element.attrs[local(key)] = decodeEntities(value);
      });
      if (++elements > maxElements) throw new Error('XML has too many elements');
      if (stack.length) stack[stack.length - 1].children.push(element);
      else if (root) throw new Error('More than one root element');
      else root = element;
      if (!selfClosing) {
        if (stack.length >= maxDepth) throw new Error('XML is nested too deeply');
        stack.push(element);
      }
      i = end + 1;
    }
  }
  if (stack.length) throw new Error(`Unclosed element <${stack[stack.length - 1].name}>`);
  if (!root) throw new Error('No root element');
  return root;
}

/** Index of the `>` that ends the tag starting at `from`, ignoring `>` inside quoted attribute values. */
function findTagEnd(text, from) {
  let quote = '';
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i;
    }
  }
  return -1;
}

export const childrenOf = (el, name) => el.children.filter((c) => c.name === name);
export const childOf = (el, name) => el.children.find((c) => c.name === name) ?? null;
