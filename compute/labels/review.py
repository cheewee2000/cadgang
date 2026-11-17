#!/usr/bin/env python3
"""Build a self-contained HTML review sheet for Stage 3 part labels.

Reads plain or gzip JSONL from compute/labels/export.mjs. Every rare class is
shown in full; common classes get a deterministic sample. Each card draws
three orthographic point-cloud projections and preserves name/file/size plus
an originalLabel->label correction when present.

  python3 compute/labels/review.py parts.jsonl.gz review.html --rare-under 50 --sample 20
"""
from __future__ import annotations

import argparse
import gzip
import html
import json
import random
from collections import Counter, defaultdict
from pathlib import Path


def records(path: str):
    opener = gzip.open if str(path).lower().endswith('.gz') else open
    with opener(path, 'rt', encoding='utf-8') as src:
        for line in src:
            if not line.strip() or line.startswith('#'):
                continue
            yield json.loads(line)


def projection(points, axes, size=116):
    pts = list(zip(points[0::3], points[1::3], points[2::3]))
    if not pts:
        return ''
    a, b = axes
    xs, ys = [p[a] for p in pts], [p[b] for p in pts]
    lo_x, hi_x, lo_y, hi_y = min(xs), max(xs), min(ys), max(ys)
    span = max(hi_x - lo_x, hi_y - lo_y, 1e-9)
    scale = (size - 10) / span
    ox = (size - (hi_x - lo_x) * scale) / 2 - lo_x * scale
    oy = (size - (hi_y - lo_y) * scale) / 2 + hi_y * scale
    # At most 512 dots; the exporter can repeat vertices when a body is coarse.
    step = max(1, len(pts) // 512)
    dots = []
    seen = set()
    for p in pts[::step]:
        x, y = round(ox + p[a] * scale, 1), round(oy - p[b] * scale, 1)
        key = (x, y)
        if key in seen:
            continue
        seen.add(key)
        dots.append(f'<circle cx="{x}" cy="{y}" r="0.75"/>')
    return f'<svg viewBox="0 0 {size} {size}" aria-hidden="true">{"".join(dots)}</svg>'


def card(row):
    pts = row.get('pts') or row.get('points') or []
    changed = row.get('originalLabel')
    correction = (f'<b class="changed">{html.escape(str(changed))} → {html.escape(str(row["label"]))}</b>'
                  if changed and changed != row['label'] else '')
    dims = ' × '.join(str(x) for x in row.get('size', []))
    return f'''<article>
      <div class="views">{projection(pts, (0, 1))}{projection(pts, (0, 2))}{projection(pts, (1, 2))}</div>
      <h3>{html.escape(str(row.get('name', 'unnamed')))}</h3>
      <p>{correction}</p>
      <p>{html.escape(str(row.get('file', '')))}</p>
      <small>{html.escape(dims)} mm · {int(row.get('nVerts', len(pts)//3))} vertices</small>
    </article>'''


def build(src, out, rare_under=50, sample=20, seed=0):
    by = defaultdict(list)
    for row in records(src):
        by[str(row.get('label', 'unknown'))].append(row)
    rng = random.Random(seed)
    sections = []
    for label in sorted(by, key=lambda k: (len(by[k]), k)):
        rows = by[label]
        if len(rows) >= rare_under and len(rows) > sample:
            shown = sorted(rng.sample(rows, sample), key=lambda r: (str(r.get('file')), str(r.get('name'))))
            note = f'deterministic sample of {len(shown)}'
        else:
            shown = sorted(rows, key=lambda r: (str(r.get('file')), str(r.get('name'))))
            note = 'all examples'
        sections.append(f'<section><h2>{html.escape(label)} · {len(rows)} <span>{note}</span></h2><div class="grid">'
                        + ''.join(card(r) for r in shown) + '</div></section>')
    counts = Counter({k: len(v) for k, v in by.items()})
    doc = f'''<!doctype html><meta charset="utf-8"><title>CADgang part-label review</title>
<style>
@font-face{{font-family:mono;src:local("Space Mono"),local("Menlo")}}*{{box-sizing:border-box}}body{{margin:28px;font:13px mono,monospace;color:#000;background:#fff}}h1{{font-size:22px}}h2{{margin-top:38px;border-bottom:2px solid;padding-bottom:7px;text-transform:uppercase}}h2 span{{font-size:11px;font-weight:normal;float:right}}.summary{{line-height:1.8}}.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(390px,1fr));gap:12px}}article{{border:1px solid;padding:10px;min-width:0}}.views{{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;background:#f5f5f5}}svg{{width:100%;height:auto;background:#fff}}circle{{fill:#000}}h3{{font-size:12px;margin:9px 0 4px;overflow-wrap:anywhere}}p,small{{display:block;margin:3px 0;overflow-wrap:anywhere;color:#444}}.changed{{color:#b00020}}@media print{{body{{margin:8mm}}article{{break-inside:avoid}}}}
</style>
<h1>CADgang part-label review</h1>
<p class="summary"><b>{sum(counts.values())} bodies</b> · {html.escape(str(src))}<br>{' · '.join(f'{html.escape(k)} {v}' for k,v in sorted(counts.items()))}<br>Every class below {rare_under} examples is shown in full; larger classes show a seeded sample. Projections are XY, XZ and YZ.</p>
{''.join(sections)}'''
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    Path(out).write_text(doc, encoding='utf-8')
    print(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('src')
    ap.add_argument('out')
    ap.add_argument('--rare-under', type=int, default=50)
    ap.add_argument('--sample', type=int, default=20)
    ap.add_argument('--seed', type=int, default=0)
    a = ap.parse_args()
    build(a.src, a.out, a.rare_under, a.sample, a.seed)


if __name__ == '__main__':
    main()
