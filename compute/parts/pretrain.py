"""Optional, unsupervised: pretrain the stage 3 encoder as a point autoencoder on AutoMate part geometry from the
stage 1 dumps. No labels of any kind are read; the result is encoder.pt tagged kind='unsupervised-pretrain', which
`main.py train --init-encoder` loads and the report names. The labelled data stay the only ground truth.

Not implemented on purpose: a weak 'fastener' label from FASTENED-mate counts. It does not map onto the seven
classes (a FASTENED mate joins brackets and plates as often as screws), and mixing it into the label set would make
the reported accuracy mean something else."""
from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import DataLoader

from cadnn.pointnet import encoder_payload
from cadnn.runtime import describe_device, fit, load_ckpt, log_err, pick_device, save_ckpt
from cadnn.util import (atomic_write_json, normalize_cloud, random_rotation, rng_for, sample_indices, split_of)
from parts.model import PointAE, chamfer


def index_settings(dump_dir, seed, max_parts, min_vertices=32):
    return dict(dump=str(Path(dump_dir).resolve()), seed=seed, max_parts=max_parts, min_vertices=min_vertices)


def index_dump_parts(dump_dir, out_dir, seed=0, max_parts=0, min_vertices=32, log=log_err):
    """One row per distinct part id (AutoMate reuses parts across occurrences and assemblies): the assembly file
    and the part's vertex range. Writes out_dir/parts.npz."""
    dump, out = Path(dump_dir), Path(out_dir)
    seen, asm_ids, cols = set(), [], dict(asm=[], first=[], count=[], part=[])
    for f in sorted(dump.glob('*.json')):
        try:
            A = json.loads(f.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            continue
        f32 = f.with_suffix('.f32')
        if not f32.exists() or f32.stat().st_size != 12 * sum(int(p['count']) for p in A.get('parts') or []):
            continue
        ai = None
        for p in A.get('parts') or []:
            if p['part'] in seen or p['count'] < min_vertices:
                continue
            seen.add(p['part'])
            if ai is None:
                ai = len(asm_ids)
                asm_ids.append(f.stem)
            cols['asm'].append(ai)
            cols['first'].append(int(p['first']))
            cols['count'].append(int(p['count']))
            cols['part'].append(str(p['part']))
        if max_parts and len(cols['part']) >= max_parts:
            break
    if not cols['part']:
        raise SystemExit(f'no parts with geometry under {dump}')
    arr = dict(asm=np.array(cols['asm'], dtype=np.int32), first=np.array(cols['first'], dtype=np.int64),
               count=np.array(cols['count'], dtype=np.int64), part=np.array(cols['part'], dtype=str),
               asm_ids=np.array(asm_ids, dtype=str),
               split=np.array([split_of(p, seed, 0.02, 0.0) for p in cols['part']], dtype=np.int8))
    out.mkdir(parents=True, exist_ok=True)
    with open(out / 'parts.tmp.npz', 'wb') as fh:
        np.savez(fh, **arr)
    (out / 'parts.tmp.npz').replace(out / 'parts.npz')
    atomic_write_json(out / 'parts.json', index_settings(dump, seed, max_parts, min_vertices) | dict(parts=len(arr['part'])))
    log(f'{len(arr["part"])} distinct parts from {len(asm_ids)} assemblies')
    return arr


class DumpPartDataset:
    def __init__(self, idx, dump_dir, n_points=1024, seed=0, train=False):
        self.idx, self.dump, self.n, self.seed, self.train = idx, Path(dump_dir), n_points, seed, train
        self.asm_ids = [str(a) for a in idx['asm_ids']]
        self._maps = {}

    def __len__(self):
        return len(self.idx['part'])

    def __getstate__(self):
        s = dict(self.__dict__)
        s['_maps'] = {}
        return s

    def __getitem__(self, item):
        row, epoch = (item if isinstance(item, (tuple, list)) else (item, -1))
        row = int(row)
        ai = int(self.idx['asm'][row])
        m = self._maps.get(ai)
        if m is None:
            if len(self._maps) >= 16:
                self._maps.pop(next(iter(self._maps)))
            m = self._maps[ai] = np.memmap(self.dump / f'{self.asm_ids[ai]}.f32', dtype='<f4', mode='r')
        first, count = int(self.idx['first'][row]), int(self.idx['count'][row])
        v = np.asarray(m[first * 3:(first + count) * 3], dtype=np.float64).reshape(-1, 3)
        ep = epoch if self.train else 'eval'
        p = normalize_cloud(v[sample_indices(len(v), self.n, rng_for(self.seed, 'pre', self.idx['part'][row], ep))])[0]
        if self.train:
            p = p @ random_rotation(rng_for(self.seed, 'pre-rot', row, epoch)).T
        return dict(pts=p.astype(np.float32), row=np.int64(row))


def pretrain(args, on_step=None):
    device = pick_device(args.device)
    out = Path(args.out)
    want = index_settings(args.dump, args.seed, args.max_parts)
    have = json.loads((out / 'parts.json').read_text(encoding='utf-8')) if (out / 'parts.json').exists() else {}
    if (out / 'parts.npz').exists() and all(have.get(k) == v for k, v in want.items()):
        with np.load(out / 'parts.npz', allow_pickle=False) as z:
            idx = {k: z[k] for k in z.files}
    else:
        if args.resume and (out / 'last.pt').exists():
            raise SystemExit(f'{out}: the part index was built with {have or "unknown settings"}, this run asks for {want}; '
                             'resume with the same --dump/--seed/--max-parts or use a new --out')
        idx = index_dump_parts(args.dump, out, args.seed, args.max_parts)
    ds = DumpPartDataset(idx, args.dump, args.points, args.seed, train=True)
    ev = DumpPartDataset(idx, args.dump, args.points, args.seed, train=False)
    tr, va = np.flatnonzero(idx['split'] == 0), np.flatnonzero(idx['split'] == 1)
    if len(va) > args.val_limit > 0:
        va = va[:args.val_limit]
    log_err(f'device {describe_device(device)}; {len(tr)} train, {len(va)} val parts')
    torch.manual_seed(args.seed)
    arch = dict(widths=list(args.widths), n_out=args.decoder_points, hidden=list(args.decoder_hidden))
    model = PointAE(tuple(arch['widths']), arch['n_out'], tuple(arch['hidden']))
    config = dict(stage='parts-pretrain', arch=arch, data=dict(dump=str(args.dump), n_points=args.points, seed=args.seed),
                  args={k: (str(v) if isinstance(v, Path) else v) for k, v in vars(args).items() if k != 'func'})

    def step(model, b):
        return chamfer(model(b['pts']), b['pts']).mean(), {}

    @torch.no_grad()
    def evaluate_val(model):
        if not len(va):
            return {}
        loader = DataLoader(ev, batch_size=args.batch_size, sampler=[(int(r), -1) for r in va], num_workers=args.workers,
                            generator=torch.Generator().manual_seed(0))
        tot, n = 0.0, 0
        for b in loader:
            x = b['pts'].to(device)
            tot += float(chamfer(model(x), x).sum())
            n += len(x)
        return dict(score=-tot / n, val_chamfer=tot / n)

    r = fit(model=model, dataset=ds, rows_for_epoch=lambda e: tr, step_fn=step, eval_fn=evaluate_val, out_dir=out,
            config=config, device=device, epochs=args.epochs, batch_size=args.batch_size, lr=args.lr,
            weight_decay=args.weight_decay, workers=args.workers, seed=args.seed, resume=args.resume,
            overwrite=args.overwrite, ckpt_every=args.ckpt_every, log_every=args.log_every, on_step=on_step)
    src = out / 'best.pt' if (out / 'best.pt').exists() else out / 'last.pt'
    ck = load_ckpt(src)
    model.load_state_dict(ck['model'])
    save_ckpt(out / 'encoder.pt', encoder_payload(
        model.enc, source=f'AutoMate stage 1 dumps ({args.dump})', objective='point autoencoder, symmetric chamfer',
        labels_used='none', parts=int(len(tr)), epochs_done=int(ck['state']['epoch']), finished=bool(r.get('finished')),
        from_checkpoint=str(src), created=time.strftime('%Y-%m-%d %H:%M:%S')))
    atomic_write_json(out / 'encoder.json', dict(kind='unsupervised-pretrain', labels_used='none', parts=int(len(tr)),
                                                 val_parts=int(len(va)), best=ck['state'].get('best'),
                                                 epochs_done=ck['state']['epoch'], finished=r.get('finished'), arch=arch))
    log_err(f'wrote {out / "encoder.pt"} (from {src.name}, run {"finished" if r.get("finished") else "not finished"})')
    return r
