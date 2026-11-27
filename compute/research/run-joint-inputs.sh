#!/usr/bin/env bash
# Does the joint model's ceiling come from its inputs? Eight lanes of the EdgeConv winner, each with one change to what
# the model is shown: points drawn from the contact region, a second frame the size of the smaller part, more points,
# and neighbours ranked on input xyz (the graph that exports exactly). Compare with the nine plain seeds in
# joint-ensemble-v1. Every stage resumes.
# STUDY=seeds (Stage 11) trains four more seeds of each exportable member of Stage 10's mixed ensemble, vertex `static` and
# surface `surf-normals-static`, then averages all ten (the two Stage 8/9 checkpoints included) on one GPU.
# STUDY=surface is the second half: the same model on points spread over the parts' faces, with exact contact and
# normals, from the cache `main.py surface` builds (SURFACE).
set -euo pipefail
: "${WORK:=/mnt/shared/cadgang}"
: "${STUDY:=inputs}"
: "${ROOT:=$WORK/joint-$STUDY-v1}"
: "${SURFACE:=$WORK/automate/joints-surface}"
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

# tag | stages | options. The 512-point lanes cost about four times as much per epoch, so they stop at half the epochs.
lanes() {
  if [ "$STUDY" = seeds ]; then
    S="--surface $SURFACE"
    for n in 2 3 4 5; do echo "static-s$n|$STAGES|--edge-graph static --seed $n"; done
    for n in 2 3 4 5; do echo "surf-normals-static-s$n|$STAGES|$S --normals --edge-graph static --seed $n"; done
  elif [ "$STUDY" = surface ]; then
    [ -f "$SURFACE/surface.json" ] || { echo "no surface cache at $SURFACE" >&2; exit 1; }
    S="--surface $SURFACE"
    cat <<L
surf|$STAGES|$S
surf-normals|$STAGES|$S --normals
surf-normals-focus50|$STAGES|$S --normals --focus 0.5
surf-normals-local|$STAGES|$S --normals --local-frame
surf-normals-focus50-local|$STAGES|$S --normals --focus 0.5 --local-frame
surf-normals-static|$STAGES|$S --normals --edge-graph static
surf-normals-focus50-local-static|$STAGES|$S --normals --focus 0.5 --local-frame --edge-graph static
surf-normals-p512|$BIG_STAGES|$S --normals --points 512
L
  else
    cat <<L
focus50|$STAGES|--focus 0.5
local|$STAGES|--local-frame
focus50-local|$STAGES|--focus 0.5 --local-frame
focus75-local|$STAGES|--focus 0.75 --local-frame
static|$STAGES|--edge-graph static
static-focus50-local|$STAGES|--edge-graph static --focus 0.5 --local-frame
p512|$BIG_STAGES|--points 512
p512-focus50-local|$BIG_STAGES|--points 512 --focus 0.5 --local-frame
L
  fi
}
list=$(lanes)
g=0
while IFS='|' read -r tag stages opts; do
  [ "$g" -lt "$LANES" ] || break
  lane "$g" "$tag" "$stages" $opts & pids="$pids $!"
  g=$((g + 1))
done <<LANES
$list
LANES
bad=0; for p in $pids; do wait "$p" || bad=1; done
python compute/research/summarize_joint_sweep.py "$ROOT"
if [ "$STUDY" = seeds ] && [ "$bad" = 0 ]; then
  V="$WORK/joint-inputs-v1/static/run/best.pt" U="$WORK/joint-surface-v1/surf-normals-static/run/best.pt"
  E="$J ensemble --index $INDEX --dump $DUMP --device $DEVICE --batch-size 256 --workers $WORKERS"
  vs="$V $(for n in 2 3 4 5; do printf '%s ' "$ROOT/static-s$n/run/best.pt"; done)" ss="$U $(for n in 2 3 4 5; do printf '%s ' "$ROOT/surf-normals-static-s$n/run/best.pt"; done)"
  $E --ckpts $vs $ss --report "$ROOT/reports/ensemble-ten" || bad=1
  $E --ckpts $vs --report "$ROOT/reports/ensemble-vertex-five" || bad=1
  $E --ckpts $ss --report "$ROOT/reports/ensemble-surface-five" || bad=1
  $E --ckpts "$V" "$ROOT/static-s2/run/best.pt" "$U" "$ROOT/surf-normals-static-s2/run/best.pt" --report "$ROOT/reports/ensemble-four-static" || bad=1
fi
exit "$bad"
