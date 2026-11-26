#!/usr/bin/env bash
# Does the joint model's ceiling come from its inputs? Eight lanes of the EdgeConv winner, each with one change to what
# the model is shown: points drawn from the contact region, a second frame the size of the smaller part, more points,
# and neighbours ranked on input xyz (the graph that exports exactly). Compare with the nine plain seeds in
# joint-ensemble-v1. Every stage resumes.
set -euo pipefail
: "${WORK:=/mnt/shared/cadgang}"
: "${ROOT:=$WORK/joint-inputs-v1}"
: "${INDEX:=$WORK/automate/joints-index}"
: "${DUMP:=$WORK/automate/dump}"
: "${LANES:=8}" "${DEVICE:=rocm}" "${STAGES:=30 60}" "${BIG_STAGES:=15 30}" "${WORKERS:=6}"
: "${TRAIN_EXTRA:=}" "${EVAL_EXTRA:=}"   # a smoke run caps rows with these
ARCH="--encoder edgeconv --edge-k 8 --widths 48,96,192 --focal-gamma 0 --batch-size 48 --points 256 --seed 1"
J="python compute/joints/main.py"
mkdir -p "$ROOT/logs" "$ROOT/reports"
pids=""
stop() { for p in $pids; do kill -TERM "$p" 2>/dev/null || true; done; wait || true; exit 143; }
trap stop TERM INT

# lane <gpu> <tag> <stages> <train options...>: train through each stage, then evaluate and export what it has
lane() {
  gpu=$1 tag=$2 stages=$3; shift 3
  exec >>"$ROOT/logs/$tag.log" 2>&1
  export ROCR_VISIBLE_DEVICES="$gpu"
  for epochs in $stages; do
    [ -f "$ROOT/reports/$tag-e$epochs.json" ] && continue
    $J train --index "$INDEX" --dump "$DUMP" --out "$ROOT/$tag/run" --resume --device "$DEVICE" --epochs "$epochs" \
      --workers "$WORKERS" --val-limit 20000 --ckpt-every 250 --log-every 100 $ARCH $TRAIN_EXTRA "$@"
    $J export --ckpt "$ROOT/$tag/run/best.pt" --out "$ROOT/reports/$tag-e$epochs.onnx" || true
    $J eval --index "$INDEX" --dump "$DUMP" --ckpt "$ROOT/$tag/run/best.pt" --split test --device "$DEVICE" \
      --batch-size 256 --workers "$WORKERS" --report "$ROOT/reports/$tag-e$epochs" --export-report "$ROOT/reports/$tag-e$epochs.onnx.json" $EVAL_EXTRA
    python compute/research/summarize_joint_sweep.py "$ROOT"
  done
}

g=0
# tag | stages | options. The 512-point lanes cost about four times as much per epoch, so they stop at half the epochs.
while IFS='|' read -r tag stages opts; do
  [ "$g" -lt "$LANES" ] || break
  lane "$g" "$tag" "$stages" $opts & pids="$pids $!"
  g=$((g + 1))
done <<LANES
focus50|$STAGES|--focus 0.5
local|$STAGES|--local-frame
focus50-local|$STAGES|--focus 0.5 --local-frame
focus75-local|$STAGES|--focus 0.75 --local-frame
static|$STAGES|--edge-graph static
static-focus50-local|$STAGES|--edge-graph static --focus 0.5 --local-frame
p512|$BIG_STAGES|--points 512
p512-focus50-local|$BIG_STAGES|--points 512 --focus 0.5 --local-frame
LANES
bad=0; for p in $pids; do wait "$p" || bad=1; done
python compute/research/summarize_joint_sweep.py "$ROOT"
exit "$bad"
