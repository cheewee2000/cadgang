/**
 * The dependency graph, as a read-only picture.
 *
 * In v1 the node graph WAS the document and every edge was something you had to
 * wire by hand. Here it is derived: the stack already says what depends on
 * what, and this only draws it. Nothing in this file can change the document,
 * which is why it can be a glance rather than a mode.
 *
 * It earns its space by showing the three things an ordered list cannot: which
 * cells reach back past their neighbour, which ones nothing downstream
 * consumes, and where the checks hang. In a straight stack it is a straight
 * line, and that is a true and useful thing to see too.
 */

const ROW = 30;      // px between cells vertically
const LANE = 78;     // px between branch columns
const PAD = 14;
const DOT = 4.5;

/**
 * Draw the graph into `container`.
 *
 * `status` maps a cell id to how it evaluated, so the picture agrees with the
 * badges in the stack beside it. `onSelect` scrolls the transcript — the graph
 * is a way of getting to a cell, not a second place to edit one.
 */
export function renderDepGraph(container, { graph, status = new Map(), onSelect }) {
  container.innerHTML = '';
  if (!graph?.nodes?.length) {
    container.innerHTML = '<div class="graph-empty">No cells yet.</div>';
    return;
  }

  const { nodes, edges } = graph;
  const at = new Map(nodes.map((n) => [n.id, n]));
  const x = (n) => PAD + n.lane * LANE;
  const y = (n) => PAD + n.index * ROW;
  const width = PAD * 2 + (graph.lanes || 1) * LANE + 90;
  const height = PAD * 2 + nodes.length * ROW;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.classList.add('depgraph');

  const add = (tag, attrs, cls) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (cls) el.setAttribute('class', cls);
    svg.append(el);
    return el;
  };

  for (const edge of edges) {
    const a = at.get(edge.from);
    const b = at.get(edge.to);
    if (!a || !b) continue;
    const [x1, y1, x2, y2] = [x(a), y(a), x(b), y(b)];
    // Same lane is a straight drop; a lane change bends once, near the child,
    // so the eye reads "this one reached sideways for its input".
    const d = x1 === x2
      ? `M ${x1} ${y1} L ${x2} ${y2}`
      : `M ${x1} ${y1} C ${x1} ${y1 + ROW * 0.6}, ${x2} ${y2 - ROW * 0.6}, ${x2} ${y2}`;
    add('path', { d }, `edge${edge.explicit ? ' explicit' : ''}${b.onTrunk && a.onTrunk ? ' trunk' : ''}`);
  }

  for (const node of nodes) {
    const state = status.get(node.id) || 'ok';
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', `node ${state}${node.onTrunk ? ' trunk' : ''}${node.kind === 'assert' ? ' assert' : ''}`);
    g.dataset.id = node.id;

    const dot = document.createElementNS('http://www.w3.org/2000/svg', node.kind === 'assert' ? 'rect' : 'circle');
    dot.setAttribute('class', 'dot');
    if (node.kind === 'assert') {
      dot.setAttribute('x', x(node) - DOT);
      dot.setAttribute('y', y(node) - DOT);
      dot.setAttribute('width', DOT * 2);
      dot.setAttribute('height', DOT * 2);
    } else {
      dot.setAttribute('cx', x(node));
      dot.setAttribute('cy', y(node));
      dot.setAttribute('r', node.isOutput ? DOT + 2 : DOT);
    }
    g.append(dot);

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', x(node) + 11);
    label.setAttribute('y', y(node) + 4);
    label.textContent = node.isOutput ? `${node.id} →` : node.id;
    g.append(label);

    // A full-width invisible strip, so the whole row is clickable rather than
    // a 9px dot. It carries its own class: styling `.node rect` would paint
    // this one too, since a CSS rule beats a presentation attribute.
    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    hit.setAttribute('class', 'hit');
    hit.setAttribute('x', 0);
    hit.setAttribute('y', y(node) - ROW / 2);
    hit.setAttribute('width', width);
    hit.setAttribute('height', ROW);
    hit.setAttribute('fill', 'transparent');
    g.append(hit);

    g.addEventListener('click', () => onSelect?.(node.id));
    svg.append(g);
  }

  container.append(svg);
}
