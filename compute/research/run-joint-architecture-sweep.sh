#!/usr/bin/env bash
# Eight-lane supervised joint architecture sweep. Checkpoints and evaluates every 10 epochs.
set -euo pipefail
: "${WORK:=/mnt/shared/cadgang}"
: "${ROOT:=$WORK/joint-architecture-v1}"
: "${INDEX:=$WORK/automate/joints-index}"
: "${DUMP:=$WORK/automate/dump}"
mkdir -p "$ROOT/logs" "$ROOT/reports"
pids=""
stop_children() {
  echo "Stopping lanes; trainers checkpoint after their current batch" >&2
  for p in $pids; do kill -TERM "$p" 2>/dev/null || true; done
  wait || true
  exit 143
}
trap stop_children TERM INT

run_lane() {
  gpu=$1
  case "$gpu" in
    0) tag=pointnet-ce-s0;   opts="--encoder pointnet --focal-gamma 0 --seed 0 --batch-size 128" ;;
    1) tag=pointnet-f2-s1;   opts="--encoder pointnet --focal-gamma 2 --seed 1 --batch-size 128" ;;
    2) tag=edge-k8-ce-s0;    opts="--encoder edgeconv --edge-k 8 --widths 48,96,192 --focal-gamma 0 --seed 0 --batch-size 48" ;;
    3) tag=edge-k12-f2-s1;   opts="--encoder edgeconv --edge-k 12 --widths 48,96,192 --focal-gamma 2 --seed 1 --batch-size 48" ;;
    4) tag=attn128-t8-ce-s0; opts="--encoder attention --attn-width 128 --attn-heads 4 --attn-tokens 8 --attn-layers 2 --focal-gamma 0 --seed 0 --batch-size 128" ;;
    5) tag=attn128-t16-f2-s1; opts="--encoder attention --attn-width 128 --attn-heads 4 --attn-tokens 16 --attn-layers 2 --focal-gamma 2 --seed 1 --batch-size 128" ;;
    6) tag=attn192-t16-ce-s2; opts="--encoder attention --attn-width 192 --attn-heads 6 --attn-tokens 16 --attn-layers 3 --focal-gamma 0 --seed 2 --batch-size 96" ;;
    7) tag=attn192-t16-f2-s3; opts="--encoder attention --attn-width 192 --attn-heads 6 --attn-tokens 16 --attn-layers 3 --focal-gamma 2 --seed 3 --batch-size 96" ;;
    *) return 2 ;;
  esac
  lane="$ROOT/$tag"
  mkdir -p "$lane"
  exec >"$ROOT/logs/$tag.log" 2>&1
  echo "lane=$gpu tag=$tag opts=$opts started=$(date -u +%FT%TZ)"
  ROCR_VISIBLE_DEVICES="$gpu" python - <<'PY'
import torch
assert torch.cuda.is_available() and torch.cuda.device_count() == 1
print(torch.__version__, torch.version.hip, torch.cuda.get_device_name(0), flush=True)
PY
  for epochs in 10 20 30 40 60; do
    echo "--- train through epoch $epochs ---"
    ROCR_VISIBLE_DEVICES="$gpu" python compute/joints/main.py train \
      --index "$INDEX" --dump "$DUMP" --out "$lane/run" --resume --device rocm \
      --points 256 --epochs "$epochs" --workers 3 --val-limit 20000 \
      --ckpt-every 250 --log-every 100 $opts
    echo "--- evaluate epoch $epochs ---"
    ROCR_VISIBLE_DEVICES="$gpu" python compute/joints/main.py eval \
      --index "$INDEX" --dump "$DUMP" --ckpt "$lane/run/best.pt" \
      --split test --report "$ROOT/reports/$tag-e${epochs}" \
      --predictions "$lane/test-e${epochs}.jsonl" --device rocm --batch-size 256 --workers 3
    python compute/joints/main.py export --ckpt "$lane/run/best.pt" \
      --out "$ROOT/reports/$tag-e${epochs}.onnx" || true
    python compute/research/summarize_joint_sweep.py "$ROOT"
  done
  echo "lane=$gpu tag=$tag completed=$(date -u +%FT%TZ)"
}

for gpu in $(seq 0 7); do run_lane "$gpu" & pids="$pids $!"; done
failed=0
for p in $pids; do wait "$p" || failed=1; done
python compute/research/summarize_joint_sweep.py "$ROOT"
exit "$failed"
