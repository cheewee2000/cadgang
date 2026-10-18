/**
 * The sketch canvas — the human half of a sketch cell.
 *
 * A cell's program says what the profile MEANS; this says where it currently
 * sits, and now also what is on it. Dragging a point sends the whole sketch to
 * the server, which pins that point, re-solves, and sends the sketch back — so
 * what you see while dragging is the constraint system's answer, not a preview
 * of it. Only the release writes to the document, because a gesture is one
 * edit, not sixty.
 *
 * Drawing goes the same way and for the same reason: the click positions go to
 * the server, and what comes back is a solved sketch plus a sentence about what
 * the gesture was taken to mean. Nothing about a line, a snap, or an inferred
 * horizontal is decided in here. The one exception is what gets HIGHLIGHTED —
 * the ring on a point about to be shared, the entity about to be erased — which
 * is presentation, and has to be answered before the round trip rather than
 * after it. Where that echoes a rule the server owns (nearest point within the
 * hit radius) it is the same rule with the same tolerance, passed along as
 * `snap` so the two cannot drift apart.
 *
 * The solver deliberately does not run in here. It is the same module the cell
 * evaluates against, and a second copy in the browser would be a second thing
 * to keep true.
 */

const HIT = 7;        // px within which a click grabs a point, or snaps to one
const PAD = 18;       // px of margin around the fitted sketch

// How far the view may be driven. Sketches here are millimetres of real part,
// so the range spans a 2m outline down to a 0.1mm feature filling the card.
const MIN_SCALE = 0.05;
const MAX_SCALE = 2000;
const KEY_ZOOM = 1.25;

const COLOURS = {
  light: { line: '#2f5d8a', point: '#1c1c1a', fixed: '#a33', hint: '#c9c8c4', text: '#6b6a66', ghost: '#8aa8c4', snap: '#3c8f5a', warn: '#a33', dim: '#9a7b3f', param: '#3c7f8f' },
  dark: { line: '#7fb3e0', point: '#e8e7e3', fixed: '#e08a8a', hint: '#3a3936', text: '#8d8c88', ghost: '#5b7d9c', snap: '#6fbd8c', warn: '#e08a8a', dim: '#d3b271', param: '#7fc0d0' },
};

/**
 * The tools, and how many clicks each one takes.
 *
 * A line is two clicks and then keeps going from where it ended, because a
 * profile is a chain and making someone re-pick the corner they just placed is
 * how you end up with two points where there should be one.
 */
const TOOLS = [
  { tool: 'select', key: 'v', label: 'Drag', hint: 'drag a point to move it' },
  { tool: 'line', key: 'l', label: 'Line', clicks: 2, chains: true, hint: 'click each corner · Esc to stop' },
  { tool: 'rect', key: 'r', label: 'Rect', clicks: 2, hint: 'click two opposite corners' },
  { tool: 'circle', key: 'c', label: 'Circle', clicks: 2, hint: 'click the centre, then the rim' },
  { tool: 'arc', key: 'a', label: 'Arc', clicks: 3, hint: 'centre, then both ends counter-clockwise' },
  { tool: 'dim', key: 'd', label: 'Dim', clicks: 1, hint: 'click a line, a circle, a dimension — or two points' },
  { tool: 'erase', key: 'x', label: 'Erase', clicks: 1, hint: 'click geometry or a dimension to remove it' },
];

const spec = (tool) => TOOLS.find((t) => t.tool === tool);

/**
 * Mount a canvas for one cell's sketch.
 *
 * `solve`, `save`, `draw` and `erase` are passed in rather than reached for, so
 * this module knows about geometry and pointers and nothing about the API.
 */
export function sketchCanvas({ sketch, canvas, note, tools, ui = {}, solve, save, draw, erase, dimension }) {
  const ctx = canvas.getContext('2d');
  let current = sketch;
  // The view is remembered with the gesture, and for the same reason: a canvas
  // that re-fits itself on every re-mount would move the geometry out from
  // under the pointer whenever anything else on the page changed.
  const hadView = Boolean(ui.view);
  const view = ui.view || (ui.view = { scale: 1, ox: 0, oy: 0 });
  let dragging = null;
  let inFlight = false;
  let queued = null;

  // The tool and the half-finished gesture live in `ui`, which belongs to the
  // page rather than to this canvas. The stack re-renders whenever the document
  // changes — including from another tab, or from Claude editing a cell three
  // rows up — and a mounted canvas does not survive that. Keeping the state
  // outside means a re-render mid-chain costs a repaint instead of the corner
  // you were about to draw from.
  let tool = ui.tool || 'select';
  let stage = ui.stage || [];  // clicks already placed in the gesture under way
  let pointer = null;    // where the pointer is now, in sketch units
  let busy = false;      // a draw is in flight; ignore clicks until it lands
  let said = null;       // what the last draw was understood to mean
  let lastReport = null; // the newest solve report, so a tool change can restate it
  let framed = hadView;  // whether the view has been computed against a real size
  let labels = [];       // dimension labels in screen space, for hit-testing
  let asking = null;     // the value input open over the note bar, if any
  let panning = null;    // the last pointer position while dragging the view
  let spaceDown = false; // space held, which turns any drag into a pan

  const snapRadius = () => HIT / view.scale;

  /** Hand the gesture back to the page, so the next mount can pick it up. */
  function remember() {
    ui.tool = tool;
    ui.stage = stage;
  }

  /**
   * Match the drawing buffer to the element's real size.
   *
   * A canvas has two sizes and getting them apart is how you get ellipses out
   * of circles. This runs before every paint rather than only at mount, because
   * at mount the card is still detached — `clientWidth` is 0, and anything
   * derived from it is a guess that then gets stretched to whatever width the
   * panel turns out to be. Returns false while the element has no layout yet,
   * which is the signal to try again on the next frame rather than to invent a
   * size.
   */
  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return false;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    // Assigning either dimension clears the canvas, so only do it on a change.
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  function fit() {
    if (!resize()) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    framed = true;

    const box = bounds(current);
    const scale = Math.min(
      (w - PAD * 2) / Math.max(box.w, 1e-6),
      (h - PAD * 2) / Math.max(box.h, 1e-6)
    );
    // A sketch of a single point has no extent to fit to; cap the zoom so it
    // does not arrive at 10000× and look like a blank canvas.
    view.scale = Math.min(scale, 40);
    view.ox = w / 2 - (box.x + box.w / 2) * view.scale;
    view.oy = h / 2 + (box.y + box.h / 2) * view.scale;
  }

  const toScreen = ([x, y]) => [x * view.scale + view.ox, -y * view.scale + view.oy];
  const toSketch = (px, py) => [(px - view.ox) / view.scale, (view.oy - py) / view.scale];

  /**
   * Once the view has been driven by hand, stop auto-fitting it.
   *
   * Automatic framing and a person holding the view are the same authority
   * pointed at the same two numbers, and the automatic one must lose: a canvas
   * that re-centres itself after you deliberately zoomed into a corner is
   * fighting you. FIT is how you hand it back.
   */
  function pinView() {
    ui.pinned = true;
  }

  /** Zoom about a point on screen, so what is under the pointer stays there. */
  function zoomAt(px, py, factor) {
    const [sx, sy] = toSketch(px, py);
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
    if (next === view.scale) return;
    view.scale = next;
    view.ox = px - sx * view.scale;
    view.oy = py + sy * view.scale;
    pinView();
  }

  function panBy(dx, dy) {
    view.ox += dx;
    view.oy += dy;
    pinView();
  }

  /** Re-frame on the whole sketch, and let it look after itself again. */
  function fitAll() {
    ui.pinned = false;
    fit();
    draw2d();
  }

  /**
   * Re-fit only when the sketch has actually left the frame, and never while a
   * gesture is half-placed.
   *
   * Re-fitting after every line is the difference between drawing a profile and
   * chasing one: the corner you are aiming at moves out from under the pointer
   * between the click that placed it and the click that should share it.
   */
  function fitIfNeeded() {
    if (!framed) { fit(); return; }
    if (ui.pinned || stage.length) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const b = bounds(current);
    const [left, bottom] = toScreen([b.x, b.y]);
    const [right, top] = toScreen([b.x + b.w, b.y + b.h]);
    if (left < 0 || top < 0 || right > w || bottom > h) fit();
  }

  function draw2d() {
    // The element may still be waiting for layout — at mount the card has not
    // been appended yet. Come back next frame rather than painting into a
    // buffer sized from a guess.
    if (!resize()) { requestAnimationFrame(draw2d); return; }
    if (!framed) fit();
    const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    const c = COLOURS[theme];
    const w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);

    // Origin cross: a sketch is placed on a plane, and where the origin sits
    // relative to the profile is what decides where the solid lands.
    const [ox, oy] = toScreen([0, 0]);
    ctx.strokeStyle = c.hint;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ox - 10, oy); ctx.lineTo(ox + 10, oy);
    ctx.moveTo(ox, oy - 10); ctx.lineTo(ox, oy + 10);
    ctx.stroke();

    const overLabel = pointer && (tool === 'erase' || tool === 'dim')
      ? labelAt(...toScreen(pointer))
      : -1;
    const doomedLabel = tool === 'erase' ? overLabel : -1;
    const doomed = tool === 'erase' && pointer && overLabel < 0
      ? entityAt(pointer[0], pointer[1])
      : null;

    (current.entities || []).forEach((e, i) => {
      ctx.strokeStyle = i === doomed ? c.warn : c.line;
      ctx.lineWidth = i === doomed ? 3 : 1.6;
      ctx.beginPath();
      traceEntity(e);
      ctx.stroke();
    });

    (current.points || []).forEach((p, i) => {
      const [px, py] = toScreen([p.x, p.y]);
      ctx.fillStyle = p.fixed ? c.fixed : c.point;
      if (p.fixed) {
        ctx.fillRect(px - 3, py - 3, 6, 6); // pinned points read as squares
      } else {
        ctx.beginPath();
        ctx.arc(px, py, dragging?.point === i ? 5 : 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    drawDimensions(c, doomedLabel);

    // The dim tool stages a POINT rather than a position, so it marks the point
    // it is measuring from instead of rubber-banding to the pointer.
    if (tool === 'dim') {
      for (const s of stage) {
        const p = current.points?.[s.point];
        if (!p) continue;
        const [sx, sy] = toScreen([p.x, p.y]);
        ctx.strokeStyle = c.dim;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(sx, sy, 6.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    } else if (tool !== 'select' && tool !== 'erase') {
      drawPending(c);
    }

    // The snap ring is the promise this canvas makes before the round trip: put
    // the click here and it will BE that point, not a new one on top of it.
    const snapped = pointer && tool !== 'select' && tool !== 'erase'
      ? pointAt(pointer[0], pointer[1])
      : -1;
    if (snapped >= 0) {
      const [sx, sy] = toScreen([current.points[snapped].x, current.points[snapped].y]);
      ctx.strokeStyle = c.snap;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(sx, sy, 6.5, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  /** One entity's path, in screen space, ready to stroke. */
  function traceEntity(e) {
    if (e.type === 'line') {
      ctx.moveTo(...toScreen(xy(current, e.a)));
      ctx.lineTo(...toScreen(xy(current, e.b)));
    } else if (e.type === 'circle') {
      const [cx, cy] = toScreen(xy(current, e.c));
      ctx.arc(cx, cy, Math.abs(e.r) * view.scale, 0, Math.PI * 2);
    } else if (e.type === 'arc') {
      const centre = xy(current, e.c);
      const [cx, cy] = toScreen(centre);
      const r = Math.hypot(xy(current, e.a)[0] - centre[0], xy(current, e.a)[1] - centre[1]);
      // Canvas y grows downward, so a counter-clockwise sketch arc is drawn
      // clockwise here — hence the flipped angles and the `true`.
      const a0 = -Math.atan2(xy(current, e.a)[1] - centre[1], xy(current, e.a)[0] - centre[0]);
      const a1 = -Math.atan2(xy(current, e.b)[1] - centre[1], xy(current, e.b)[0] - centre[0]);
      ctx.arc(cx, cy, r * view.scale, a0, a1, true);
    }
  }

  /**
   * Draw the dimensions, and remember where their labels landed.
   *
   * A dimension you cannot see is a rule the sketch obeys for reasons nobody
   * can read, so every constraint carrying a value gets a label. The label is
   * also the handle: `labels` is what the dim and erase tools hit-test against,
   * so what you click is by construction the thing that was drawn.
   *
   * A value that names a PARAMETER is coloured differently and shown by name.
   * That difference is the whole point of the feature — 40 is a number someone
   * typed, `width` is a number the slider owns — and it should be visible at a
   * glance rather than by clicking.
   */
  function drawDimensions(c, doomedLabel) {
    labels = [];
    ctx.save();
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    (current.constraints || []).forEach((con, i) => {
      const named = typeof con.value === 'string';
      const text = named ? con.value : formatValue(con.value);
      const prefix = con.type === 'radius' ? 'R' : con.type === 'diameter' ? '⌀' :
        con.type === 'distanceX' ? '↔' : con.type === 'distanceY' ? '↕' : '';
      const shown = prefix + text;
      const width = ctx.measureText(shown).width;
      // Half the text's own width is part of the offset, or a long label sits
      // on top of the edge it is describing instead of beside it.
      const spot = dimensionAnchor(con, width / 2);
      if (!spot) return;
      const rect = { x: spot.x - width / 2 - 3, y: spot.y - 7, w: width + 6, h: 14 };
      labels.push({ constraint: i, ...rect, value: con.value, type: con.type });

      // A leader from the geometry to the label, so a label floating near two
      // edges still says which one it is about.
      ctx.strokeStyle = c.hint;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(spot.from[0], spot.from[1]);
      ctx.lineTo(spot.x, spot.y);
      ctx.stroke();

      // Punch the label out of whatever it lands on: at this size a value
      // crossed by an edge is unreadable.
      ctx.clearRect(rect.x, rect.y, rect.w, rect.h);
      ctx.fillStyle = i === doomedLabel ? c.warn : (named ? c.param : c.dim);
      ctx.fillText(shown, spot.x, spot.y);
    });
    ctx.restore();
  }

  /** Where one constraint's label goes, and what it points at. */
  function dimensionAnchor(con, pad = 0) {
    const P = (i) => current.points?.[i];
    const OFFSET = 12 + pad;

    if (con.type === 'radius' || con.type === 'diameter') {
      const e = current.entities?.[con.e];
      if (!e || (e.type !== 'circle' && e.type !== 'arc')) return null;
      const centre = P(e.c);
      if (!centre) return null;
      const r = e.type === 'circle'
        ? Math.abs(e.r)
        : Math.hypot(P(e.a).x - centre.x, P(e.a).y - centre.y);
      const from = toScreen([centre.x, centre.y]);
      const rim = toScreen([centre.x + r * 0.7071, centre.y + r * 0.7071]);
      // Pushed a little further out along the same diagonal, so the value sits
      // outside the circle rather than across its rim.
      const away = Math.hypot(rim[0] - from[0], rim[1] - from[1]) || 1;
      return {
        from,
        x: rim[0] + ((rim[0] - from[0]) / away) * pad,
        y: rim[1] + ((rim[1] - from[1]) / away) * pad,
      };
    }

    let a, b;
    if (con.e !== undefined && con.a === undefined) {
      const e = current.entities?.[con.e];
      if (!e || e.type !== 'line') return null;
      a = P(e.a); b = P(e.b);
    } else {
      a = P(con.a); b = P(con.b);
    }
    if (!a || !b) return null;
    if (!['distance', 'distanceX', 'distanceY'].includes(con.type)) return null;

    const sa = toScreen([a.x, a.y]);
    const sb = toScreen([b.x, b.y]);
    const mid = [(sa[0] + sb[0]) / 2, (sa[1] + sb[1]) / 2];
    const len = Math.hypot(sb[0] - sa[0], sb[1] - sa[1]) || 1;
    const perp = [-(sb[1] - sa[1]) / len, (sb[0] - sa[0]) / len];
    return {
      from: mid,
      x: mid[0] + perp[0] * OFFSET,
      y: mid[1] + perp[1] * OFFSET,
    };
  }

  /** The dimension label under a screen position, or -1. */
  function labelAt(px, py) {
    for (let i = labels.length - 1; i >= 0; i--) {
      const l = labels[i];
      if (px >= l.x && px <= l.x + l.w && py >= l.y && py <= l.y + l.h) return l.constraint;
    }
    return -1;
  }

  /** The gesture under way, drawn as it would land if the next click happened. */
  function drawPending(c) {
    if (!stage.length || !pointer) return;
    ctx.save();
    ctx.strokeStyle = c.ghost;
    ctx.lineWidth = 1.4;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    const p = stage.map(toScreen);
    const at = toScreen(pointer);
    if (tool === 'line') {
      ctx.moveTo(...p[0]); ctx.lineTo(...at);
    } else if (tool === 'rect') {
      ctx.rect(p[0][0], p[0][1], at[0] - p[0][0], at[1] - p[0][1]);
    } else if (tool === 'circle') {
      ctx.arc(p[0][0], p[0][1], Math.hypot(at[0] - p[0][0], at[1] - p[0][1]), 0, Math.PI * 2);
    } else if (tool === 'arc') {
      if (stage.length === 1) {
        ctx.moveTo(...p[0]); ctx.lineTo(...at);
      } else {
        const r = Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]);
        const a0 = Math.atan2(p[1][1] - p[0][1], p[1][0] - p[0][0]);
        const a1 = Math.atan2(at[1] - p[0][1], at[0] - p[0][0]);
        ctx.arc(p[0][0], p[0][1], r, a0, a1, true);
      }
    }
    ctx.stroke();
    ctx.restore();

    // Where the clicks already landed, so a three-click arc shows its progress.
    ctx.fillStyle = c.ghost;
    for (const [sx, sy] of p) {
      ctx.beginPath();
      ctx.arc(sx, sy, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /**
   * Ask the server to re-solve with the point where the pointer is.
   *
   * Coalesced the same way parameter scrubbing is: only the newest position is
   * ever in flight, and one queued behind it. Anything more and a fast drag
   * would render poses the pointer left behind seconds ago.
   */
  async function requestSolve(move) {
    if (inFlight) { queued = move; return; }
    inFlight = true;
    try {
      const result = await solve({ sketch: current, move });
      current = result.sketch;
      report(result);
      draw2d();
    } catch (e) {
      report({ error: e.message });
    } finally {
      inFlight = false;
      if (queued) { const next = queued; queued = null; requestSolve(next); }
    }
  }

  function report(result) {
    if (!note) return;
    if (result?.error) { note.textContent = result.error; note.className = 'sketch-note err'; return; }
    if (result?.report) lastReport = result.report;
    const r = lastReport || {};
    const bits = [];
    if (said) bits.push(said);
    else if (tool !== 'select') bits.push(spec(tool).hint);
    bits.push(`${r.dof ?? '?'} dof`);
    if (r.redundant) bits.push(`${r.redundant} redundant`);
    if (result?.pinned === false && dragging) bits.push('held by constraints');
    note.textContent = bits.join(' · ');
    note.className = 'sketch-note';
  }

  /** The point within the hit radius of a position — the server's rule, echoed. */
  function pointAt(x, y) {
    let best = -1;
    let bestD = snapRadius();
    (current.points || []).forEach((p, i) => {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d <= bestD) { bestD = d; best = i; }
    });
    return best;
  }

  /**
   * The entity under a position, for the erase highlight.
   *
   * Presentation only — what actually gets erased is the index this sends, so
   * the thing highlighted and the thing removed are the same by construction.
   */
  function entityAt(x, y) {
    const tol = snapRadius() * 1.6;
    let best = -1;
    let bestD = tol;
    (current.entities || []).forEach((e, i) => {
      const d = distanceToEntity(current, e, x, y);
      if (d !== null && d <= bestD) { bestD = d; best = i; }
    });
    return best;
  }

  function nearestPoint(px, py) {
    const [x, y] = toSketch(px, py);
    return pointAt(x, y);
  }

  const at = (e) => {
    const rect = canvas.getBoundingClientRect();
    return toSketch(e.clientX - rect.left, e.clientY - rect.top);
  };

  // ------------------------------------------------------------------ gestures

  async function commit(op) {
    busy = true;
    try {
      const result = await draw({ sketch: current, op, snap: snapRadius() });
      current = result.sketch;
      const meant = [...(result.inferred || [])];
      if (result.dropped?.length) meant.push(`${result.dropped.join(', ')} would not hold`);
      said = meant.length ? meant.join(' · ') : null;
      fitIfNeeded();
      report(result);
      draw2d();
    } catch (e) {
      said = null;
      stage = [];
      remember();
      report({ error: e.message });
      draw2d();
    } finally {
      busy = false;
    }
  }

  /**
   * Ask for a dimension's value in the note bar.
   *
   * Prefilled with what the geometry currently measures, so accepting it
   * without typing means "hold it where I drew it" — which is the common case
   * and should cost one keystroke. A NAME may be typed instead of a number;
   * the server checks it against the cell's params and says which exist when
   * it does not, so the field does not have to know about them.
   */
  function askValue(prompt, initial, apply) {
    if (!note) return;
    cancelAsk();
    note.textContent = '';
    note.className = 'sketch-note';
    const label = document.createElement('span');
    label.textContent = `${prompt} `;
    const input = document.createElement('input');
    input.className = 'sketch-dim-input';
    input.value = initial;
    input.spellcheck = false;
    input.title = 'a number, or the name of one of this cell\'s parameters';
    const hint = document.createElement('span');
    hint.className = 'sketch-dim-hint';
    hint.textContent = ' ⏎ apply · esc cancel · a param name binds it to the slider';
    note.append(label, input, hint);
    asking = { input };

    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // the canvas's own shortcuts must not eat the typing
      if (e.key === 'Enter') {
        const value = input.value.trim();
        cancelAsk();
        apply(value);
      } else if (e.key === 'Escape') {
        cancelAsk();
        report(null);
        canvas.focus();
      }
    });
    input.addEventListener('blur', () => {
      // Clicking back onto the canvas abandons the dimension rather than
      // leaving a field open that no longer has anything to do with the tool.
      if (asking?.input === input) { cancelAsk(); report(null); }
    });
    input.focus();
    input.select();
  }

  function cancelAsk() {
    if (!asking) return;
    asking = null;
    if (note) note.textContent = '';
  }

  /** Apply a dimension, and say what it did or why it could not. */
  async function applyDimension(op, value) {
    busy = true;
    try {
      const result = await dimension({ sketch: current, op: { ...op, value } });
      current = result.sketch;
      said = result.redundant
        ? `${result.applied} — but you had already said that`
        : `${result.applied} ${value}`;
      fitIfNeeded();
      report(result);
      draw2d();
    } catch (e) {
      said = null;
      report({ error: e.message });
      draw2d();
    } finally {
      busy = false;
    }
  }

  /** What the geometry measures now, as the field's starting value. */
  function measured(op) {
    const P = (i) => current.points[i];
    if (Number.isInteger(op.entity)) {
      const e = current.entities[op.entity];
      if (e.type === 'line') return Math.hypot(P(e.b).x - P(e.a).x, P(e.b).y - P(e.a).y);
      if (e.type === 'circle') return Math.abs(e.r);
      return Math.hypot(P(e.a).x - P(e.c).x, P(e.a).y - P(e.c).y);
    }
    const [a, b] = op.points;
    return Math.hypot(P(b).x - P(a).x, P(b).y - P(a).y);
  }

  /** The dim tool: name a length, a radius, or a gap — or retype one. */
  function dimensionAt(p) {
    const hitLabel = labelAt(...toScreen(p));
    if (hitLabel >= 0) {
      const con = current.constraints[hitLabel];
      stage = [];
      remember();
      askValue(
        `${con.type} =`,
        typeof con.value === 'string' ? con.value : formatValue(con.value),
        (value) => applyDimension({ constraint: hitLabel }, value)
      );
      return;
    }

    // A point starts a gap between two points; anything else dimensions itself.
    const hitPoint = pointAt(p[0], p[1]);
    if (hitPoint >= 0) {
      if (stage.length && stage[0].point === hitPoint) return; // the same point twice
      if (!stage.length) {
        stage = [{ point: hitPoint }];
        remember();
        draw2d();
        return;
      }
      const op = { points: [stage[0].point, hitPoint] };
      stage = [];
      remember();
      askValue('distance =', formatValue(measured(op)), (value) => applyDimension(op, value));
      return;
    }

    const hitEntity = entityAt(p[0], p[1]);
    if (hitEntity < 0) return;
    const op = { entity: hitEntity };
    const kind = current.entities[hitEntity].type === 'line' ? 'length' : 'radius';
    stage = [];
    remember();
    askValue(`${kind} =`, formatValue(measured(op)), (value) => applyDimension(op, value));
  }

  async function place(p) {
    const s = spec(tool);
    if (tool === 'dim') { dimensionAt(p); return; }
    if (tool === 'erase') {
      // A dimension label wins over the geometry under it: a label is small and
      // deliberately aimed at, and removing the line when someone meant to
      // remove its dimension is the more expensive mistake.
      const con = labelAt(...toScreen(p));
      const i = con >= 0 ? -1 : entityAt(p[0], p[1]);
      if (con < 0 && i < 0) return;
      busy = true;
      try {
        const result = await erase(con >= 0
          ? { sketch: current, constraint: con }
          : { sketch: current, entity: i });
        current = result.sketch;
        said = null;
        fitIfNeeded();
        report(result);
        draw2d();
      } catch (e) {
        report({ error: e.message });
      } finally {
        busy = false;
      }
      return;
    }

    stage.push(p);
    remember();
    if (stage.length < s.clicks) { draw2d(); return; }

    const op = tool === 'line' ? { tool: 'line', from: stage[0], to: stage[1] }
      : tool === 'rect' ? { tool: 'rect', from: stage[0], to: stage[1] }
      : tool === 'circle' ? { tool: 'circle', center: stage[0], through: stage[1] }
      : { tool: 'arc', center: stage[0], from: stage[1], to: stage[2] };

    // A chained tool carries on from the corner just placed, so a four-sided
    // profile is five clicks rather than eight — and the shared corners are
    // shared because they are literally the same click.
    const last = stage[stage.length - 1];
    stage = s.chains ? [last] : [];
    remember();
    await commit(op);
  }

  /** Show which tool is in force. Separate from choosing one, so a re-mount can
   *  restore a gesture rather than cancelling it. */
  function paintTools() {
    canvas.style.cursor = tool === 'select' ? 'default' : 'crosshair';
    if (tools) {
      for (const b of tools.querySelectorAll('button')) {
        b.classList.toggle('active', b.dataset.tool === tool);
      }
    }
  }

  function setTool(next) {
    tool = next;
    stage = [];
    said = null;
    remember();
    paintTools();
    report(null);
    draw2d();
  }

  if (tools) {
    tools.innerHTML = '';
    for (const t of TOOLS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sketch-tool';
      b.dataset.tool = t.tool;
      b.textContent = t.label;
      b.title = `${t.hint} (${t.key})`;
      b.onclick = () => { setTool(t.tool); canvas.focus(); };
      tools.append(b);
    }
    // Fit is not a tool — it does not change what a click means, it puts the
    // view back — so it sits apart from them and never takes the highlight.
    const f = document.createElement('button');
    f.type = 'button';
    f.className = 'sketch-tool sketch-fit';
    f.textContent = 'Fit';
    f.title = 'frame the whole sketch (f) · ⌘-scroll or pinch to zoom · ' +
      'space-drag, middle-drag, or drag the background to pan';
    f.onclick = () => { fitAll(); canvas.focus(); };
    tools.append(f);
  }

  // The panel is resizable and the card is laid out after this runs, so the
  // element's size is something to be told about rather than measured once.
  // A resize genuinely changes the frame, so it re-fits even mid-gesture.
  let boxWidth = 0, boxHeight = 0;
  new ResizeObserver(() => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h || (w === boxWidth && h === boxHeight)) return;
    boxWidth = w; boxHeight = h;
    // A held view survives the panel being dragged: the frame changed, but not
    // the person's mind about where they were looking. And a REMOUNT at the
    // same size — every persisted draw re-renders the stack — is not a resize
    // at all: re-fitting there moves the corner out from under the pointer.
    const sameFrame = ui.frame && ui.frame[0] === w && ui.frame[1] === h;
    if (!ui.pinned && !(sameFrame && hadView)) fit();
    ui.frame = [w, h];
    draw2d();
  }).observe(canvas);

  canvas.tabIndex = 0;
  canvas.addEventListener('focus', () => { ui.focused = true; });
  // A canvas being torn out of the page blurs on its way out. That is the
  // re-render, not the person looking away, so it must not count as putting
  // the keyboard down.
  canvas.addEventListener('blur', () => { if (canvas.isConnected) ui.focused = false; });
  canvas.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === ' ') {
      // Held, not pressed: space is a modifier here, and it must not scroll the
      // transcript out from under the sketch while it is down.
      spaceDown = true;
      canvas.style.cursor = 'grab';
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      // First Escape abandons the gesture, a second one puts the tool down.
      if (stage.length) { stage = []; remember(); draw2d(); }
      else setTool('select');
      e.preventDefault();
      return;
    }
    if (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_') {
      const into = e.key === '+' || e.key === '=';
      zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, into ? KEY_ZOOM : 1 / KEY_ZOOM);
      draw2d();
      e.preventDefault();
      return;
    }
    if (e.key === '0' || e.key === 'f') { fitAll(); e.preventDefault(); return; }
    const t = TOOLS.find((x) => x.key === e.key.toLowerCase());
    if (t) { setTool(t.tool); e.preventDefault(); }
  });

  canvas.addEventListener('keyup', (e) => {
    if (e.key !== ' ') return;
    spaceDown = false;
    if (!panning) paintTools(); // restores the tool's own cursor
  });

  /**
   * Zoom on pinch, and on ⌘/ctrl-scroll — but never on a plain scroll.
   *
   * This canvas sits inside a stack that scrolls, and a plain two-finger scroll
   * over it has to keep scrolling the page. A canvas that swallowed it would
   * trap the cursor: you would reach a sketch on the way down the transcript
   * and the document would stop moving. macOS reports a pinch as a wheel event
   * with ctrlKey set, so the gesture people expect arrives on the same path.
   */
  canvas.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.01));
    draw2d();
  }, { passive: false });

  canvas.addEventListener('contextmenu', (e) => {
    if (panning) e.preventDefault();
  });

  canvas.addEventListener('pointerdown', (e) => {
    canvas.focus();

    // Panning, in order of how deliberate the gesture is: the middle button and
    // space-drag work under every tool, and in DRAG mode a press on empty space
    // pans too — there is nothing else for it to mean, and it is the one people
    // try first.
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const emptyInSelect = tool === 'select' && e.button === 0 && nearestPoint(px, py) < 0;
    if (e.button === 1 || spaceDown || emptyInSelect) {
      panning = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture?.(e.pointerId);
      canvas.style.cursor = 'grabbing';
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.button !== 0) return;

    if (tool !== 'select') {
      if (busy) return;
      e.preventDefault();
      e.stopPropagation();
      place(at(e));
      return;
    }
    const i = nearestPoint(px, py);
    if (i < 0) return;
    dragging = { point: i };
    canvas.setPointerCapture?.(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (panning) {
      panBy(e.clientX - panning.x, e.clientY - panning.y);
      panning = { x: e.clientX, y: e.clientY };
      draw2d();
      return;
    }
    if (tool !== 'select') {
      pointer = at(e);
      draw2d();
      return;
    }
    if (!dragging) return;
    const [x, y] = at(e);
    requestSolve({ point: dragging.point, x, y });
  });

  canvas.addEventListener('pointerleave', () => {
    if (tool === 'select') return;
    pointer = null;
    draw2d();
  });

  const release = async () => {
    if (panning) {
      panning = null;
      canvas.style.cursor = spaceDown ? 'grab' : (tool === 'select' ? 'default' : 'crosshair');
      return;
    }
    if (!dragging) return;
    dragging = null;
    draw2d();
    try {
      await save(current);
    } catch (e) {
      report({ error: e.message });
    }
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  // Pick up wherever the last mount of this cell's canvas left off — including
  // the keyboard, since a chain driven by shortcuts should not need re-clicking
  // into every time the document changes underneath it.
  if (hadView) fitIfNeeded(); else fit();
  paintTools();
  report(null);
  draw2d();
  if (ui.focused) canvas.focus();
  requestSolve(null);

  return {
    /** Re-solve and redraw after something outside changed — a parameter, say. */
    async refresh(next) {
      if (dragging || busy) return; // never yank the geometry out from under a hand
      if (next) current = next;
      fitIfNeeded();
      await requestSolve(null);
      fitIfNeeded();
      draw2d();
    },
    redraw() { if (!ui.pinned) fit(); draw2d(); },
  };
}

/** Dimensions read as drawings, not as floats: 40, 6.5, 12.75. */
function formatValue(v) {
  if (typeof v === 'string') return v;
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return String(Math.round(n * 100) / 100);
}

function xy(sketch, i) {
  const p = sketch.points?.[i];
  return p ? [p.x, p.y] : [0, 0];
}

/** Distance from a position to an entity, or null if it is not that kind. */
function distanceToEntity(sketch, e, x, y) {
  const P = (i) => sketch.points[i];
  if (e.type === 'line') {
    const a = P(e.a), b = P(e.b);
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-12) return null;
    const t = Math.min(1, Math.max(0, ((x - a.x) * dx + (y - a.y) * dy) / len2));
    return Math.hypot(a.x + t * dx - x, a.y + t * dy - y);
  }
  if (e.type === 'circle' || e.type === 'arc') {
    const c = P(e.c);
    const r = e.type === 'circle'
      ? Math.abs(e.r)
      : Math.hypot(P(e.a).x - c.x, P(e.a).y - c.y);
    return Math.abs(Math.hypot(x - c.x, y - c.y) - r);
  }
  return null;
}

/** How wide an empty sketch's canvas is, in sketch units. */
const BLANK_SPAN = 100;

/**
 * Extent of the sketch including circle and arc radii, never zero-sized.
 *
 * A sketch with nothing in it yet gets a fixed span rather than a degenerate
 * one. It is a guess, but it is the guess that makes the first rectangle
 * someone draws land inside the view — and a view that does not have to jump
 * after the first line is what lets the second one be aimed at the first.
 */
function bounds(sketch) {
  if (!sketch.entities?.length && (sketch.points?.length ?? 0) < 2) {
    const p = sketch.points?.[0];
    return {
      x: (p?.x ?? 0) - BLANK_SPAN / 2,
      y: (p?.y ?? 0) - BLANK_SPAN / 2,
      w: BLANK_SPAN,
      h: BLANK_SPAN,
    };
  }
  let minX = 0, minY = 0, maxX = 0, maxY = 0;
  let any = false;
  const see = (x, y) => {
    if (!any) { minX = maxX = x; minY = maxY = y; any = true; return; }
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  };
  for (const p of sketch.points || []) see(p.x, p.y);
  for (const e of sketch.entities || []) {
    if (e.type !== 'circle') continue;
    const [cx, cy] = xy(sketch, e.c);
    see(cx - e.r, cy - e.r);
    see(cx + e.r, cy + e.r);
  }
  return { x: minX, y: minY, w: Math.max(maxX - minX, 1), h: Math.max(maxY - minY, 1) };
}
