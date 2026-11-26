#!/usr/bin/env python3
"""Rank completed joint architecture runs by product-facing confidence, type and axis metrics."""
from __future__ import annotations
import csv, json, os, sys
from pathlib import Path


def atomic(path, text):
    path = Path(path); tmp = path.with_suffix(path.suffix + f'.{os.getpid()}.tmp')
    tmp.write_text(text, encoding='utf-8'); os.replace(tmp, path)


def main(root):
    root = Path(root); (root / 'reports').mkdir(parents=True, exist_ok=True)
    rows = []
    for p in sorted((root / 'reports').glob('*-e*.json')):
        try:
            o = json.loads(p.read_text()); m, i = o['metrics'], o['info']
            tag, ep = p.stem.rsplit('-e', 1); c = m.get('confidence', {}).get('0.9', {})
            ax = m.get('axis', {})
            rows.append(dict(run=p.stem, architecture=tag, epochs=int(ep), accuracy=m.get('accuracy'),
                macro_f1=m.get('macro_f1'), axis_median=m.get('axis_all', {}).get('median'),
                revolute_recall=m.get('per_class', {}).get('REVOLUTE', {}).get('recall'),
                cylindrical_recall=m.get('per_class', {}).get('CYLINDRICAL', {}).get('recall'),
                slider_recall=m.get('per_class', {}).get('SLIDER', {}).get('recall'),
                planar_recall=m.get('per_class', {}).get('PLANAR', {}).get('recall'),
                p90_precision=c.get('precision'), p90_coverage=c.get('coverage'),
                calibration_ece=m.get('calibration_ece'), temperature=m.get('temperature'), score=m.get('score'),
                beats_rev=ax.get('REVOLUTE', {}).get('beats_solver_all_pairs'),
                beats_cyl=ax.get('CYLINDRICAL', {}).get('beats_solver_all_pairs'),
                beats_slider=ax.get('SLIDER', {}).get('beats_solver_all_pairs'),
                checkpoint=i.get('checkpoint'), report=str(p.with_suffix('.md'))))
        except (OSError, ValueError, KeyError): pass
    rows.sort(key=lambda r: (-(r['p90_coverage'] or 0) if (r['p90_precision'] or 0) >= .95 else 1,
                             -(r['score'] or 0), r['run']))
    atomic(root/'summary.json', json.dumps({'baseline': {'accuracy': .646, 'p90_precision': .9772,
           'p90_coverage': .0926, 'axis_median': 3.24}, 'runs': rows}, indent=2)+'\n')
    fields = list(rows[0]) if rows else ['run']; tmp=root/f'summary.csv.{os.getpid()}.tmp'
    with tmp.open('w', newline='', encoding='utf-8') as f:
        w=csv.DictWriter(f, fields); w.writeheader(); w.writerows(rows)
    os.replace(tmp, root/'summary.csv')
    L=['# CADgang supervised joint architecture sweep','',
       'Baseline: 64.6% accuracy; 97.72% precision at 9.26% coverage for p≥0.90; 3.24° median axis error.','',
       '| run | accuracy | macro F1 | axis median | p≥.90 precision | p≥.90 coverage | rev recall | cyl recall | planar recall |',
       '|---|---:|---:|---:|---:|---:|---:|---:|---:|']
    f=lambda x:'–' if x is None else f'{x:.4f}'
    for r in rows: L.append(f"| {r['run']} | {f(r['accuracy'])} | {f(r['macro_f1'])} | {f(r['axis_median'])} | {f(r['p90_precision'])} | {f(r['p90_coverage'])} | {f(r['revolute_recall'])} | {f(r['cylindrical_recall'])} | {f(r['planar_recall'])} |")
    if not rows: L.append('| no completed evaluations yet | | | | | | | | |')
    atomic(root/'summary.md','\n'.join(L)+'\n'); print(f'wrote {root/"summary.md"}: {len(rows)} runs',flush=True)

if __name__ == '__main__': main(sys.argv[1] if len(sys.argv)>1 else '/mnt/shared/cadgang/joint-architecture-v1')
