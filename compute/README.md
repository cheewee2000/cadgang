# Cluster work

Work for a session with the GPU cluster. The Mac session (Che-Wei's machine) set this up on 2026-11-01 and keeps the local corpus; this folder is everything the cluster needs from the repo. Results come back as files under `compute/results/` (small: jsonl summaries, markdown reports, model weights only if under a few MB) and as commits that change `web/explode.js` or add a model.

Rules from the repo's CLAUDE.md still apply: don't bump the version, don't change a default someone else chose, `npm test` passes before a PR.

## What the cluster is for

Nothing in cadgang runs on a GPU. The importer is OpenCascade on the CPU and the explode solver is JavaScript. The cluster is a CPU farm for stage 1 and a GPU for stages 2 and 3.

| stage | what | needs |
|---|---|---|
| 1 | **Oracle:** the explode solver scored against 52,000 real assemblies with ground-truth mates | CPU cores, ~60 GB disk, network for a 14 GB download |
| 2 | **Joint predictor:** given two touching parts, predict the mate type and axis | stage 1's dumps, one GPU |
| 3 | **Part classifier:** screw / nut / washer / standoff / PCB / other from a part's shape | labels from the Mac (see below), one GPU |

## Environment

- Node 22 (`package.json` says `>=22.2`). `npm ci` in the repo root.
- The native importer `bin/cadgang-occt` is a Mac binary. On Linux it is absent and `src/core/step.js` falls back to the WASM importer (`occt-import-js`, already a dependency). It is about 5x slower than native and gives slightly different triangle counts, which is fine for the oracle. Nothing to install.
- Python 3 with `pyarrow` and `pandas` for the parquet metadata. PyTorch for stages 2 and 3.
- `npm test` should pass on Linux: the one native-vs-WASM test skips without the binary.

## Dataset: AutoMate (use this one)

Onshape assemblies with their mates, **CC0**: https://zenodo.org/records/7776208 (paper: Jones et al., *AutoMate*, ACM TOG 2021, https://github.com/deGravity/automate).

- 255,211 assemblies, 451,967 parts, 1.29 M mates. Parts as per-part STEP files (`step.zip`, 13.2 GB) plus a JSON per assembly with occurrence transforms and mates (`assemblies.zip`, 0.9 GB). Schema in the record's README.md.
- Mate types and counts in the first 200k mates: FASTENED 103k, PLANAR 47k, REVOLUTE 19k, CYLINDRICAL 17k, SLIDER 7.6k, PARALLEL 4.3k, BALL 0.8k, PIN_SLOT 0.4k.
- Selection used here: top-level assemblies, 3..60 parts, every part has STEP, at least one mate with STEP on both sides. **52,095 assemblies.**
- Distances in the metadata are metres. OCCT meshes are mm. `SCALE=1000` in the harness converts the transforms; check it on the first assembly (parts should touch, not sit 1000x apart).

**Do not use the Fusion 360 Gallery assembly/joint dataset** for anything that ships: its licence is non-commercial research only and forbids passing derivatives on. It is fine to read the JoinABLe paper (Willis et al., CVPR 2022, https://github.com/AutodeskAILab/JoinABLe) for the model design.

## Stage 1: the oracle

```sh
AUTOMATE=/scratch/automate            # anywhere with 60 GB
bash compute/automate/fetch.sh        # downloads and unzips into $AUTOMATE
python3 compute/automate/pick.py    # writes $AUTOMATE/selected.txt (52k ids)
bash compute/automate/selftest.sh     # the harness on two repo fixtures, no download needed
JOBS=64 node compute/automate/explode.automate.mjs --list $AUTOMATE/selected.txt --out compute/results/automate-base.jsonl --dump $AUTOMATE/dump
```

`explode.automate.mjs` imports each part, places it by its occurrence transform, runs `explodeOffsets` with no hints (what the solver guesses from shape alone) and writes one JSON line per assembly:

- `axialN`, `axialOk`: mates of type SLIDER / CYLINDRICAL / REVOLUTE / PIN_SLOT, and how many of them the smaller part leaves along the mate axis (|dot| > 0.95).
- `fastN`, `fastOk`: FASTENED mates where the two parts move together (one rides the other, or same direction).
- `modelOverlaps`, `caused`, `stillAtK1`: the collision count from `test/explode.harness.mjs` (pairs inside each other at slider positions k = 0, 1/8 .. 1; `caused` are pairs that were not inside each other at k = 0).
- `mcfAgree`: distance between the two mate frames of each mate after transforming, relative to assembly size. Should be near 0. If it is near 0 only in `mcfAgreeRaw`, the frames are already in assembly coordinates and the `world()` function in the harness must stop applying the occurrence transform.

`HINTS=1` feeds the mates to the solver as joints (`{type, axis, origin, parent}`, as the viewer does from its joints panel). That is the upper bound: how well the solver does when told the joints. The gap between the two runs is what stage 2 can win.

Resumable: ids already in `--out` are skipped. One child process per assembly, timeout 120 s + 2 s per body. `EXPLODE=path/to/other/explode.js` runs another solver copy for a before/after, as `test/explode.harness.mjs` does.

**Deliverables:** `compute/results/automate-base.jsonl` and `automate-hints.jsonl`, and `compute/results/automate-report.md` with the totals (axial %, fastened %, caused), the worst 50 assemblies by `caused`, and the mate types the solver gets wrong most. Then the same loop as the Mac corpus: propose one rule change at a time in `web/explode.js`, re-run, keep it only if the totals improve and no more than a handful of assemblies get worse, one commit per accepted rule with a synthetic test in `test/explode.test.js`. The Mac session re-gates accepted rules against the three Wink enclosures before merge, so leave the rules on a branch and list them in the report.

## Stage 2: joint predictor

Data is the `--dump` output of stage 1: per assembly `<id>.json` (parts with their occurrence, vertex range, bbox; mates with world axis and origin; the solver's answer) and `<id>.f32` (all vertices, world mm). Build pairs: every two parts whose bboxes touch (gap under 1 mm), label = the mate between them or `NONE`, axis = the mate's z axis.

- Input: two point clouds (sample 1024 points each from the vertices, centre on the pair's joint bbox, scale to unit diagonal) plus the contact region (points of each within 1 mm of the other).
- Output: type ∈ {FASTENED, REVOLUTE, SLIDER, CYLINDRICAL, PLANAR, BALL, NONE} and a unit axis (ignore the axis loss for FASTENED/PLANAR/BALL/NONE). PIN_SLOT and PARALLEL are rare: fold into SLIDER and PLANAR.
- Start with a PointNet-style encoder per part and an MLP on the pair, before anything fancier. JoinABLe is the reference for the harder B-rep graph version; its data cannot be used, its design can.
- Split by assembly id, not by pair. Report type accuracy and axis angular error per type, and compare against the rule solver's own axis from the same dump (`solve[].dir` of the smaller part).

**Code:** `compute/joints/` (see its README): `main.py index | train | eval | export`, with checkpoint/resume and SIGTERM handling, and `selftest.sh` on a synthetic dump. Not yet run on the real dumps.

**Deliverable:** training script under `compute/joints/`, a report, and if the axis error beats the rule solver on CYLINDRICAL/SLIDER/REVOLUTE, an export path: weights small enough to ship (ONNX, < 10 MB) and a note on how to call it from `src/server/` so the viewer gets a joint suggestion for a selected pair (the J key) and `explodeOffsets` gets it as a hint. Wiring into the app is the Mac session's job.

## Stage 3: part classifier

Labels come from body names in Che-Wei's own corpus (2,573 files on the Mac, names like `M3x8 SHCS`, `Hex Nut`, `Washer`, `PCB`), which does not leave the Mac through git. The Mac session runs `compute/labels/export.mjs` over the corpus and the user copies the result to the cluster by hand:

```sh
JOBS=8 node compute/labels/export.mjs --list ~/cadgang-corpus/corpus.tsv --out ~/cadgang-corpus/parts-labelled.jsonl
gzip -k ~/cadgang-corpus/parts-labelled.jsonl      # then scp it to the cluster; it is too big for git
```

One JSON line per named body: `label`, `name`, `file` (basename), `nVerts`, `size` (bbox, mm) and `pts`, 1024 vertices sampled evenly from the body's vertex list (not area-weighted), centred on the bbox centre, mm. The label is a regex on the cleaned name, first match wins: screw, nut, washer, standoff, bearing, magnet, spring, oring, pcb, component (R12, C3, connectors, ICs), battery, other. Bodies with CAD feature names (`body12`, `fillet3`) are skipped. The same shape repeated in one file (a pattern of screws) is one record. `other` is capped at 4 and `component` at 10 per file. Expect label noise: the names are what designers typed. Check a sample before trusting a class.

Classes to predict: screw, nut, washer, standoff, pcb, component, other, and whatever else has a few hundred examples. Target: label the unnamed bodies on import (half the corpus's bodies have no name) so the Bodies panel shows a guess and the solver knows a fastener is a fastener. Same PointNet encoder as stage 2. AutoMate parts can pre-train the encoder unsupervised, and FASTENED-mate counts per part are a weak "fastener" label there.

**Code:** `compute/parts/` (see its README): `validate.py` checks the labelled JSONL before any training, and `main.py cache | train | eval | export` trains and reports. `main.py pretrain` is the optional unsupervised AutoMate encoder pretraining. The FASTENED weak label is deliberately not implemented. Shared pieces are in `compute/cadnn/`; the tests are `python3 -m unittest discover -s compute/tests -v`.

## Reporting back

Commit results and reports under `compute/results/`, code under `compute/`, solver changes on a branch named `explode/automate-*`. Keep the dumps and the dataset on the cluster, not in git. The Mac session merges after re-gating on the Wink enclosures.
