// Paper outputs of a softgoods pattern at 1:1: one SVG per pattern, and a tiled print for a home or office printer.
// Both are drawn from the pattern's own DXF (patternDXF), so what is printed is line for line what the cutter's file holds.

import { GraphError } from './errors.js';
import { patternDXF } from './softgoods-export.js';
import { dxfEntities, sizeSet } from './softgoods-marker.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const n = (v) => +v.toFixed(3);
const FONT = '"Space Mono",monospace';
// AutoCAD colour index → what a laser or plotter program sorts by. 7 is "white or black": black on paper.
const ACI = { 1: '#ff0000', 2: '#ffff00', 3: '#00ff00', 4: '#00ffff', 5: '#0000ff', 6: '#ff00ff', 7: '#000000' };

/** A pattern's drawing in paper coordinates (mm, y down, origin at the top-left of its bounds plus pad). */
function drawing(pattern, annotations = [], pad = 5) {
  const { layers, lines, texts } = dxfEntities(patternDXF(pattern, annotations));
  if (!lines.length) throw new GraphError(`Pattern '${pattern.id}' has nothing to draw`);
  const xs = lines.flatMap((l) => [l.a[0], l.b[0]]), ys = lines.flatMap((l) => [l.a[1], l.b[1]]);
  const minX = Math.min(...xs) - pad, maxY = Math.max(...ys) + pad, to = (p) => [p[0] - minX, maxY - p[1]];
  const byLayer = new Map();
  for (const l of lines) { if (!byLayer.has(l.layer)) byLayer.set(l.layer, []); byLayer.get(l.layer).push([to(l.a), to(l.b)]); }
  return { layers, byLayer, texts: texts.map((t) => ({ ...t, at: to(t.at) })), width: Math.max(...xs) + pad - minX, height: maxY - (Math.min(...ys) - pad) };
}

/** Lines end to end become one path, closed where the chain returns to its start: a cutter follows a contour, not 400 loose strokes. */
function pathOf(segments) {
  let d = '', start = null, last = null;
  const same = (p, q) => p && Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) < 1e-6;
  for (const [a, b] of segments) {
    if (!same(last, a)) { d += `M${n(a[0])} ${n(a[1])}`; start = a; }
    if (same(start, b)) d += 'Z'; else d += `L${n(b[0])} ${n(b[1])}`;
    last = b;
  }
  return d;
}
const textsOf = (texts) => texts.map((t) => `<text x="${n(t.at[0])}" y="${n(t.at[1])}" font-size="${n(t.height)}"${t.rotation ? ` transform="rotate(${-t.rotation} ${n(t.at[0])} ${n(t.at[1])})"` : ''}>${esc(t.value)}</text>`).join('');

/** One pattern at 1:1 as a plain SVG: a group per DXF layer, in that layer's colour, sized in mm. */
export function patternSVG(pattern, annotations = []) {
  const g = drawing(pattern, annotations);
  const groups = [...g.byLayer].map(([layer, segments]) => `<g id="${esc(layer)}" fill="none" stroke="${ACI[g.layers[layer]] || '#000000'}" stroke-width="0.25"><path d="${pathOf(segments)}"/></g>`).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(g.width)}mm" height="${n(g.height)}mm" viewBox="0 0 ${n(g.width)} ${n(g.height)}">\n<title>${esc(pattern.name || pattern.id)}</title>\n${groups}\n<g id="TEXT" fill="#000000" font-family='${FONT}' font-weight="400">${textsOf(g.texts)}</g>\n</svg>\n`;
}

export const PAPERS = Object.freeze({ a4: [210, 297], letter: [215.9, 279.4] });

/** How a drawing width × height mm is cut into pages. Each tile is a window of the drawing (x right, y down from its top-left); neighbours share `overlap` mm. */
export function tileLayout(width, height, { paper = 'a4', margin = 10, overlap = 10, orientation = 'portrait' } = {}) {
  const size = PAPERS[String(paper).toLowerCase()];
  if (!size) throw new GraphError(`Unknown paper '${paper}'. Known: ${Object.keys(PAPERS).join(', ')}`);
  if (!['portrait', 'landscape'].includes(orientation)) throw new GraphError(`Orientation '${orientation}' must be portrait or landscape`);
  margin = Number(margin); overlap = Number(overlap);
  const page = orientation === 'landscape' ? [size[1], size[0]] : [...size], w = page[0] - 2 * margin, h = page[1] - 2 * margin;
  if (!(margin >= 0 && overlap >= 0 && w - overlap >= 20 && h - overlap >= 20)) throw new GraphError('Print margin and overlap must be zero or more and leave at least 20 mm of fresh paper per page');
  const step = [w - overlap, h - overlap], cols = Math.max(1, Math.ceil((width - overlap) / step[0] - 1e-9)), rows = Math.max(1, Math.ceil((height - overlap) / step[1] - 1e-9)), tiles = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) tiles.push({ row: r + 1, col: c + 1, x: c * step[0], y: r * step[1], width: w, height: h });
  return { paper: String(paper).toLowerCase(), orientation, page, margin, overlap, window: [w, h], step, cols, rows, tiles };
}

const STYLE = (page) => `@font-face{font-family:"Space Mono";font-weight:400;font-style:normal;src:local("Space Mono"),local("SpaceMono-Regular")}
@page{size:${page[0]}mm ${page[1]}mm;margin:0}
*{border-radius:0}
html,body{margin:0;padding:0;background:#ffffff;color:#000000}
.page{width:${page[0]}mm;height:${page[1]}mm;overflow:hidden;break-after:page;page-break-after:always}
.page svg{display:block}
text{font-family:${FONT};font-weight:400;font-style:normal;fill:#000000}
.ln{fill:none;stroke:#000000;stroke-width:.2}
.CUT,.NOTCH{stroke-width:.4}
.STITCH{stroke-dasharray:3 1.5}
.GRAIN{stroke-width:.3}
.DART,.PLEAT,.FOLD{stroke-dasharray:6 1.5 1 1.5}
.frame{fill:none;stroke:#000000;stroke-width:.15}
.join{fill:none;stroke:#000000;stroke-width:.15;stroke-dasharray:1 2}
.mark{fill:none;stroke:#000000;stroke-width:.2}
@media screen{.page{margin:8mm auto;outline:1px solid #000000}}`;

// An open arrowhead at each end of a grain line.
function arrows(segments) {
  return segments.flatMap(([a, b]) => { const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, u = [(b[0] - a[0]) / l, (b[1] - a[1]) / l], head = (p, s) => [[[p[0] + s * (u[0] * 6 - u[1] * 2), p[1] + s * (u[1] * 6 + u[0] * 2)], p], [p, [p[0] + s * (u[0] * 6 + u[1] * 2), p[1] + s * (u[1] * 6 - u[0] * 2)]]]; return [...head(a, 1), ...head(b, -1)]; });
}
// A registration diamond: both pages that share a join print it at the same place on the pattern, so the two lie on each other when the join is true.
const diamond = (x, y, label) => `<path class="mark" d="M${n(x - 4)} ${n(y)}L${n(x)} ${n(y - 4)}L${n(x + 4)} ${n(y)}L${n(x)} ${n(y + 4)}ZM${n(x - 6)} ${n(y)}L${n(x + 6)} ${n(y)}M${n(x)} ${n(y - 6)}L${n(x)} ${n(y + 6)}"/><text x="${n(x + 5)}" y="${n(y - 3)}" font-size="2.2">${esc(label)}</text>`;

/**
 * Every pattern (at every size asked for) at true scale on tiled pages, as one self-contained HTML document.
 * Each page is an inline SVG in mm with an @page rule of the paper's size: print at 100% ("actual size") to paper or PDF.
 * Page 1 is the cover with the 100 mm and 4 inch check squares; measure them before cutting anything.
 */
export function printHTML(document, { name = 'softgoods', sizes, ...options } = {}) {
  if (!document.patterns.length) throw new GraphError('No softgoods patterns to print');
  const pieces = [];
  for (const { size, document: d } of sizeSet(document, sizes)) for (const p of d.patterns) {
    const g = drawing(p, (document.annotations || []).filter((a) => a.pattern === p.id), 3), layout = tileLayout(g.width, g.height, options);
    pieces.push({ id: p.id, size, title: `${p.name || p.id}${size === 'base' ? '' : ` · SIZE ${size}`}`, cut: p.cut || 1, material: p.material || '', g, layout });
  }
  const first = pieces[0].layout, { page, margin, overlap, window: [w, h], step } = first, total = 1 + pieces.reduce((sum, p) => sum + p.layout.tiles.length, 0);
  const svg = (body) => `<section class="page"><svg xmlns="http://www.w3.org/2000/svg" width="${page[0]}mm" height="${page[1]}mm" viewBox="0 0 ${page[0]} ${page[1]}">${body}</svg></section>`;
  const head = Math.max(margin - 2.5, 4);

  // Cover: what this is, how to print it, the check squares, and where each piece's pages are.
  let pageNo = 1; const index = [];
  for (const p of pieces) { index.push(`${p.title} · ${p.layout.rows} × ${p.layout.cols} · P${pageNo + 1}-${pageNo + p.layout.tiles.length}`); pageNo += p.layout.tiles.length; }
  // Portrait stacks the two squares with the index beside them; a landscape page is too short for that, so they sit side by side with the index below.
  const top = margin + 30, tall = page[1] - margin - top >= 222, inch = tall ? [margin, top + 108] : [margin + 108, top], right = tall ? margin + 108 : margin, listTop = tall ? top : top + 110;
  const fits = Math.max(2, Math.floor((page[1] - margin - 12 - listTop) / 4.5) - 1), listed = index.length > fits ? [...index.slice(0, fits - 1), `+ ${index.length - fits + 1} MORE`] : index;
  const cover = [
    `<text x="${margin}" y="${margin + 6}" font-size="5">${esc(name.toUpperCase())} · PATTERN 1:1</text>`,
    `<text x="${margin}" y="${margin + 13}" font-size="3">PRINT AT 100% (ACTUAL SIZE), NOT FIT TO PAGE. ${first.paper.toUpperCase()} ${first.orientation.toUpperCase()}. ${total} PAGES.</text>`,
    `<text x="${margin}" y="${margin + 18}" font-size="3">MEASURE BOTH SQUARES BEFORE CUTTING. LAY EACH PAGE ON ITS NEIGHBOUR SO THE</text>`,
    `<text x="${margin}" y="${margin + 23}" font-size="3">DIAMONDS COINCIDE (${overlap} MM OVERLAP). ROW 1 IS THE TOP, COL 1 IS THE LEFT.</text>`,
    `<rect class="frame scale-100mm" x="${margin}" y="${top}" width="100" height="100"/><text x="${margin + 3}" y="${top + 7}" font-size="4">100 MM</text>`,
    `<rect class="frame scale-4in" x="${inch[0]}" y="${inch[1]}" width="101.6" height="101.6"/><text x="${inch[0] + 3}" y="${inch[1] + 7}" font-size="4">4 IN</text>`,
    `<text x="${right}" y="${listTop + 3}" font-size="2.6">PIECE · ROWS × COLS · PAGES</text>`,
    ...listed.map((line, i) => `<text x="${right}" y="${n(listTop + 3 + (i + 1) * 4.5)}" font-size="2.6">${esc(line.toUpperCase())}</text>`),
    `<text x="${margin}" y="${n(page[1] - margin - 8)}" font-size="2.6">SOLID HEAVY: CUT · DASHED: STITCH · ARROWS: GRAIN · SHORT HEAVY TICKS: NOTCHES · DASH-DOT: DART, PLEAT, FOLD</text>`,
    `<text x="${margin}" y="${n(page[1] - margin - 3)}" font-size="2.6">PAGE 1 OF ${total}</text>`,
  ];
  const pages = [svg(cover.join(''))];

  pageNo = 1; let clip = 0;
  for (const p of pieces) {
    const { g, layout } = p, marks = [];
    for (let c = 1; c < layout.cols; c++) for (let r = 0; r < layout.rows; r++) marks.push(diamond(c * step[0] + overlap / 2, r * step[1] + h / 2, `V${c}.${r + 1}`));
    for (let r = 1; r < layout.rows; r++) for (let c = 0; c < layout.cols; c++) marks.push(diamond(c * step[0] + w / 2, r * step[1] + overlap / 2, `H${r}.${c + 1}`));
    const art = [...g.byLayer].map(([layer, segments]) => `<path class="ln ${esc(layer)}" d="${pathOf(layer === 'GRAIN' ? [...segments, ...arrows(segments)] : segments)}"/>`).join('') + textsOf(g.texts) + marks.join('');
    for (const t of layout.tiles) {
      pageNo++; clip++;
      const joins = (t.col < layout.cols ? `<path class="join" d="M${n(margin + step[0])} ${margin}V${n(margin + h)}"/>` : '') + (t.row < layout.rows ? `<path class="join" d="M${margin} ${n(margin + step[1])}H${n(margin + w)}"/>` : '');
      pages.push(svg(`<defs><clipPath id="tile${clip}"><rect x="${margin}" y="${margin}" width="${n(w)}" height="${n(h)}"/></clipPath></defs><g clip-path="url(#tile${clip})"><g transform="translate(${n(margin - t.x)} ${n(margin - t.y)})">${art}</g></g><rect class="frame" x="${margin}" y="${margin}" width="${n(w)}" height="${n(h)}"/>${joins}<text x="${margin}" y="${n(head)}" font-size="2.6">${esc(`${p.title} · CUT ${p.cut}${p.material ? ` · ${p.material}` : ''} · ROW ${t.row} OF ${layout.rows} · COL ${t.col} OF ${layout.cols} · PAGE ${pageNo} OF ${total}`.toUpperCase())}</text>`));
    }
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(name)} pattern 1:1</title><style>${STYLE(page)}</style></head><body>\n${pages.join('\n')}\n</body></html>\n`;
}
