#!/usr/bin/env bash
# Eight seeds of the winning EdgeConv joint model, their ensemble, then students distilled from it that export to ONNX.
# Every stage resumes: a finished report is not recomputed, and trainers continue from their last checkpoint.
set -euo pipefail
: "${WORK:=/mnt/shared/cadgang}"
: "${ROOT:=$WORK/joint-ensemble-v1}"
: "${INDEX:=$WORK/automate/joints-index}"
: "${DUMP:=$WORK/automate/dump}"
: "${PRIOR:=$WORK/joint-architecture-v1/edge-k8-ce-s0/run/best.pt}"   # the earlier winner, seed 0: a ninth member
: "${LANES:=8}" "${DEVICE:=rocm}" "${TEACHER_STAGES:=30 60}" "${STUDENT_STAGES:=10 20}"
: "${TRAIN_EXTRA:=}" "${EVAL_EXTRA:=}"   # a smoke run caps rows with these
ARCH="--encoder edgeconv --edge-k 8 --widths 48,96,192 --focal-gamma 0 --batch-size 48 --points 256"
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
      --workers 3 --val-limit 20000 --ckpt-every 250 --log-every 100 $ARCH $TRAIN_EXTRA "$@"
    $J export --ckpt "$ROOT/$tag/run/best.pt" --out "$ROOT/reports/$tag-e$epochs.onnx" || true
    $J eval --index "$INDEX" --dump "$DUMP" --ckpt "$ROOT/$tag/run/best.pt" --split test --device "$DEVICE" \
      --batch-size 256 --workers 3 --report "$ROOT/reports/$tag-e$epochs" --export-report "$ROOT/reports/$tag-e$epochs.onnx.json" $EVAL_EXTRA
    python compute/research/summarize_joint_sweep.py "$ROOT"
  done
}
all() { bad=0; for p in $pids; do wait "$p" || bad=1; done; pids=""; [ "$bad" = 0 ] || exit 1; }

last=${TEACHER_STAGES##* }
for g in $(seq 0 $((LANES - 1))); do lane "$g" "teacher-s$((g + 1))" "$TEACHER_STAGES" --seed "$((g + 1))" & pids="$pids $!"; done
all

members=$(for g in $(seq 1 "$LANES"); do echo "$ROOT/teacher-s$g/run/best.pt"; done)
[ -f "$PRIOR" ] && members="$members $PRIOR"
# The earlier winner could not be exported; the same weights now can.
[ -f "$PRIOR" ] && { $J export --ckpt "$PRIOR" --out "$ROOT/reports/prior-edge-k8-ce-s0.onnx" || true; }
[ -f "$ROOT/reports/ensemble-e$last.json" ] || ROCR_VISIBLE_DEVICES=0 $J ensemble --index "$INDEX" --dump "$DUMP" \
  --ckpts $members --report "$ROOT/reports/ensemble-e$last" --device "$DEVICE" --batch-size 256 --workers 3

g=0
# alpha in percent, temperature, seed. No dots in a tag: the report writer reads one as a file suffix.
for v in "50 2 10" "50 2 11" "70 2 12" "90 2 13" "100 2 14" "50 4 15" "90 4 16" "70 1 17"; do
  [ "$g" -lt "$LANES" ] || break
  set -- $v
  lane "$g" "student-a$1-t$2-s$3" "$STUDENT_STAGES" --seed "$3" --distill-alpha "0.$(printf %02d "$1" | sed 's/^100$/99/')" --distill-t "$2" --teachers $members & pids="$pids $!"
  g=$((g + 1))
done
all
python compute/research/summarize_joint_sweep.py "$ROOT"
