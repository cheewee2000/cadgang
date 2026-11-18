"""Stage 3 training, evaluation, report and ONNX export. compute/parts/main.py is the command line."""
from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader

from cadnn.pointnet import load_encoder
from cadnn.runtime import describe_device, export_onnx, fit, load_ckpt, log_err, pick_device
from cadnn.util import (SPLITS, atomic_write_json, atomic_write_text, class_metrics, class_weights, fmt, md_table,
                        rng_for)
from parts.data import CLASSES, PartDataset, load_cache_meta
from parts.model import SIZE_DIM, arch_of, build


def _rows(ds, split):
    return np.arange(len(ds)) if split == 'all' else np.flatnonzero(ds.split == SPLITS.index(split))


@torch.no_grad()
def predict(model, ds, rows, device, batch_size=256, workers=0):
    model.eval()
    loader = DataLoader(ds, batch_size=batch_size, sampler=[(int(r), -1) for r in rows], num_workers=workers,
                        generator=torch.Generator().manual_seed(0))
    out = dict(label=[], pred=[], prob=[], row=[])
    for b in loader:
        prob = model(b['pts'].to(device), b['size'].to(device)).float().softmax(1).cpu().numpy()
        out['label'].append(b['label'].numpy())
        out['pred'].append(prob.argmax(1))
        out['prob'].append(prob)
        out['row'].append(b['row'].numpy())
    if not out['label']:
        return dict(label=np.zeros(0, int), pred=np.zeros(0, int), prob=np.zeros((0, len(CLASSES))), row=np.zeros(0, int))
    return {k: np.concatenate(v) for k, v in out.items()}


def train(args, on_step=None):
    meta = load_cache_meta(args.cache)
    device = pick_device(args.device)
    ds = PartDataset(args.cache, train=True, augment=args.augment, seed=args.seed)
    ev = PartDataset(args.cache, train=False, seed=args.seed)
    tr, va = _rows(ds, 'train'), _rows(ds, 'val')
    if args.max_train_rows:
        tr = np.sort(tr[rng_for(args.seed, 'limit').permutation(len(tr))[:args.max_train_rows]])
    if not len(tr):
        raise SystemExit('no training rows in the cache')
    w = class_weights(ds.label[tr], len(CLASSES), args.class_weight)
    weight = torch.tensor(w, dtype=torch.float32, device=device) if w is not None else None
    log_err(f'device {describe_device(device)}; {len(tr)} train, {len(va)} val bodies; class weights '
            + (', '.join(f'{c} {x:.2f}' for c, x in zip(CLASSES, w)) if w is not None else 'none'))
    torch.manual_seed(args.seed)
    arch = arch_of(args)
    model = build(arch)
    init = None
    if args.init_encoder:
        init = load_encoder(model.enc, args.init_encoder)
        log_err(f'encoder initialised from {args.init_encoder} ({init.get("objective")}; labels used: {init.get("labels_used")})')
    config = dict(stage='parts', arch=arch, classes=list(CLASSES), init_encoder=init,
                  data=dict(cache=str(args.cache), n_points=meta['n_points'], sha256=meta['sha256'], source=meta['source'],
                            seed=args.seed, synthetic_rows=meta.get('synthetic_rows', 0)),
                  args={k: (str(v) if isinstance(v, Path) else v) for k, v in vars(args).items() if k != 'func'})

    def step(model, b):
        return F.cross_entropy(model(b['pts'], b['size']), b['label'], weight=weight, label_smoothing=args.label_smoothing), {}

    def evaluate_val(model):
        if not len(va):
            return {}
        P = predict(model, ev, va, device, args.batch_size, args.workers)
        m = class_metrics(P['label'], P['pred'], CLASSES)
        return dict(score=m['macro_f1'] if m['macro_f1'] is not None else 0.0, val_accuracy=m['accuracy'],
                    val_macro_f1=m['macro_f1'], val_macro_recall=m['macro_recall'])

    return fit(model=model, dataset=ds, rows_for_epoch=lambda e: tr, step_fn=step, eval_fn=evaluate_val, out_dir=args.out,
               config=config, device=device, epochs=args.epochs, batch_size=args.batch_size, lr=args.lr,
               weight_decay=args.weight_decay, workers=args.workers, seed=args.seed, resume=args.resume,
               overwrite=args.overwrite, ckpt_every=args.ckpt_every, log_every=args.log_every, on_step=on_step)


def load_model(path, device='cpu'):
    ck = load_ckpt(path)
    if ck.get('config', {}).get('stage') != 'parts':
        raise SystemExit(f'{path} is not a stage 3 (parts) checkpoint')
    model = build(ck['config']['arch'])
    model.load_state_dict(ck['model'])
    return model.to(device).eval(), ck


def write_report(m, cmeta, info, base):
    base = Path(base)
    atomic_write_json(base.with_suffix('.json'), dict(info=info, cache=cmeta, metrics=m))
    L = [f'# Stage 3 part classifier: {info["split"]} split', '']
    if cmeta.get('synthetic_rows'):
        L += [f'**Synthetic data:** {cmeta["synthetic_rows"]} of {cmeta["records"]} bodies come from `parts/synth.py`. '
              'These numbers test the pipeline and say nothing about the real corpus.', '']
    init = info.get('init_encoder')
    L += [f'- checkpoint `{info["checkpoint"]}` (epoch {info.get("epoch")}, step {info.get("step")}), device {info["device"]}',
          f'- labels: ground truth from `{cmeta["source"]}` (sha256 {cmeta["sha256"][:12]}…), unknown labels {cmeta["unknown"]}',
          '- encoder: ' + (f'initialised from unsupervised pretraining `{init.get("path")}` ({init.get("objective")} on '
                           f'{init.get("source")}, {init.get("parts")} parts; no labels used), then fine-tuned on the labels above'
                           if init else 'trained from scratch on the labels above'),
          f'- split by group (merged across exact-duplicate bodies), seed {cmeta["seed"]}; {m["n"]} bodies evaluated',
          f'- accuracy {fmt(m["accuracy"], 1, True)}, macro recall {fmt(m["macro_recall"], 1, True)}, macro F1 {fmt(m["macro_f1"], 3)}',
          '', '## Per class', '']
    L.append(md_table(['class', 'bodies', 'recall', 'precision', 'F1'],
                      [[c, v['support'], fmt(v['recall'], 1, True), fmt(v['precision'], 1, True), fmt(v['f1'], 3)]
                       for c, v in m['per_class'].items()]))
    L += ['', '## Confusion (rows truth, columns prediction)', '']
    L.append(md_table(['', *CLASSES], [[CLASSES[i], *r] for i, r in enumerate(m['confusion'])]))
    if info.get('export'):
        e = info['export']
        L += ['', '## ONNX export', '',
              f'- `{e.get("path")}`: {fmt(e.get("mb"), 2)} MB against a {e.get("target_mb")} MB target: '
              f'{"under target" if e.get("under_target") else "OVER TARGET" if e.get("ok") else "export failed: " + str(e.get("error"))}',
              f'- onnxruntime check: {"passed" if e.get("verified") else "FAILED" if e.get("verified") is False else e.get("verify_note", "not run")}']
    L += ['', f'Generated {time.strftime("%Y-%m-%d %H:%M")} by `compute/parts/main.py eval`.', '']
    atomic_write_text(base.with_suffix('.md'), '\n'.join(L))


def evaluate(args):
    device = pick_device(args.device)
    model, ck = load_model(args.ckpt, device)
    d = ck['config']['data']
    cache = args.cache or d['cache']
    cmeta = load_cache_meta(cache)
    if cmeta['n_points'] != d['n_points']:
        raise SystemExit(f'cache has {cmeta["n_points"]} points per body, the model was trained on {d["n_points"]}')
    if cmeta['sha256'] != d['sha256']:
        log_err('note: this cache was built from a different JSONL than the training cache; the split may overlap training')
    ds = PartDataset(cache, train=False, seed=d['seed'])
    rows = _rows(ds, args.split)
    if not len(rows):
        raise SystemExit(f'no bodies in split {args.split}')
    P = predict(model, ds, rows, device, args.batch_size, args.workers)
    m = class_metrics(P['label'], P['pred'], CLASSES)
    exp = json.loads(Path(args.export_report).read_text(encoding='utf-8')) if args.export_report and Path(args.export_report).exists() else None
    info = dict(split=args.split, checkpoint=str(args.ckpt), epoch=ck['state']['epoch'], step=ck['state']['step'],
                device=describe_device(device), init_encoder=ck['config'].get('init_encoder'), export=exp)
    write_report(m, cmeta, info, args.report)
    if args.predictions:
        with open(args.predictions, 'w', encoding='utf-8') as f:
            for i, r in enumerate(P['row']):
                f.write(json.dumps(dict(id=str(ds.ids[r]), group=str(ds.groups[r]), label=CLASSES[int(P['label'][i])],
                                        pred=CLASSES[int(P['pred'][i])], p=round(float(P['prob'][i].max()), 4))) + '\n')
    log_err(f'accuracy {fmt(m["accuracy"], 1, True)}, macro F1 {fmt(m["macro_f1"], 3)}; report {Path(args.report).with_suffix(".md")}')
    return m


def export(args):
    model, ck = load_model(args.ckpt)
    n = ck['config']['data']['n_points']
    g = torch.Generator().manual_seed(0)
    ex = (torch.rand(2, n, 3, generator=g) - 0.5, torch.rand(2, SIZE_DIM, generator=g))
    rep = export_onnx(model, ex, args.out, ['points', 'size'], ['logits'],
                      {'points': {0: 'batch', 1: 'n'}, 'size': {0: 'batch'}, 'logits': {0: 'batch'}},
                      opset=args.opset, target_mb=args.target_mb)
    rep['checkpoint'] = str(args.ckpt)
    rep['contract'] = dict(classes=list(CLASSES), n_points=n,
                           inputs=dict(points='(B, N, 3) N points sampled from the body, centred on their bbox and divided by '
                                              'its diagonal', size='(B, 3) log10 of the body bbox extents in mm, largest first, '
                                              'floored at 1e-3 mm'),
                           outputs=dict(logits=f'(B, {len(CLASSES)}) softmax for probabilities, in classes order'))
    atomic_write_json(Path(args.report or str(args.out) + '.json'), rep)
    if not rep.get('ok'):
        log_err(rep['error'])
        return 4
    log_err(f'{args.out}: {rep["mb"]:.2f} MB, {"under" if rep["under_target"] else "OVER"} the {args.target_mb} MB target; '
            f'onnxruntime check: {rep.get("verified") if rep.get("verified") is not None else rep.get("verify_note")}')
    if rep.get('verified') is False:
        return 5
    return 0 if rep['under_target'] else 3
