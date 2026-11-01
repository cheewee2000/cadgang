"""Stage 2 training, evaluation, report and ONNX export. compute/joints/main.py is the command line."""
from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import DataLoader

from cadnn.runtime import describe_device, export_onnx, fit, load_ckpt, log_err, pick_device
from cadnn.util import (angle_deg, angle_stats, atomic_write_json, atomic_write_text, class_metrics, class_weights,
                        fmt, md_table, rng_for)
from joints.data import AXIAL, LABEL_ID, LABELS, N_CH, N_EXTRA, PairDataset, load_index, rows_in, train_rows_for_epoch
from joints.model import arch_of, build, joint_loss


def _limit(rows, n, seed, tag):
    if n and len(rows) > n:
        rows = np.sort(rows[rng_for(seed, tag).permutation(len(rows))[:n]])
    return rows


@torch.no_grad()
def predict(model, ds, rows, device, batch_size=128, workers=0):
    """Run the model over index rows. Returns arrays: label, pred, prob, axis_pred, axis_gt, axis_mask,
    solver_dir, solver_mask, row."""
    model.eval()
    loader = DataLoader(ds, batch_size=batch_size, sampler=[(int(r), -1) for r in rows], num_workers=workers,
                        generator=torch.Generator().manual_seed(0))
    keys = ('label', 'pred', 'prob', 'axis_pred', 'axis_gt', 'axis_mask', 'solver_dir', 'solver_mask', 'row')
    out = {k: [] for k in keys}
    for b in loader:
        logits, axis = model(b['pa'].to(device), b['pb'].to(device), b['extra'].to(device))
        prob = logits.float().softmax(1).cpu().numpy()
        out['label'].append(b['label'].numpy())
        out['pred'].append(prob.argmax(1))
        out['prob'].append(prob)
        out['axis_pred'].append(axis.float().cpu().numpy())
        out['axis_gt'].append(b['axis'].numpy())
        out['axis_mask'].append(b['axis_mask'].numpy())
        out['solver_dir'].append(b['solver_dir'].numpy())
        out['solver_mask'].append(b['solver_mask'].numpy())
        out['row'].append(b['row'].numpy())
    if not out['label']:
        return {k: np.zeros((0,)) for k in keys}
    return {k: np.concatenate(v) for k, v in out.items()}


def summarize(P):
    """Type metrics and, per axial type, the model's axis error next to the rule solver's (solve[].dir of the
    smaller part) on the same pairs."""
    m = class_metrics(P['label'], P['pred'], LABELS) if len(P['label']) else class_metrics([], [], LABELS)
    axis, all_err = {}, []
    for name in AXIAL:
        sel = (P['label'] == LABEL_ID[name]) & (P['axis_mask'] > 0) if len(P['label']) else np.zeros(0, bool)
        gt, pred = P['axis_gt'][sel] if sel.any() else np.zeros((0, 3)), P['axis_pred'][sel] if sel.any() else np.zeros((0, 3))
        me = angle_deg(pred, gt)
        all_err.append(me)
        has = (P['solver_mask'][sel] > 0) if sel.any() else np.zeros(0, bool)
        se = angle_deg(P['solver_dir'][sel][has], gt[has]) if has.any() else np.zeros(0)
        se_all = np.concatenate([se, np.full(int((~has).sum()), 90.0)])
        row = dict(n=int(sel.sum()), solver_coverage=float(has.mean()) if len(has) else None,
                   model=angle_stats(me), model_where_solver_moved=angle_stats(me[has]) if has.any() else dict(n=0),
                   solver=angle_stats(se), solver_unmoved_as_90=angle_stats(se_all),
                   type_recall=m['per_class'][name]['recall'])
        if len(me):
            row['beats_solver_same_pairs'] = bool(has.any() and np.median(me[has]) < np.median(se))
            row['beats_solver_all_pairs'] = bool(np.median(me) < np.median(se_all))
        axis[name] = row
    all_err = np.concatenate(all_err) if all_err else np.zeros(0)
    m['axis'] = axis
    m['axis_all'] = angle_stats(all_err)
    macro = m['macro_recall'] or 0.0
    m['score'] = 0.5 * macro + 0.5 * (1 - all_err.mean() / 90.0) if len(all_err) else macro
    return m


def write_report(m, meta, info, base):
    """<base>.json (everything) and <base>.md (tables)."""
    base = Path(base)
    atomic_write_json(base.with_suffix('.json'), dict(info=info, index=meta, metrics=m))
    L = [f'# Stage 2 joint predictor: {info["split"]} split', '']
    if meta.get('synthetic_assemblies'):
        L += [f'**Synthetic data:** {meta["synthetic_assemblies"]} of {meta["assemblies"]} assemblies in this index come from '
              '`joints/synth.py`. These numbers test the pipeline and say nothing about AutoMate.', '']
    L += [f'- checkpoint `{info["checkpoint"]}` (epoch {info.get("epoch")}, step {info.get("step")}), device {info["device"]}',
          f'- index `{info["index"]}`: {meta["assemblies"]} assemblies, {meta["pairs"]} pairs, gap < {meta["gap_mm"]} mm, '
          f'split by assembly id (seed {meta["seed"]}, val {meta["val"]}, test {meta["test"]})',
          f'- {m["n"]} pairs evaluated{" (limited by --limit)" if info.get("limited") else ""}; {info["n_points"]} points per part, '
          f'contact within {info["contact_mm"]} mm',
          f'- accuracy {fmt(m["accuracy"], 1, True)}, macro per-type accuracy {fmt(m["macro_recall"], 1, True)}, '
          f'macro F1 {fmt(m["macro_f1"], 3)}', '', '## Type', '']
    L.append(md_table(['type', 'pairs', 'accuracy (recall)', 'precision', 'F1'],
                      [[n, v['support'], fmt(v['recall'], 1, True), fmt(v['precision'], 1, True), fmt(v['f1'], 3)]
                       for n, v in m['per_class'].items()]))
    L += ['', '## Axis (sign-invariant angle, degrees)', '',
          'Model: the predicted axis on every ground-truth pair of the type. Solver: `solve[].dir` of the smaller part '
          'from the same dump, on the pairs where the solver moved that part (coverage); "unmoved as 90°" counts a '
          'part the solver left in place as 90° off.', '']
    rows = []
    for name, a in m['axis'].items():
        mo, ms, so, s9 = a['model'], a['model_where_solver_moved'], a['solver'], a['solver_unmoved_as_90']
        rows.append([name, a['n'], fmt(mo.get('median')), fmt(mo.get('mean')), fmt(mo.get('within_5'), 0, True),
                     fmt(a['solver_coverage'], 0, True), fmt(ms.get('median')), fmt(so.get('median')),
                     fmt(so.get('within_5'), 0, True), fmt(s9.get('median')),
                     {True: 'yes', False: 'no'}.get(a.get('beats_solver_same_pairs'), '–'),
                     {True: 'yes', False: 'no'}.get(a.get('beats_solver_all_pairs'), '–')])
    L.append(md_table(['type', 'pairs', 'model median', 'model mean', 'model ≤5°', 'solver coverage',
                       'model median (solver pairs)', 'solver median', 'solver ≤5°', 'solver median (unmoved as 90°)',
                       'beats solver (same pairs)', 'beats solver (all)'], rows))
    beat = [n for n, a in m['axis'].items() if a.get('beats_solver_same_pairs') and a.get('beats_solver_all_pairs')]
    L += ['', f'Model beats the solver on both comparisons for: {", ".join(beat) if beat else "none"} '
          f'(README: export when CYLINDRICAL, SLIDER and REVOLUTE all do).', '', '## Confusion (rows truth, columns prediction)', '']
    L.append(md_table(['', *LABELS], [[LABELS[i], *r] for i, r in enumerate(m['confusion'])]))
    if info.get('export'):
        e = info['export']
        L += ['', '## ONNX export', '',
              f'- `{e.get("path")}`: {fmt(e.get("mb"), 2)} MB against a {e.get("target_mb")} MB target: '
              f'{"under target" if e.get("under_target") else "OVER TARGET" if e.get("ok") else "export failed: " + str(e.get("error"))}',
              f'- onnxruntime check: {"passed" if e.get("verified") else "FAILED" if e.get("verified") is False else e.get("verify_note", "not run")}']
    L += ['', f'Generated {time.strftime("%Y-%m-%d %H:%M")} by `compute/joints/main.py eval`.', '']
    atomic_write_text(base.with_suffix('.md'), '\n'.join(L))


def train(args, on_step=None):
    index, meta = load_index(args.index)
    dump = args.dump or meta['dump_dir']
    device = pick_device(args.device)
    log_err(f'device {describe_device(device)}; index {meta["pairs"]} pairs from {meta["assemblies"]} assemblies')
    ds = PairDataset(index, dump, args.points, args.contact_mm, args.seed, train=True, augment=args.augment)
    ev = PairDataset(index, dump, args.points, args.contact_mm, args.seed, train=False)
    rows_fn = lambda e: train_rows_for_epoch(index, e, args.seed, args.none_ratio, args.max_train_rows)
    r0 = rows_fn(0)
    if not len(r0):
        raise SystemExit('no training pairs in the index')
    w = class_weights(index['label'][r0], len(LABELS), args.class_weight)
    weight = torch.tensor(w, dtype=torch.float32, device=device) if w is not None else None
    val_rows = _limit(rows_in(index, 'val'), args.val_limit, args.seed, 'val')
    log_err(f'{len(r0)} training pairs per epoch, {len(val_rows)} validation pairs; class weights '
            + (', '.join(f'{n} {x:.2f}' for n, x in zip(LABELS, w)) if w is not None else 'none'))
    torch.manual_seed(args.seed)
    arch = arch_of(args)
    model = build(arch)
    config = dict(stage='joints', arch=arch, labels=list(LABELS),
                  data=dict(n_points=args.points, contact_mm=args.contact_mm, gap_mm=meta['gap_mm'], index=str(args.index),
                            seed=args.seed, n_ch=N_CH, n_extra=N_EXTRA),
                  args={k: (str(v) if isinstance(v, Path) else v) for k, v in vars(args).items() if k != 'func'})

    def step(model, b):
        logits, axis = model(b['pa'], b['pb'], b['extra'])
        loss, ce, ax = joint_loss(logits, axis, b['label'], b['axis'], b['axis_mask'], weight, args.axis_weight)
        return loss, dict(type=ce.detach(), axis=ax.detach())

    def evaluate_val(model):
        if not len(val_rows):
            return {}
        m = summarize(predict(model, ev, val_rows, device, args.batch_size, args.workers))
        return dict(score=m['score'], val_accuracy=m['accuracy'], val_macro_recall=m['macro_recall'],
                    val_axis_median=m['axis_all'].get('median'), val_axis_mean=m['axis_all'].get('mean'))

    return fit(model=model, dataset=ds, rows_for_epoch=rows_fn, step_fn=step, eval_fn=evaluate_val, out_dir=args.out,
               config=config, device=device, epochs=args.epochs, batch_size=args.batch_size, lr=args.lr,
               weight_decay=args.weight_decay, workers=args.workers, seed=args.seed, resume=args.resume,
               overwrite=args.overwrite, ckpt_every=args.ckpt_every, log_every=args.log_every, on_step=on_step)


def load_model(path, device='cpu'):
    ck = load_ckpt(path)
    if ck.get('config', {}).get('stage') != 'joints':
        raise SystemExit(f'{path} is not a stage 2 (joints) checkpoint')
    model = build(ck['config']['arch'])
    model.load_state_dict(ck['model'])
    return model.to(device).eval(), ck


def evaluate(args):
    device = pick_device(args.device)
    model, ck = load_model(args.ckpt, device)
    index, meta = load_index(args.index)
    d = ck['config']['data']
    if abs(meta['gap_mm'] - d['gap_mm']) > 1e-9:
        log_err(f'note: index gap {meta["gap_mm"]} mm, model trained on gap {d["gap_mm"]} mm')
    ds = PairDataset(index, args.dump or meta['dump_dir'], d['n_points'], d['contact_mm'], d['seed'], train=False)
    rows = np.arange(len(index['label'])) if args.split == 'all' else rows_in(index, args.split)
    n_all = len(rows)
    rows = _limit(rows, args.limit, 0, 'eval')
    if not len(rows):
        raise SystemExit(f'no pairs in split {args.split}')
    log_err(f'evaluating {len(rows)} {args.split} pairs on {describe_device(device)}')
    P = predict(model, ds, rows, device, args.batch_size, args.workers)
    m = summarize(P)
    exp = None
    if args.export_report and Path(args.export_report).exists():
        exp = json.loads(Path(args.export_report).read_text(encoding='utf-8'))
    info = dict(split=args.split, checkpoint=str(args.ckpt), epoch=ck['state']['epoch'], step=ck['state']['step'],
                device=describe_device(device), index=str(args.index), n_points=d['n_points'], contact_mm=d['contact_mm'],
                limited=len(rows) < n_all, export=exp)
    write_report(m, meta, info, args.report)
    if args.predictions:
        with open(args.predictions, 'w', encoding='utf-8') as f:
            for i in range(len(P['row'])):
                r = int(P['row'][i])
                f.write(json.dumps(dict(asm=str(index['asm_ids'][index['asm'][r]]), occ_a=int(index['occ_a'][r]),
                                        occ_b=int(index['occ_b'][r]), label=LABELS[int(P['label'][i])],
                                        pred=LABELS[int(P['pred'][i])], p=round(float(P['prob'][i].max()), 4),
                                        axis=[round(float(x), 4) for x in P['axis_pred'][i]])) + '\n')
    log_err(f'accuracy {fmt(m["accuracy"], 1, True)}, axis median {fmt(m["axis_all"].get("median"))}°; '
            f'report {Path(args.report).with_suffix(".md")}')
    return m


def export(args):
    model, ck = load_model(args.ckpt)
    d = ck['config']['data']
    n = d['n_points']
    g = torch.Generator().manual_seed(0)
    ex = (torch.rand(2, n, N_CH, generator=g) - 0.5, torch.rand(2, n, N_CH, generator=g) - 0.5,
          torch.rand(2, N_EXTRA, generator=g))
    rep = export_onnx(model, ex, args.out, ['pa', 'pb', 'extra'], ['type_logits', 'axis'],
                      {'pa': {0: 'batch', 1: 'points'}, 'pb': {0: 'batch', 1: 'points'}, 'extra': {0: 'batch'},
                       'type_logits': {0: 'batch'}, 'axis': {0: 'batch'}}, opset=args.opset, target_mb=args.target_mb)
    rep['checkpoint'] = str(args.ckpt)
    rep['contract'] = dict(
        labels=list(LABELS), axial=list(AXIAL), n_points=n, contact_mm=d['contact_mm'],
        inputs=dict(pa='(B, N, 5) smaller part (by bbox diagonal): xyz centred on the union bbox of both parts and divided by '
                       'its diagonal; contact flag (within contact_mm of a vertex of the other part); inside the other '
                       "part's bbox grown by contact_mm. Points: N vertices sampled from the part's world-space mesh (mm).",
                    pb='(B, N, 5) the larger part, same channels', extra='(B, 4) log10(union bbox diagonal mm), diag A / union '
                    'diag, diag B / union diag, bbox gap / union diag'),
        outputs=dict(type_logits='(B, 7) softmax for probabilities, in labels order',
                     axis='(B, 3) unit axis in the same world frame (sign is arbitrary); meaningful when the type is axial'))
    atomic_write_json(Path(args.report or str(args.out) + '.json'), rep)
    if not rep.get('ok'):
        log_err(rep['error'])
        return 4
    verdict = 'under' if rep['under_target'] else 'OVER'
    log_err(f'{args.out}: {rep["mb"]:.2f} MB, {verdict} the {args.target_mb} MB target; '
            f'onnxruntime check: {rep.get("verified") if rep.get("verified") is not None else rep.get("verify_note")}')
    if rep.get('verified') is False:
        return 5
    return 0 if rep['under_target'] else 3
