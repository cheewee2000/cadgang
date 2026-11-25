#!/usr/bin/env python3
"""Summarize every completed geometry-transfer report into JSON, CSV and Markdown."""
from __future__ import annotations
import csv
import json
import os
import sys
from pathlib import Path


def atomic(path: Path, text: str):
    tmp = path.with_suffix(path.suffix + f'.{os.getpid()}.tmp')
    tmp.write_text(text, encoding='utf-8')
    os.replace(tmp, path)


def main(root: str) -> int:
    root = Path(root)
    (root / 'reports').mkdir(parents=True, exist_ok=True)
    rows = []
    for path in sorted((root / 'reports').glob('p*-s*-e*.json')):
        try:
            obj = json.loads(path.read_text(encoding='utf-8'))
            m, info = obj['metrics'], obj['info']
            stem = path.stem
            tag, epoch = stem.rsplit('-e', 1)
            rows.append(dict(
                run=stem, points=int(tag.split('-')[0][1:]), seed=int(tag.split('-s')[1]),
                pretrain_epochs=int(epoch), joint_epoch=int(info.get('epoch') or 0),
                accuracy=m.get('accuracy'), macro_recall=m.get('macro_recall'), macro_f1=m.get('macro_f1'),
                axis_median=m.get('axis_all', {}).get('median'), axis_mean=m.get('axis_all', {}).get('mean'),
                score=m.get('score'), report=str(path.with_suffix('.md')), checkpoint=info.get('checkpoint')))
        except (OSError, ValueError, KeyError):
            continue
    rows.sort(key=lambda r: (-(r['score'] if r['score'] is not None else -1), r['run']))
    atomic(root / 'summary.json', json.dumps({'baseline_accuracy': .646, 'runs': rows}, indent=2) + '\n')
    fields = list(rows[0]) if rows else ['run']
    tmp = root / f'summary.csv.{os.getpid()}.tmp'
    with tmp.open('w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fields); w.writeheader(); w.writerows(rows)
    os.replace(tmp, root / 'summary.csv')
    lines = ['# CADgang geometry-transfer study', '',
             'Baseline: prior no-augmentation joint model reached 64.6% test accuracy and 3.24–3.29° median axis error.', '',
             '| run | points | seed | pretrain epochs | accuracy | macro F1 | axis median | score |',
             '|---|---:|---:|---:|---:|---:|---:|---:|']
    for r in rows:
        fmt = lambda x: '–' if x is None else f'{x:.4f}'
        lines.append(f"| {r['run']} | {r['points']} | {r['seed']} | {r['pretrain_epochs']} | "
                     f"{fmt(r['accuracy'])} | {fmt(r['macro_f1'])} | {fmt(r['axis_median'])} | {fmt(r['score'])} |")
    if not rows:
        lines.append('| no completed evaluations yet | | | | | | | |')
    lines += ['', 'Every run uses geometry-only AutoMate pretraining (`labels_used: none`) followed by supervised joint fine-tuning.', '']
    atomic(root / 'summary.md', '\n'.join(lines))
    print(f'wrote {root / "summary.md"}: {len(rows)} completed evaluations', flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1] if len(sys.argv) > 1 else '/mnt/shared/cadgang/geometry-transfer-v1'))
