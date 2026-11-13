#!/bin/sh
# Stage 3 end to end on synthetic data: validate, cache, optional pretraining on a synthetic dump, train with the
# pretrained encoder, eval, export. Proves the pipeline runs here; the numbers are about synthetic shapes.
set -e
cd "$(dirname "$0")/../.."
T=${TMPDIR:-/tmp}/cadgang-parts-selftest; rm -rf "$T"; mkdir -p "$T"
P="python3 compute/parts/main.py"
$P synth --out "$T/parts.jsonl" --per-class 20 --points 256 --bad
$P validate "$T/parts.jsonl" --points 256 || echo "validate exit $? (expected: the --bad lines are over the 1% limit)"
$P validate "$T/parts.jsonl" --points 256 --max-invalid 0.1
$P cache --jsonl "$T/parts.jsonl" --out "$T/cache" --points 128
SMALL="--widths 16,32 --batch-size 16 --workers 0 --log-every 10 --device ${DEVICE:-auto}"
python3 compute/joints/main.py synth --out "$T/dump" --assemblies 4
$P pretrain --dump "$T/dump" --out "$T/pre" --epochs 2 --points 128 --decoder-points 64 --decoder-hidden 64,128 $SMALL
$P train --cache "$T/cache" --out "$T/run" --epochs 5 --head 32 --init-encoder "$T/pre/encoder.pt" $SMALL
$P export --ckpt "$T/run/best.pt" --out "$T/parts.onnx" || echo "export exit $? (3 over target, 4 export failed, 5 check failed)"
$P eval --ckpt "$T/run/best.pt" --split all --report "$T/report" --export-report "$T/parts.onnx.json" --workers 0 --device ${DEVICE:-auto}
echo "selftest ok: report in $T/report.md"
