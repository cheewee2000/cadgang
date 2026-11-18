#!/usr/bin/env python3
"""Stage 3, the part classifier: screw / nut / washer / standoff / pcb / bearing / other from a body's shape.

  python3 compute/parts/main.py validate compute/results/parts-labelled.jsonl          (numpy only; run this first)
  python3 compute/parts/main.py cache    --jsonl compute/results/parts-labelled.jsonl --out $WORK/parts-cache
  python3 compute/parts/main.py train    --cache $WORK/parts-cache --out $WORK/parts-run [--resume] [--init-encoder E]
  python3 compute/parts/main.py eval     --ckpt $WORK/parts-run/best.pt --report compute/results/parts-report
  python3 compute/parts/main.py export   --ckpt $WORK/parts-run/best.pt --out compute/results/parts.onnx
  python3 compute/parts/main.py pretrain --dump $AUTOMATE/dump --out $WORK/parts-pretrain   (optional, unsupervised)
  python3 compute/parts/main.py synth    --out /tmp/parts-synth.jsonl                          (fake data for trying it)

See compute/parts/README.md."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:] = [p for p in sys.path if Path(p or '.').resolve() != HERE]
sys.path.insert(0, str(HERE.parent))

from cadnn.util import parse_ints  # noqa: E402


def _train_args(p, epochs, batch):
    p.add_argument('--out', required=True, help='run directory: last.pt, best.pt, metrics.jsonl')
    p.add_argument('--resume', action='store_true', help='continue from --out/last.pt if it exists')
    p.add_argument('--overwrite', action='store_true', help='start again even though --out/last.pt exists')
    p.add_argument('--device', default='auto', help='auto | cpu | cuda | cuda:N | rocm (ROCm torch uses the cuda device) | mps')
    p.add_argument('--epochs', type=int, default=epochs)
    p.add_argument('--batch-size', type=int, default=batch)
    p.add_argument('--lr', type=float, default=1e-3)
    p.add_argument('--weight-decay', type=float, default=1e-4)
    p.add_argument('--widths', type=parse_ints, default=(64, 128, 256), help='encoder widths (default 64,128,256)')
    p.add_argument('--workers', type=int, default=4)
    p.add_argument('--seed', type=int, default=0)
    p.add_argument('--ckpt-every', type=int, default=500)
    p.add_argument('--log-every', type=int, default=50)


def build_parser():
    ap = argparse.ArgumentParser(prog='compute/parts/main.py', description=__doc__.split('\n\n')[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__.split('\n\n', 1)[1])
    sub = ap.add_subparsers(dest='cmd', required=True)

    p = sub.add_parser('validate', help='check a labelled JSONL before training (numpy only); exit 1 when not ok')
    p.add_argument('jsonl')
    p.add_argument('--points', type=int, default=1024, help='expected points per body (default 1024)')
    p.add_argument('--seed', type=int, default=0)
    p.add_argument('--val', type=float, default=0.1)
    p.add_argument('--test', type=float, default=0.1)
    p.add_argument('--max-invalid', type=float, default=0.01, help='fraction of bad lines that makes it fatal (default 0.01)')
    p.add_argument('--json', help='also write the full report here')

    p = sub.add_parser('cache', help='parse, split and resample the JSONL into a memory-mapped cache')
    p.add_argument('--jsonl', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--points', type=int, default=1024)
    p.add_argument('--seed', type=int, default=0, help='split and resampling seed')
    p.add_argument('--val', type=float, default=0.1)
    p.add_argument('--test', type=float, default=0.1)
    p.add_argument('--unknown', choices=('skip', 'other', 'error'), default='skip',
                   help="labels outside the classes: skip them (default), call them 'other', or stop")
    p.add_argument('--bbox-scale', type=float, default=1.0, help='multiply bboxes to get mm (default 1: already mm)')

    p = sub.add_parser('train', help='train the classifier; SIGTERM checkpoints and exits 143, --resume continues')
    p.add_argument('--cache', required=True)
    _train_args(p, 60, 64)
    p.add_argument('--head', type=parse_ints, default=(256, 128))
    p.add_argument('--dropout', type=float, default=0.3)
    p.add_argument('--class-weight', choices=('none', 'inv', 'sqrt-inv'), default='inv')
    p.add_argument('--label-smoothing', type=float, default=0.0)
    p.add_argument('--augment', choices=('none', 'so3', 'z'), default='so3', help='rotation augmentation (default so3)')
    p.add_argument('--init-encoder', help='encoder.pt from `pretrain` (unsupervised; recorded in the report)')
    p.add_argument('--max-train-rows', type=int, default=0)

    p = sub.add_parser('eval', help='per-class metrics and confusion; writes a report')
    p.add_argument('--ckpt', required=True)
    p.add_argument('--cache', help='default: the cache the model was trained on')
    p.add_argument('--split', default='test', choices=('train', 'val', 'test', 'all'))
    p.add_argument('--report', default='compute/results/parts-report', help='writes <report>.md and <report>.json')
    p.add_argument('--export-report')
    p.add_argument('--predictions', help='also write one JSON line per body here')
    p.add_argument('--device', default='auto')
    p.add_argument('--batch-size', type=int, default=256)
    p.add_argument('--workers', type=int, default=4)

    p = sub.add_parser('export', help='ONNX export; exit 3 when over --target-mb, 4 when export fails, 5 when the file fails its check')
    p.add_argument('--ckpt', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--report')
    p.add_argument('--target-mb', type=float, default=10.0)
    p.add_argument('--opset', type=int, default=17)

    p = sub.add_parser('pretrain', help='optional: unsupervised autoencoder pretraining on AutoMate dump geometry')
    p.add_argument('--dump', required=True)
    _train_args(p, 20, 32)
    p.add_argument('--points', type=int, default=1024)
    p.add_argument('--decoder-points', type=int, default=1024)
    p.add_argument('--decoder-hidden', type=parse_ints, default=(512, 1024))
    p.add_argument('--max-parts', type=int, default=0, help='cap distinct parts indexed (default 0 = all)')
    p.add_argument('--val-limit', type=int, default=5000)

    p = sub.add_parser('synth', help='write a small synthetic labelled JSONL (for trying the pipeline, not for results)')
    p.add_argument('--out', required=True)
    p.add_argument('--per-class', type=int, default=8)
    p.add_argument('--points', type=int, default=1024)
    p.add_argument('--seed', type=int, default=0)
    p.add_argument('--bad', action='store_true', help='append broken lines too')
    return ap


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.cmd == 'validate':
        from parts.data import format_validation, validate
        rep = validate(args.jsonl, args.points, args.seed, args.val, args.test, args.max_invalid)
        print(format_validation(rep))
        if args.json:
            from cadnn.util import atomic_write_json
            atomic_write_json(args.json, rep)
        return 1 if rep['fatal'] else 0
    if args.cmd == 'cache':
        from parts.data import build_cache
        build_cache(args.jsonl, args.out, args.points, args.seed, args.val, args.test, args.unknown, args.bbox_scale,
                    log=lambda *a: print(*a, file=sys.stderr, flush=True))
        return 0
    if args.cmd == 'synth':
        from parts.synth import write_jsonl
        n = write_jsonl(args.out, args.per_class, args.seed, args.points, args.bad)
        print(f'{n} synthetic bodies in {args.out}', file=sys.stderr)
        return 0
    try:
        import torch  # noqa: F401
    except ImportError:
        print(f'{args.cmd} needs PyTorch (pip install -r compute/requirements.txt)', file=sys.stderr)
        return 2
    if args.cmd == 'pretrain':
        from parts.pretrain import pretrain
        r = pretrain(args)
        return r.get('exit_code', 1) if r.get('stopped') else 0
    from parts import train as T
    if args.cmd == 'train':
        r = T.train(args)
        return r.get('exit_code', 1) if r.get('stopped') else 0
    if args.cmd == 'eval':
        T.evaluate(args)
        return 0
    if args.cmd == 'export':
        return T.export(args)
    return 1


if __name__ == '__main__':
    sys.exit(main())
