#!/usr/bin/env bash
# Run after the shared volume is attached and the Stage 1 oracle has produced its dump.
# Usage: WORK=/mnt/shared/cadgang LABELS=/mnt/shared/cadgang/parts-labelled.jsonl.gz bash compute/run-all.sh
set -euo pipefail
WORK=${WORK:-/mnt/shared/cadgang}
AUTOMATE=${AUTOMATE:-$WORK/automate}
LABELS=${LABELS:-$WORK/parts-labelled.jsonl.gz}
PYTHON=${PYTHON:-python3}
mkdir -p "$WORK/results"

# Stage 2: one shared PointNet predicts joint type and axis from Stage 1 dumps.
"$PYTHON" compute/joints/main.py index --dump "$AUTOMATE/dump" --out "$WORK/joints-index" --workers "${WORKERS:-16}"
"$PYTHON" compute/joints/main.py train --index "$WORK/joints-index" --out "$WORK/joints-run" --workers "${WORKERS:-16}" --resume
"$PYTHON" compute/joints/main.py export --ckpt "$WORK/joints-run/best.pt" --out "$WORK/results/joints.onnx"
"$PYTHON" compute/joints/main.py eval --index "$WORK/joints-index" --ckpt "$WORK/joints-run/best.pt" --report "$WORK/results/joints-report" --export-report "$WORK/results/joints.onnx.json"

# Stage 3: validate, cache and train the Mac-labelled corpus. Unsupported labels stay out unless explicitly mapped.
"$PYTHON" compute/parts/validate.py "$LABELS" --json "$WORK/results/parts-labelled-validation.json"
"$PYTHON" compute/parts/main.py cache --jsonl "$LABELS" --out "$WORK/parts-cache"
"$PYTHON" compute/parts/main.py train --cache "$WORK/parts-cache" --out "$WORK/parts-run" --resume
"$PYTHON" compute/parts/main.py export --ckpt "$WORK/parts-run/best.pt" --out "$WORK/results/parts.onnx"
"$PYTHON" compute/parts/main.py eval --cache "$WORK/parts-cache" --ckpt "$WORK/parts-run/best.pt" --report "$WORK/results/parts-report" --export-report "$WORK/results/parts.onnx.json" --predictions "$WORK/results/parts-test.jsonl"
