// Bill of materials and consumption for a softgoods design: what to buy to make it.
// Cloth is counted two ways. Net is the area of the cut pieces themselves; consumed is the rectangle of roll the marker
// takes (its length × the roll's usable width), which is what is actually bought. Weight and cost follow from each.

import { makeMarkers, markerSummary, sizeSet } from './softgoods-marker.js';
import { resolveMaterial } from './softgoods-fabrics.js';
import { seamLengths } from './softgoods-operations.js';
import { checkPhysics } from './softgoods-physics.js';
import { SEAM_KINDS, trimsBill, topstitchLength } from './softgoods-trims.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const round = (v, digits = 2) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(digits));

// Thread per mm of seam. 2.5 is the usual rule of thumb for a 301 lockstitch (needle and bobbin thread together); an
// overlock or cover stitch takes several times more. It is an estimate for ordering, not a measurement.
export const DEFAULT_THREAD_MULTIPLIER = 2.5;

/**
 * Options: everything makeMarkers takes (width, gap, turns, sizes, resolution), and
 *   threadMultiplier  mm of thread per mm of stitching: one number, or { plain: 2.5, overlock: 14, default: 2.5 } by seam kind.
 *                     A seam kind sewn in several rows (SEAM_KINDS: french and flat-felled 2, double-topstitched 3) takes the number
 *                     that many times; a kind named in the object is taken as given.
 * Price is whatever currency the material's pricePerMeter (per running metre of roll) or pricePerSqm was given in.
 */
export function billOfMaterials(document, { threadMultiplier = DEFAULT_THREAD_MULTIPLIER, ...markerOptions } = {}) {
  const set = sizeSet(document, markerOptions.sizes), units = set.reduce((sum, s) => sum + s.units, 0), ids = [...new Set(document.patterns.map((p) => p.material || ''))];
  const materials = ids.map((id) => {
    const m = resolveMaterial(document.materials?.[id], id) || {}, density = Number(m.arealDensity ?? m.weight ?? m.weightGsm) || null, row = { id, name: m.name || id || 'unnamed', preset: m.preset || null, source: m.source || null };
    // One material's piece too wide for its roll must not hide every other line of the bill: it is reported on its own row.
    let marker = null; try { marker = markerSummary(makeMarkers(document, { ...markerOptions, material: id }).markers[0]); } catch (e) { row.markerError = e.message || String(e); }
    const cutPieces = set.reduce((sum, s) => sum + s.units * s.document.patterns.filter((p) => (p.material || '') === id).reduce((k, p) => k + (p.cut || 1), 0), 0);
    Object.assign(row, { cutPieces, netAreaM2: marker ? round(marker.pieceAreaMm2 / 1e6, 4) : null, rollWidthMm: marker?.widthMm ?? null, rollWidthSource: marker?.widthSource ?? null, markerLengthMm: marker?.lengthMm ?? null, lengthPerUnitMm: marker?.lengthPerUnitMm ?? null, efficiency: marker?.efficiency ?? null });
    const consumedM2 = marker ? marker.widthMm * marker.lengthMm / 1e6 : null;
    Object.assign(row, { consumedAreaM2: round(consumedM2, 4), arealDensity: density, netWeightG: marker && density ? round(marker.pieceAreaMm2 / 1e6 * density, 1) : null, consumedWeightG: marker && density ? round(consumedM2 * density, 1) : null });
    row.cost = !marker ? null : m.pricePerMeter > 0 ? round(m.pricePerMeter * marker.lengthMm / 1000) : m.pricePerSqm > 0 ? round(m.pricePerSqm * consumedM2) : null;
    row.priceBasis = m.pricePerMeter > 0 ? `${m.pricePerMeter} per running metre` : m.pricePerSqm > 0 ? `${m.pricePerSqm} per m²` : null;
    return row;
  });
  // A seam is as long as its shorter side: a gathered or eased side is drawn up to meet it.
  const kinds = new Map();
  for (const s of set) for (const seam of seamLengths(s.document)) { const k = kinds.get(seam.kind) || { kind: seam.kind, count: 0, lengthMm: 0 }; k.count += s.units; k.lengthMm += s.units * Math.min(seam.lengthA, seam.lengthB); kinds.set(seam.kind, k); }
  const rows = (kind) => SEAM_KINDS[kind]?.rows ?? 1;
  const multiplier = (kind) => (typeof threadMultiplier === 'object' && threadMultiplier ? Number(threadMultiplier[kind] ?? (threadMultiplier.default ?? DEFAULT_THREAD_MULTIPLIER) * rows(kind)) : Number(threadMultiplier) * rows(kind));
  const byKind = [...kinds.values()].map((k) => ({ kind: k.kind, count: k.count, lengthMm: round(k.lengthMm), threadMultiplier: multiplier(k.kind), threadMm: round(k.lengthMm * multiplier(k.kind)) }));
  // Elastic is bought by length: each one's relaxed length (its ratio × the cloth it is sewn to), over every unit of every size.
  const elastics = new Map();
  for (const s of set) for (const e of checkPhysics(s.document)) if (e.kind === 'elastic') { const row = elastics.get(e.id) || { kind: 'elastic', id: e.id, count: 0, lengthMm: 0 }; row.count += s.units; row.lengthMm += s.units * e.relaxed; elastics.set(e.id, row); }
  const priced = materials.filter((m) => m.cost != null);
  // A design with trims[] gets one row per trim and per piece of hardware threaded on one, with counts, lengths and cost over every unit
  // (softgoods-trims.js). An elastic no trim points at keeps its place, as a row of the same shape; one a trim points at is that trim's row.
  // Topstitch rows are thread: they join the estimate below. A design without trims[] keeps the bill it always had.
  const trimmed = !!document.trims?.length, pointed = new Set((document.trims || []).map((t) => t.elastic)), costOf = (list) => (list.length ? round(list.reduce((n, x) => n + x.cost, 0)) : null);
  const trims = trimmed ? [...trimsBill(set), ...[...elastics.values()].filter((e) => !pointed.has(e.id)).map((e) => ({ id: e.id, kind: 'elastic', name: e.id, spec: '', where: `elastic ${e.id}`, count: e.count, lengthMm: round(e.lengthMm / e.count), totalLengthMm: round(e.lengthMm), supplier: null, partNumber: null, unitPrice: null, pricePerMeter: null, cost: null }))] : [];
  const pricedTrims = trims.filter((t) => t.cost != null), topstitchMm = topstitchLength(set), seamThreadMm = byKind.reduce((n, k) => n + k.threadMm, 0);
  return {
    units, sizes: set.map((s) => ({ size: s.size, units: s.units })), materials,
    seams: { byKind, totalMm: round(byKind.reduce((sum, k) => sum + k.lengthMm, 0)) },
    thread: topstitchMm
      ? { lengthMm: round(seamThreadMm + topstitchMm * multiplier('topstitch')), multiplier: threadMultiplier, topstitchMm, basis: 'Seam length × multiplier, plus the topstitch rows × multiplier. 2.5 is the rule of thumb for a 301 lockstitch; an estimate, with no allowance for waste, bar tacks or buttonholes.' }
      : { lengthMm: round(seamThreadMm), multiplier: threadMultiplier, basis: 'Seam length × multiplier. 2.5 is the rule of thumb for a 301 lockstitch; an estimate, with no allowance for waste, bar tacks or topstitching.' },
    // Without trims[]: the elastics alone, each by its cut length, as before.
    trims: trimmed ? trims : [...elastics.values()].map((e) => ({ ...e, lengthMm: round(e.lengthMm) })),
    cost: trimmed
      ? { total: priced.length || pricedTrims.length ? round((costOf(priced) || 0) + (costOf(pricedTrims) || 0)) : null, cloth: costOf(priced), trims: costOf(pricedTrims), complete: priced.length === materials.length && pricedTrims.length === trims.length, basis: 'Cloth and trims, in the currency their prices were given in. Cloth: the marker length × the price per running metre, or the roll area it takes × the price per m². A trim: its unitPrice × how many, else its pricePerMeter × its total length.' }
      : { total: priced.length ? round(priced.reduce((sum, m) => sum + m.cost, 0)) : null, complete: priced.length === materials.length, basis: 'Cloth only, in the currency its prices were given in: the marker length × the price per running metre, or the roll area it takes × the price per m².' },
    notes: ['Net area is the cut pieces; consumed area is the marker length × the roll width, which is what is bought.', 'A roll width of 1500 mm is assumed where neither the material (rollWidth) nor the export gives one.', 'The marker is a heuristic lay: a professional nester will usually do a little better, so these lengths are on the safe side.'],
  };
}

const cell = (v, unit = '') => (v == null ? '' : `${esc(v)}${unit}`);
/** The bill as HTML sections, for the tech pack and for the page of its own. */
export function bomHTML(bom) {
  const rows = bom.materials.map((m) => `<tr><td>${esc(m.name)}</td><td>${m.cutPieces}</td><td>${cell(m.netAreaM2)}</td><td>${cell(m.rollWidthMm)}${m.rollWidthSource === 'default' ? ' (assumed)' : ''}</td><td>${m.markerError ? esc(m.markerError) : cell(m.markerLengthMm)}</td><td>${m.efficiency == null ? '' : `${(m.efficiency * 100).toFixed(1)}%`}</td><td>${cell(m.netWeightG)}</td><td>${cell(m.consumedWeightG)}</td><td>${cell(m.cost)}</td></tr>`).join('');
  // With trims the total is cloth and trims together; the cloth's own figure is cost.cloth.
  const cloth = bom.cost.trims !== undefined ? bom.cost.cloth : bom.cost.total;
  const seams = bom.seams.byKind.map((k) => `<tr><td>${esc(k.kind)}</td><td>${k.count}</td><td>${k.lengthMm}</td><td>${k.threadMultiplier}</td><td>${k.threadMm}</td></tr>`).join('');
  return `<h2>BILL OF MATERIALS</h2><p>${bom.units} unit${bom.units > 1 ? 's' : ''}: ${esc(bom.sizes.map((s) => `${s.size} × ${s.units}`).join(', '))}</p><table><tr><th>Material</th><th>Cut pieces</th><th>Net area m²</th><th>Roll width mm</th><th>Marker length mm</th><th>Yield</th><th>Net weight g</th><th>Consumed weight g</th><th>Cost</th></tr>${rows}</table>${cloth == null ? '' : `<p>Cloth cost ${cloth}${bom.cost.trims !== undefined ? (bom.materials.every((m) => m.cost != null) ? '' : ' (some materials have no price)') : bom.cost.complete ? '' : ' (some materials have no price)'}</p>`}<h2>SEAMS AND THREAD</h2><table><tr><th>Seam kind</th><th>Seams</th><th>Length mm</th><th>Thread × seam</th><th>Thread mm</th></tr>${seams}</table><p>Total seam ${bom.seams.totalMm} mm · thread about ${(bom.thread.lengthMm / 1000).toFixed(1)} m. ${esc(bom.thread.basis)}</p><h2>TRIMS</h2>${bom.trims[0]?.where != null ? `<table><tr><th>Trim</th><th>Kind</th><th>Spec</th><th>Count</th><th>Length each mm</th><th>Total length mm</th><th>Supplier, part</th><th>Cost</th></tr>${bom.trims.map((t) => `<tr><td>${esc(t.name)}</td><td>${esc(t.kind)}</td><td>${esc(t.spec)}</td><td>${t.count}</td><td>${cell(t.lengthMm)}${t.lengthVaries ? ' (varies by size)' : ''}</td><td>${cell(t.totalLengthMm)}</td><td>${esc([t.supplier, t.partNumber].filter(Boolean).join(' '))}</td><td>${cell(t.cost)}</td></tr>`).join('')}</table>${bom.cost.trims == null ? '' : `<p>Trims cost ${bom.cost.trims} · total ${bom.cost.total}${bom.cost.complete ? '' : ' (some lines have no price)'}</p>`}` : `<p>${bom.trims.length ? esc(JSON.stringify(bom.trims)) : 'Not modelled yet.'}</p>`}<ul>${bom.notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
}
/** The bill as a page of its own, in the CW&T design system. */
export function bomPage(bom, name = 'softgoods') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(name)} bill of materials</title><style>@font-face{font-family:"Space Mono";font-weight:400;font-style:normal;src:local("Space Mono"),local("SpaceMono-Regular")}*{border-radius:0;font-weight:400;font-style:normal}body{font:400 12px/1.5 "Space Mono",monospace;margin:32px;color:#000000;background:#ffffff}h1{font-size:20px}h2{font-size:14px;margin-top:32px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #000000;padding:6px;text-align:left}@media print{body{margin:12mm}}</style></head><body><h1>${esc(name.toUpperCase())} · BILL OF MATERIALS</h1>${bomHTML(bom)}</body></html>\n`;
}
