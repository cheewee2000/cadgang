#!/usr/bin/env bash
# Eight-GPU, interruption-safe geometry pretraining and transfer study.
# Each lane varies point resolution and seed, writes checkpoints after every stage,
# then transfers XYZ encoder weights into the joint predictor and evaluates it.
set -euo pipefail

: "${WORK:=/mnt/shared/cadgang}"
: "${ROOT:=$WORK/geometry-transfer-v1}"
: "${INDEX:=$WORK/automate/joints-index}"
: "${DUMP:=$WORK/automate/dump}"
: "${GPU_COUNT:=8}"
mkdir -p "$ROOT/logs" "$ROOT/reports"

pids=""
stop_children() {
  echo "Stopping lanes; each trainer will checkpoint after its current batch" >&2
  for p in $pids; do kill -TERM "$p" 2>/dev/null || true; done
  wait || true
  exit 143
}
trap stop_children TERM INT

run_lane() {
  gpu=$1
  case "$gpu" in
    0) points=128; batch=256; seed=0 ;;
    1) points=128; batch=256; seed=1 ;;
    2) points=256; batch=128; seed=0 ;;
    3) points=256; batch=128; seed=1 ;;
    4) points=256; batch=128; seed=2 ;;
    5) points=512; batch=64;  seed=0 ;;
    6) points=512; batch=64;  seed=1 ;;
    7) points=512; batch=64;  seed=2 ;;
    *) echo "unsupported lane $gpu" >&2; return 2 ;;
  esac
  tag="p${points}-s${seed}"
  lane="$ROOT/$tag"
  pre="$lane/pretrain"
  mkdir -p "$lane"
  exec >"$ROOT/logs/$tag.log" 2>&1
  echo "lane=$gpu tag=$tag points=$points seed=$seed started=$(date -u +%FT%TZ)"
  ROCR_VISIBLE_DEVICES="$gpu" python - <<'PY'
import torch
assert torch.cuda.is_available(), "ROCm GPU is not visible"
assert torch.cuda.device_count() == 1, torch.cuda.device_count()
print(torch.__version__, torch.version.hip, torch.cuda.get_device_name(0), flush=True)
PY

  # Early stages guarantee usable outputs quickly; later stages consume the remaining budget productively.
  for epochs in 2 5 10 20 40; do
    echo "--- pretrain through epoch $epochs ---"
    ROCR_VISIBLE_DEVICES="$gpu" python compute/parts/main.py pretrain \
      --dump "$DUMP" --out "$pre" --resume --device rocm \
      --epochs "$epochs" --points "$points" --decoder-points "$points" \
      --batch-size "$batch" --workers 3 --seed "$seed" \
      --ckpt-every 250 --log-every 100
    cp "$pre/encoder.pt" "$lane/encoder-e${epochs}.pt"
    cp "$pre/encoder.json" "$lane/encoder-e${epochs}.json"

    joint="$lane/joints-e${epochs}"
    echo "--- transfer and joint fine-tune: pretrain epoch $epochs ---"
    ROCR_VISIBLE_DEVICES="$gpu" python compute/joints/main.py train \
      --index "$INDEX" --dump "$DUMP" --out "$joint" --resume --device rocm \
      --init-encoder "$lane/encoder-e${epochs}.pt" \
      --augment none --seed "$seed" --epochs 30 --batch-size 128 --workers 3 \
      --ckpt-every 250 --log-every 100
    ROCR_VISIBLE_DEVICES="$gpu" python compute/joints/main.py eval \
      --index "$INDEX" --dump "$DUMP" --ckpt "$joint/best.pt" \
      --split test --report "$ROOT/reports/$tag-e${epochs}" \
      --predictions "$lane/joints-e${epochs}-test.jsonl" \
      --device rocm --batch-size 256 --workers 3
    python compute/joints/main.py export --ckpt "$joint/best.pt" \
      --out "$ROOT/reports/$tag-e${epochs}.onnx"
    python compute/research/summarize_transfer.py "$ROOT"
  done
  echo "lane=$gpu tag=$tag completed=$(date -u +%FT%TZ)"
}

for gpu in $(seq 0 $((GPU_COUNT - 1))); do
  run_lane "$gpu" &
  pids="$pids $!"
done
failed=0
for p in $pids; do wait "$p" || failed=1; done
python compute/research/summarize_transfer.py "$ROOT"
exit "$failed"
