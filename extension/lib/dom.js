/**
 * Creates an element. Children are appended as text nodes (or nodes), so page-controlled strings such as URLs
 * and titles can never become markup. `on<event>` props add listeners, `class` sets className.
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node[k] = v;
  }
  for (const c of children) node.append(c);
  return node;
}
