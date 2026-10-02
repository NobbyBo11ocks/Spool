// A handful of 24x24 line icons, drawn for this project. Built with DOM calls (no HTML strings), stroked with
// currentColor so they follow the button's text colour in light and dark mode.

const NS = 'http://www.w3.org/2000/svg';

const SHAPES = {
  download: ['M12 4.5v11', 'M7.5 11.5l4.5 4.5 4.5-4.5', 'M5 19.5h14'],
  copy: [
    'M9.5 8h8A1.5 1.5 0 0 1 19 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 8 17.5v-8A1.5 1.5 0 0 1 9.5 8z',
    'M15 8V6.5A1.5 1.5 0 0 0 13.5 5h-8A1.5 1.5 0 0 0 4 6.5v8A1.5 1.5 0 0 0 5.5 16H8',
  ],
  open: ['M13.5 5H19v5.5', 'M19 5l-7 7', 'M17.5 14.5V18a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7.5a1 1 0 0 1 1-1h3.5'],
  refresh: ['M19 12a7 7 0 1 1-2.1-5', 'M19 4.5V8h-3.5'],
  clipboard: ['M9 4.5h6v3H9z', 'M15 6h2a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h2', 'M9 12h6', 'M9 15.5h4'],
  check: ['M5.5 12.5l4 4 9-9'],
};

export function icon(name, size = 16) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of SHAPES[name]) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}
