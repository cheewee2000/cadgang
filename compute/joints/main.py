#!/usr/bin/env python3
"""Stage 2, the joint predictor: given two touching parts, predict the mate type and axis.

  python3 compute/joints/main.py index  --dump $AUTOMATE/dump --out $AUTOMATE/joints-index
  python3 compute/joints/main.py train  --index $AUTOMATE/joints-index --out $AUTOMATE/joints-run [--resume]
  python3 compute/joints/main.py eval   --index $AUTOMATE/joints-index --ckpt $AUTOMATE/joints-run/best.pt --report compute/results/joints-report
  python3 compute/joints/main.py export --ckpt $AUTOMATE/joints-run/best.pt --out compute/results/joints.onnx
  python3 compute/joints/main.py synth  --out /tmp/joints-synth     (a tiny fake dump for trying the commands)

index and synth need numpy only; train, eval and export need torch. See compute/joints/README.md."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:] = [p for p in sys.path if Path(p or '.').resolve() != HERE]   # data.py / model.py must not shadow anything
sys.path.insert(0, str(HERE.parent))

from cadnn.util import parse_ints  # noqa: E402


def build_parser():
    ap = argparse.ArgumentParser(prog='compute/joints/main.py', description=__doc__.split('\n\n')[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__.split('\n\n', 1)[1])
    sub = ap.add_subparsers(dest='cmd', required=True)

    p = sub.add_parser('index', help='touching-part pairs from stage 1 dumps (reads JSON only)')
    p.add_argument('--dump', required=True, help='directory of <id>.json + <id>.f32 from explode.automate.mjs --dump')
    p.add_argument('--out', required=True, help='index directory (pairs.npz + index.json)')
    p.add_argument('--ids', help='file with one assembly id per line (default: every <id>.json in --dump)')
    p.add_argument('--gap-mm', type=float, default=1.0, help='bboxes closer than this make a pair (default 1)')
    p.add_argument('--seed', type=int, default=0, help='split seed (default 0)')
    p.add_argument('--val', type=float, default=0.1, help='fraction of assemblies in val (default 0.1)')
    p.add_argument('--test', type=float, default=0.1, help='fraction of assemblies in test (default 0.1)')
    p.add_argument('--workers', type=int, default=1, help='processes for scanning (default 1)')

    p = sub.add_parser('train', help='train; SIGTERM checkpoints and exits 143, --resume continues')
    p.add_argument('--index', required=True)
    p.add_argument('--dump', help="dump directory (default: the one the index was built from)")
    p.add_argument('--out', required=True, help='run directory: last.pt, best.pt, metrics.jsonl')
    p.add_argument('--resume', action='store_true', help='continue from --out/last.pt if it exists')
    p.add_argument('--overwrite', action='store_true', help='start again even though --out/last.pt exists')
    p.add_argument('--device', default='auto', help='auto | cpu | cuda | cuda:N | rocm (ROCm torch uses the cuda device) | mps')
    p.add_argument('--epochs', type=int, default=20)
    p.add_argument('--batch-size', type=int, default=64)
    p.add_argument('--lr', type=float, default=1e-3)
    p.add_argument('--weight-decay', type=float, default=1e-4)
    p.add_argument('--points', type=int, default=1024, help='points sampled per part (default 1024)')
    p.add_argument('--contact-mm', type=float, default=1.0, help='contact flag distance (default 1)')
    p.add_argument('--none-ratio', type=float, default=2.0,
                   help='NONE pairs per mated pair in each training epoch, redrawn per epoch; -1 keeps all (default 2)')
    p.add_argument('--class-weight', choices=('none', 'inv', 'sqrt-inv'), default='sqrt-inv')
    p.add_argument('--axis-weight', type=float, default=1.0, help='weight of the axis loss (default 1)')
    p.add_argument('--augment', choices=('none', 'so3', 'z'), default='none',
                   help='random rotation of each training pair and its axis (default none: keep world orientation)')
    p.add_argument('--widths', type=parse_ints, default=(64, 128, 256), help='encoder widths (default 64,128,256)')
    p.add_argument('--head', type=parse_ints, default=(256, 128), help='pair MLP widths (default 256,128)')
    p.add_argument('--dropout', type=float, default=0.2)
    p.add_argument('--workers', type=int, default=4, help='DataLoader processes (default 4)')
    p.add_argument('--seed', type=int, default=0)
    p.add_argument('--val-limit', type=int, default=20000, help='validation pairs per epoch, 0 for all (default 20000)')
    p.add_argument('--max-train-rows', type=int, default=0, help='cap training pairs (smoke runs; default 0 = all)')
    p.add_argument('--ckpt-every', type=int, default=500, help='steps between checkpoints (default 500)')
    p.add_argument('--log-every', type=int, default=50)

    p = sub.add_parser('eval', help='per-type accuracy and axis error against the rule solver; writes a report')
    p.add_argument('--index', required=True)
    p.add_argument('--dump')
    p.add_argument('--ckpt', required=True)
    p.add_argument('--split', default='test', choices=('train', 'val', 'test', 'all'))
    p.add_argument('--report', default='compute/results/joints-report', help='writes <report>.md and <report>.json')
    p.add_argument('--export-report', help='an export .json to include in the report')
    p.add_argument('--predictions', help='also write one JSON line per pair here')
    p.add_argument('--limit', type=int, default=0, help='evaluate a deterministic subset of this many pairs')
    p.add_argument('--device', default='auto')
    p.add_argument('--batch-size', type=int, default=128)
    p.add_argument('--workers', type=int, default=4)

    p = sub.add_parser('export', help='ONNX export; exit 3 when over --target-mb, 4 when export fails, 5 when the file fails its check')
    p.add_argument('--ckpt', required=True)
    p.add_argument('--out', required=True, help='.onnx path')
    p.add_argument('--report', help='export report .json (default <out>.json)')
    p.add_argument('--target-mb', type=float, default=10.0)
    p.add_argument('--opset', type=int, default=17)

    p = sub.add_parser('synth', help='write a tiny synthetic dump (for trying the pipeline, not for results)')
    p.add_argument('--out', required=True)
    p.add_argument('--assemblies', type=int, default=12)
    p.add_argument('--seed', type=int, default=0)
    return ap


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.cmd == 'index':
        from joints.data import build_index
        ids = [l.strip() for l in open(args.ids, encoding='utf-8') if l.strip()] if args.ids else None
        build_index(args.dump, args.out, args.gap_mm, args.seed, args.val, args.test, ids, args.workers,
                    log=lambda *a: print(*a, file=sys.stderr, flush=True))
        return 0
    if args.cmd == 'synth':
        from joints.synth import write_dump
        ids = write_dump(args.out, args.assemblies, args.seed)
        print(f'{len(ids)} synthetic assemblies in {args.out}', file=sys.stderr)
        return 0
    try:
        import torch  # noqa: F401
    except ImportError:
        print(f'{args.cmd} needs PyTorch (pip install -r compute/requirements.txt)', file=sys.stderr)
        return 2
    from joints import train as T
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
