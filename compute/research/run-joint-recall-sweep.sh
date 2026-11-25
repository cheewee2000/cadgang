#!/usr/bin/env bash
# Focused follow-up: improve REVOLUTE/CYLINDRICAL recall without losing calibrated precision.
set -euo pipefail
: "${WORK:=/mnt/shared/cadgang}"
: "${ROOT:=$WORK/joint-recall-v1}"
: "${INDEX:=$WORK/automate/joints-index}"
: "${DUMP:=$WORK/automate/dump}"
mkdir -p "$ROOT/logs" "$ROOT/reports"
pids=""
stop(){ for p in $pids; do kill -TERM "$p" 2>/dev/null || true; done; wait || true; exit 143; }
trap stop TERM INT
run(){
 gpu=$1
 case "$gpu" in
  0) tag=edge-k4-inv-n1; opts="--encoder edgeconv --edge-k 4 --widths 48,96,192 --class-weight inv --none-ratio 1 --seed 10 --batch-size 48";;
  1) tag=edge-k8-inv-n1; opts="--encoder edgeconv --edge-k 8 --widths 48,96,192 --class-weight inv --none-ratio 1 --seed 11 --batch-size 48";;
  2) tag=edge-k12-inv-n1; opts="--encoder edgeconv --edge-k 12 --widths 48,96,192 --class-weight inv --none-ratio 1 --seed 12 --batch-size 48";;
  3) tag=edge-k8-sqrt-n05; opts="--encoder edgeconv --edge-k 8 --widths 48,96,192 --class-weight sqrt-inv --none-ratio 0.5 --seed 13 --batch-size 48";;
  4) tag=edge-k8-inv-f1; opts="--encoder edgeconv --edge-k 8 --widths 48,96,192 --class-weight inv --none-ratio 1 --focal-gamma 1 --seed 14 --batch-size 48";;
  5) tag=edge-k8-inv-contact2; opts="--encoder edgeconv --edge-k 8 --widths 48,96,192 --class-weight inv --none-ratio 1 --contact-mm 2 --seed 15 --batch-size 48";;
  6) tag=attn192-inv-n1; opts="--encoder attention --attn-width 192 --attn-heads 6 --attn-tokens 16 --attn-layers 3 --class-weight inv --none-ratio 1 --seed 16 --batch-size 96";;
  7) tag=attn192-inv-f1; opts="--encoder attention --attn-width 192 --attn-heads 6 --attn-tokens 16 --attn-layers 3 --class-weight inv --none-ratio 1 --focal-gamma 1 --seed 17 --batch-size 96";;
 esac
 lane="$ROOT/$tag"; mkdir -p "$lane"; exec >"$ROOT/logs/$tag.log" 2>&1
 ROCR_VISIBLE_DEVICES="$gpu" python -c 'import torch; assert torch.cuda.device_count()==1'
 for epochs in 10 20 40 60 80; do
  ROCR_VISIBLE_DEVICES="$gpu" python compute/joints/main.py train --index "$INDEX" --dump "$DUMP" --out "$lane/run" --resume --device rocm --points 256 --epochs "$epochs" --workers 3 --val-limit 20000 --ckpt-every 250 --log-every 100 $opts
  ROCR_VISIBLE_DEVICES="$gpu" python compute/joints/main.py eval --index "$INDEX" --dump "$DUMP" --ckpt "$lane/run/best.pt" --split test --report "$ROOT/reports/$tag-e$epochs" --predictions "$lane/test-e$epochs.jsonl" --device rocm --batch-size 256 --workers 3
  python compute/joints/main.py export --ckpt "$lane/run/best.pt" --out "$ROOT/reports/$tag-e$epochs.onnx" || true
  python compute/research/summarize_joint_sweep.py "$ROOT"
 done
}
for g in $(seq 0 7); do run "$g" & pids="$pids $!"; done
bad=0; for p in $pids; do wait "$p" || bad=1; done
python compute/research/summarize_joint_sweep.py "$ROOT"; exit "$bad"
