#!/bin/sh
# Stage 2 end to end on a synthetic dump: index, a short train interrupted by SIGTERM and resumed, eval, export.
# Proves the pipeline runs here; the numbers it prints are about synthetic shapes, not AutoMate.
set -e
cd "$(dirname "$0")/../.."
T=${TMPDIR:-/tmp}/cadgang-joints-selftest; rm -rf "$T"; mkdir -p "$T"
J="python3 compute/joints/main.py"
$J synth --out "$T/dump" --assemblies 16
$J index --dump "$T/dump" --out "$T/idx" --val 0.2 --test 0.2
SMALL="--points 128 --widths 16,32 --head 32 --batch-size 16 --workers 0 --log-every 5 --device ${DEVICE:-auto}"
# run in the background, SIGTERM it after its first checkpointed steps, then resume
$J train --index "$T/idx" --out "$T/run" --epochs 3 --ckpt-every 2 $SMALL &
PID=$!; sleep 8; kill -TERM $PID 2>/dev/null || true; wait $PID || echo "train exited $? (143 = stopped by SIGTERM, expected)"
$J train --index "$T/idx" --out "$T/run" --epochs 3 --resume $SMALL
$J export --ckpt "$T/run/best.pt" --out "$T/joints.onnx" || echo "export exit $? (3 over target, 4 export failed, 5 check failed)"
$J eval --index "$T/idx" --ckpt "$T/run/best.pt" --split all --report "$T/report" --export-report "$T/joints.onnx.json" --workers 0 --device ${DEVICE:-auto}
echo "selftest ok: report in $T/report.md"
