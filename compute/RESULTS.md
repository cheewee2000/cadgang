# CADgang compute results

Measured on the AutoMate CC0 corpus and `us-mi355x-cwt-k8s` in November 2026. Dataset, per-assembly dumps, checkpoints and predictions remain on shared storage, not in git.

## Stage 1 — explode oracle

52,095 selected assemblies; baseline and mate-hint passes ran on the cluster's CPU worker. Total elapsed time was 37.21 hours. No GPU capacity or credits were used.

| metric | shape-only solver | ground-truth mate hints |
|---|---:|---:|
| succeeded | 51,788 | 51,779 |
| errors | 307 | 316 |
| axial mate accuracy | 61.42% | 71.90% |
| FASTENED together | 71.22% | 82.40% |
| collisions introduced | 34,484 | 40,356 |
| introduced collisions left at k=1 | 9,248 | 9,813 |

Shape-only disagreement by scored mate type:

| type | wrong |
|---|---:|
| SLIDER | 50.30% |
| REVOLUTE | 38.80% |
| PIN_SLOT | 30.25% |
| CYLINDRICAL | 29.62% |
| FASTENED | 28.78% |

Mate hints improve semantic direction/grouping but worsen collisions. A learned hint must therefore remain behind the collision-aware solver rather than replace it.

Artifacts on shared storage:

- `/mnt/shared/cadgang/results/full/automate-base.jsonl`
- `/mnt/shared/cadgang/results/full/automate-hints.jsonl`
- `/mnt/shared/cadgang/results/full/automate-report.md`
- `/mnt/shared/cadgang/automate/dump/` — 9.5 GB, Stage 2 input

## Stage 2 — joint predictor

Index: 848,696 touching-part pairs from 50,890 assemblies, split by assembly ID. Eight 20-epoch experiments compared no rotation, Z rotation and SO(3) rotation. The corrected sweep used 11.02 GPU-hours without preemption. An initial binding mistake completed one useful model on GPU 0 before being stopped; total spend across both holds was approximately 72.35 credits. The standing cluster limit was withdrawn after completion.

| augmentation | test accuracy | median axis error |
|---|---:|---:|
| none | 64.4–64.6% | 3.24–3.29° |
| Z | 62.9–63.2% | 9.7–10.6° |
| SO(3) | 61.4–62.0% | 19.3–23.5° |

World orientation is useful signal in this corpus. The no-rotation model beats the shape solver's axis on SLIDER, but not on REVOLUTE or CYLINDRICAL, so it **does not pass the automatic-explode shipping gate**.

The best no-rotation model is useful as an optional high-confidence suggestion:

| confidence | precision | coverage |
|---:|---:|---:|
| ≥0.80 | 96.42% | 15.50% |
| ≥0.90 | 97.72% | 9.26% |
| ≥0.95 | 98.19% | 5.61% |
| ≥0.99 | 99.12% | 1.18% |

At confidence ≥0.90: SLIDER precision 98.67%, REVOLUTE 95.68%, CYLINDRICAL 93.09%, FASTENED 97.46%. Recommended product use: suggest a joint type/axis for human confirmation; never silently drive explode.

Verified ONNX files are 2.30 MB. Results live under `/mnt/shared/cadgang/results/joints-v2/`.

## Stage 3 — part classifier readiness

The first corpus export had 3,853 valid bodies but systematic name-rule noise. The audited exporter correction changed 81 labels, including spring-steel cotter pins, bearing envelopes, magnet covers and battery contacts that were false positives.

Corrected counts:

| class | bodies |
|---|---:|
| other | 3,339 |
| screw | 157 |
| component | 152 |
| nut | 60 |
| magnet | 39 |
| spring | 34 |
| PCB | 30 |
| O-ring | 14 |
| standoff | 12 |
| washer | 7 |
| battery | 7 |
| bearing | 2 |

A 12-class production model is not justified yet: five classes have fewer than 20 examples and some are absent from validation/test splits. Review and expand rare classes before GPU training. `compute/labels/relabel.mjs` and `compute/labels/review.py` are the repeatable audit workflow.

## Stage 4 — supervised joint architecture sweep

Eight GPU lanes compared the PointNet control with dynamic EdgeConv and lightweight attention-set encoders, with cross-entropy and focal-loss variants. Every lane trained to 60 epochs, evaluated at staged checkpoints, fit its confidence temperature on the validation split, and exported its best checkpoint. One market node left during the run; SIGTERM checkpoints on the shared volume let every lane resume on its replacement. The completed sweep produced 40 evaluated configurations under `/mnt/shared/cadgang/joint-architecture-v1/`.

Product-facing comparison against the prior PointNet baseline:

| model | test accuracy | median axis error | precision at p≥0.90 | coverage at p≥0.90 |
|---|---:|---:|---:|---:|
| prior baseline | 64.6% | 3.24° | 97.72% | 9.26% |
| EdgeConv k=8, CE, 60 epochs | **65.16%** | **0.75°** | 95.73% | 18.92% |
| attention 128/8 tokens, CE | 63.28% | 1.78° | 96.25% | **20.43%** |
| attention 192/16 tokens, CE, 60 epochs | 62.73% | 1.55° | 96.76% | 19.69% |

EdgeConv is the best balanced candidate: slightly higher type accuracy, about 77% lower median axis error, and roughly twice the high-confidence coverage. Attention gives the best macro balance and CYLINDRICAL recall (34.0%) but lower aggregate accuracy. No model beats the exact shape solver's zero-median axis on REVOLUTE or CYLINDRICAL; every leading model still beats it on SLIDER. Recommended product use remains a calibrated, confidence-gated joint suggestion for human confirmation, never a silent automatic-explode hint.

Artifacts include checkpoints, calibrated test reports, predictions, ONNX exports and `summary.{md,json,csv}` under `/mnt/shared/cadgang/joint-architecture-v1/`.

## Stage 5 — focused joint recall sweep

A focused eight-lane follow-up varied EdgeConv neighbourhood size, class weighting, NONE-negative ratio, focal loss and contact radius, with attention controls. Forty configurations trained through 80 epochs. The run completed in 4h11m without restarts; artifacts are under `/mnt/shared/cadgang/joint-recall-v1/`.

The aggressive inverse-class weighting did recover minority classes, but at an unacceptable aggregate cost:

| model | accuracy | macro F1 | median axis | REVOLUTE recall | CYLINDRICAL recall | p≥0.90 precision / coverage |
|---|---:|---:|---:|---:|---:|---:|
| prior EdgeConv k=8 CE | **65.16%** | 0.440 | **0.75°** | 49.2% | 16.0% | 95.73% / **18.92%** |
| EdgeConv sqrt-inv, NONE 0.5, 60 epochs | 62.25% | **0.442** | 0.84° | 52.5% | 18.6% | 96.12% / 15.43% |
| EdgeConv k=12 inverse, 40 epochs | 44.60% | 0.376 | 1.07° | 43.8% | **59.4%** | 96.44% / 7.81% |

Conclusion: the recall ceiling is not solved by reweighting. Strong inverse weights mostly trade NONE/FASTENED accuracy for CYLINDRICAL predictions. Keep the prior EdgeConv model as the balanced research winner; use the recall models only as evidence for a future hierarchical or specialist classifier. Dynamic EdgeConv still fails the current ONNX exporter on its `cdist/topk/index` neighbourhood graph, so deployment requires an export-compatible neighbourhood implementation or an export-friendly model.

## Stage 6 — geometry pretraining transfer (2026-11-21)

`compute/research/run-geometry-transfer.sh` pretrained the unsupervised AutoMate part encoder (`compute/parts/main.py pretrain`) on eight GPU lanes at 128, 256 and 512 points, and after 2, 5, 10, 20 and 40 pretraining epochs moved its XYZ weights into the joint predictor (`--init-encoder`) and trained and evaluated that. Forty runs; artifacts and `summary.{md,json,csv}` are under `/mnt/shared/cadgang/geometry-transfer-v1/`. This section was written on 2026-11-26 from that summary; the study itself was not recorded here when it ran.

| | test accuracy | median axis error |
|---|---:|---:|
| prior PointNet baseline | 64.6% | 3.24° |
| 34 best-scoring transfer runs | 63.9% to 65.2% | 2.15° to 3.03° |
| EdgeConv k=8, CE (Stage 4) | 65.16% | 0.75° |

Conclusion: pretraining does not help. Accuracy stays at the baseline whatever the point count, and it does not rise with pretraining epochs (the 2-epoch runs score 64.6% to 65.2%, the 40-epoch runs 64.3% to 64.8%). The axis error is about a degree better than the PointNet baseline and still three times the EdgeConv model's. Nothing here is worth carrying forward.

## Stage 7 — seed ensemble, distillation and EdgeConv export (2026-11-26)

`compute/research/run-joint-ensemble.sh` (Job `compute/k8s/joint-ensemble-v1.yaml`, 8 GPUs, 6 h, no restarts) asked three questions of the Stage 4 winner (EdgeConv k=8, CE, widths 48,96,192, 256 points):

1. **Does averaging seeds beat one model?** Yes. Eight new seeds trained to 60 epochs; `main.py ensemble` averages the type probabilities and the sign-aligned axes of those eight plus the Stage 4 checkpoint, and fits one temperature on validation.
2. **Does one distilled model keep the gain?** Mostly not. Eight students trained 20 epochs against the nine teachers' averaged, softened probabilities (`--teachers`, `--distill-alpha`, `--distill-t`); the axis still learns from ground truth.
3. **Does EdgeConv export to ONNX now?** It exports. It does not yet match PyTorch reliably.

| model | test accuracy | macro F1 | median axis | REVOLUTE recall | CYLINDRICAL recall | p≥0.90 precision / coverage |
|---|---:|---:|---:|---:|---:|---:|
| Stage 4 EdgeConv k=8 CE | 65.16% | 0.440 | 0.75° | 49.2% | 16.0% | 95.73% / 18.92% |
| eight new seeds, 60 epochs (range) | 64.97% to 65.75% | 0.418 to 0.442 | 0.69° to 0.96° | 48.3% to 52.1% | 13.8% to 18.6% | 95.2% to 95.8% / 18.9% to 21.1% |
| eight new seeds, mean | 65.34% | | | | | |
| **ensemble of nine** | **66.90%** | **0.450** | **0.37°** | 52.0% | 14.3% | **95.83% / 22.54%** |
| eight students, 20 epochs (range) | 65.50% to 65.82% | 0.403 to 0.425 | 0.53° to 0.76° | 42.2% to 47.9% | 9.3% to 14.3% | 95.3% to 95.8% / 18.2% to 19.7% |
| eight students, mean | 65.67% | | | | | |
| best student (alpha 0.9, T 2, seed 13) | 65.82% | 0.413 | 0.53° | 42.8% | 10.5% | 95.56% / 19.34% |

**Ensemble.** +1.6 points of accuracy over the average single model, half the median axis error, and 22.5% of pairs above p≥0.90 at unchanged precision. Seed-to-seed spread is 0.8 points, so the gain is well outside it. The per-type picture does not change: PLANAR (5.5% recall) and CYLINDRICAL (14.3%) are still mostly read as FASTENED or NONE, and the model still beats the shape solver's axis only on SLIDER. The ensemble costs nine forward passes (nine 1.97 MB files).

**Distillation.** A student reaches 65.5% to 65.8% in 20 epochs, about 0.3 points above the average 60-epoch teacher, so it recovers roughly a fifth of the ensemble's gain. It pays for that in the minority classes: REVOLUTE and CYLINDRICAL recall and macro F1 are all below the teachers'. No setting of alpha (0.5 to 0.99) or temperature (1, 2, 4) stands out; the differences between students are the size of the seed spread. Longer student training was not tried.

**Export.** All 33 checkpoints export (opset 17, 1.97 MB), which the `cdist` / indexed-gather neighbourhood in Stage 4 and 5 could not. The agreement check is weaker: on random inputs onnxruntime is within 1e-3 of PyTorch for 19 of the 33 files, and the worst file (`teacher-s8-e60`) is off by 7.5 in a logit. The cause is the neighbour search in the later EdgeConv blocks, which ranks on the first three feature channels: exact and near ties there are broken differently by the two runtimes. The index tie-break (`d + arange(n) * 1e-7`) made the Stage 4 checkpoint agree on all 3,000 real validation pairs tested (before it, 4% of pairs got another answer), but it is below float32 resolution once distances are not near zero, so it does not cover every checkpoint. Before any of these files ships, compare its answers with PyTorch's on real pairs, not random ones; a durable fix is to rank neighbours on something that cannot tie (the input coordinates, or a stable sort).

Conclusion: if joint suggestions ship, ship the ensemble or nothing new. It is the only result in Stages 4 to 7 that moves accuracy by more than seed noise, and it also gives the best axis and the most high-confidence coverage. A single distilled model is not a substitute. The class ceiling (PLANAR, CYLINDRICAL) is untouched by any of this and needs different inputs or labels, not more seeds.

Artifacts: checkpoints, reports, predictions, ONNX files and `summary.{md,json,csv}` under `/mnt/shared/cadgang/joint-ensemble-v1/`.

## Stage 8 — what the joint model is shown (2026-11-26)

`compute/research/run-joint-inputs.sh` (Job `compute/k8s/joint-inputs-v1.yaml`, 8 GPUs, 14:53Z to 17:56Z, no restarts, $99.27 of credits) trained the Stage 4 winner (EdgeConv k=8, CE, widths 48,96,192, seed 1) eight ways, each changing only its input:
`focus50` / `focus75` draw that share of each part's points from vertices within 1 mm of the other part; `local` adds the point's xyz in the smaller part's own frame (3 more channels); `static` ranks EdgeConv neighbours once on the input xyz instead of on each block's features; `p512` uses 512 points per part (15 and 30 epochs only, for cost). The comparison is the nine plain seeds of Stage 7.

| model (best checkpoint) | accuracy | macro F1 | median axis | REVOLUTE | CYLINDRICAL | PLANAR | p≥0.90 precision / coverage | ONNX matches PyTorch |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| nine plain seeds, 60 epochs | 64.97% to 65.75% | 0.418 to 0.442 | 0.69° to 0.96° | 48% to 52% | 14% to 19% | | 95.2% to 95.8% / 18.9% to 21.1% | 19 of 33 files |
| focus50 | 65.47% | **0.454** | 0.72° | 49.8% | 16.7% | **9.3%** | 95.7% / 20.3% | no (0.07) |
| static | 65.28% | 0.439 | 0.93° | 53.5% | 16.6% | 8.3% | 95.8% / 20.0% | **yes (2e-4)** |
| p512 (30 epochs) | 64.84% | 0.424 | 0.64° | 51.4% | 15.9% | 4.7% | 95.5% / 19.2% | no (0.04) |
| local | 64.60% | 0.403 | 0.85° | 52.7% | 16.7% | 2.7% | 94.9% / 16.6% | yes (7e-4) |
| focus50-local | 64.68% | 0.414 | **0.57°** | **55.5%** | 17.7% | 3.6% | 94.5% / 17.8% | yes (8e-6) |
| focus75-local | 64.97% | 0.417 | 0.64° | 55.9% | 14.6% | 2.9% | 94.4% / 17.6% | yes (8e-6) |
| static-focus50-local | 65.34% | 0.419 | 0.81° | 51.4% | 17.9% | 2.9% | 94.6% / 18.2% | yes (2e-5) |
| p512-focus50-local (30 epochs) | 65.30% | 0.423 | 0.73° | 51.5% | 15.5% | 3.9% | 94.4% / 17.2% | yes (7e-4) |

ONNX: largest difference from PyTorch over the export check's inputs; "yes" is within 1e-3. For the `local` variants the 30- and 60-epoch rows are identical: their best validation checkpoint was the 30-epoch one.

**Accuracy.** No input change moves accuracy outside the seed spread. The best, `focus50`, is 65.47% against a seed mean of 65.34%.

**Minority types.** Drawing half the points from the contact region is the only change that helps PLANAR (9.3% recall against 5.5% for the Stage 7 ensemble) and it gives the best macro F1 of any single model so far (0.454). The local frame does the opposite: REVOLUTE recall rises to 55 to 56% and the median axis error falls to 0.57°, but PLANAR collapses to about 3%.

**Export.** The static graph fixes the Stage 7 export problem without costing accuracy: `static` is inside the seed spread at 60 epochs and both of its files match PyTorch to 2e-4, as do all four `static-*` files. Every variant with the local frame also exports cleanly. Every dynamic-graph variant without it still fails. If a joint model ships as ONNX, train it with `--edge-graph static`.

**Contact.** These models still see mesh vertices only: on 300 validation pairs per type, 61% of SLIDER and NONE pairs, 39% of PLANAR, 28% of CYLINDRICAL and 23% of FASTENED pairs have no vertex within 1 mm of the other part, so their contact flag is blank. On surface points (Stage 9) the share without contact falls to 2% for SLIDER and 3% for PLANAR. Stage 9 trains on those.

Artifacts: checkpoints, reports, ONNX files and `summary.{md,json,csv}` under `/mnt/shared/cadgang/joint-inputs-v1/`.

## Stage 9 — surface points (2026-11-26)

The same script with `STUDY=surface` (Job `compute/k8s/joint-surface-v1.yaml`, commit 3af2d29, 8 GPUs, 22:58Z to 00:50Z, no restarts, about $81 of credits) trained the Stage 8 model on the surface cache (`main.py surface`: 512 points per part spread over its faces, exact distance to the other part, and the face normal) instead of mesh vertices. `normals` adds the three normal channels; the other names are as in Stage 8. Every run is 60 epochs except `p512` (30).

| model (best checkpoint) | accuracy | macro F1 | median axis | REVOLUTE | CYLINDRICAL | SLIDER | PLANAR | p≥0.90 precision / coverage | ONNX matches PyTorch |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Stage 7 seeds (vertices) | 64.97% to 65.75% | 0.418 to 0.442 | 0.69° to 0.96° | 48% to 52% | 14% to 19% | | | 95.2% to 95.8% / 18.9% to 21.1% | 19 of 33 files |
| Stage 8 `static` (vertices) | 65.28% | 0.439 | 0.93° | 53.5% | 16.6% | | 8.3% | 95.8% / 20.0% | yes (2e-4) |
| surf | 62.13% | 0.396 | 2.97° | 42.0% | 11.4% | 32.6% | 8.6% | 95.7% / 20.6% | no (4e-3) |
| surf-normals | **63.26%** | 0.433 | 1.21° | 46.2% | 12.9% | 31.6% | 8.6% | 95.4% / 20.5% | yes (2e-5) |
| surf-normals-focus50 | 62.39% | 0.431 | **0.93°** | 42.5% | 13.2% | 34.3% | 10.5% | 96.1% / 19.0% | yes (3e-5) |
| surf-normals-static | 62.31% | **0.449** | 1.13° | 45.7% | 17.9% | 33.7% | **18.5%** | 95.8% / 19.8% | yes (3e-5) |
| surf-normals-local | 61.62% | 0.412 | 1.51° | 49.6% | **20.1%** | 30.1% | 8.9% | 94.3% / 20.5% | yes (2e-5) |
| surf-normals-focus50-local | 61.06% | 0.405 | 1.08° | 44.0% | 14.1% | 29.9% | 16.3% | 95.2% / 18.6% | yes (1e-5) |
| surf-normals-focus50-local-static | 62.88% | 0.427 | 1.33° | 47.3% | 15.6% | 27.2% | 10.0% | 95.5% / **21.6%** | yes (8e-6) |
| surf-normals-p512 (30 epochs) | 60.84% | 0.428 | 1.01° | **50.3%** | 18.6% | **35.6%** | 16.8% | 96.0% / 18.6% | yes (5e-6) |

`focus50`'s 30- and 60-epoch rows are identical (its best checkpoint was the 30-epoch one). `p512` at 15 epochs: 61.02%, F1 0.404, ONNX no (7e-3).

**Accuracy.** Surface points cost 2 to 4 points of accuracy against vertices: the best, `surf-normals`, is 63.26% against the Stage 7 seed floor of 64.97%. Vertices cluster on edges and fillets, where a joint's character shows; surface points spread evenly over flat faces.

**Normals.** On surface points they are not optional: without them the median axis error is 2.97° (1.21° with them), macro F1 drops from 0.433 to 0.396, and the export fails.

**Minority types.** The static graph on surface points is the best minority-type model so far: PLANAR recall 18.5% (Stage 8 best 9.3%, vertex `static` 8.3%), CYLINDRICAL 17.9%, and a macro F1 of 0.449, within 0.005 of Stage 8's `focus50`. Exact contact shows up where Stage 8 predicted it would, in PLANAR, not in accuracy.

**Export.** Every surface run with normals matches PyTorch to 3e-5, dynamic graph included; `surf` without them does not (4e-3). The dynamic graph exports when its inputs carry normals, so `--edge-graph static` is needed only for vertex models.

**Next, if continued.** The two inputs are good at different things, so the cheap test is an ensemble of a vertex model (Stage 8 `static`) and a surface model (`surf-normals-static`) on existing checkpoints, CPU only. No training run is planned.

Artifacts: checkpoints, reports, ONNX files and `summary.{md,json,csv}` under `/mnt/shared/cadgang/joint-surface-v1/`.

## Stage 10 — vertex and surface models together (2026-11-27)

`compute/k8s/joint-mixed-ensemble.yaml` ran `main.py ensemble` on the free CPU worker (0 GPUs, no credits, 01:12Z to about 03:00Z) over checkpoints already trained: mean type probability and sign-aligned mean axis, one temperature fitted on validation, as in Stage 7. Test split, 86,806 pairs.

| model | members | accuracy | macro F1 | median axis (all axial) | REVOLUTE | SLIDER | CYLINDRICAL | PLANAR |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Stage 7 ensemble of nine (vertices, nine seeds) | 9 | 66.90% | 0.450 | 0.37° | 52.0% | | 14.3% | 5.5% |
| Stage 8 `static` (vertices) | 1 | 65.28% | 0.439 | 0.93° | 53.5% | | 16.6% | 8.3% |
| Stage 9 `surf-normals-static` (surface) | 1 | 62.31% | 0.449 | 1.13° | 45.7% | 33.7% | 17.9% | 18.5% |
| **pair**: `static` + `surf-normals-static` | 2 | 67.0% | 0.475 | 1.0° | 53.0% | 34.2% | **17.3%** | **10.6%** |
| **four**: `static`, `focus50` + `surf-normals`, `surf-normals-static` | 4 | **67.6%** | **0.479** | 0.8° | 52.6% | 34.0% | 14.9% | 8.4% |

Axis by type for the four: REVOLUTE 0.6°, SLIDER 2.4° (the shape solver's is 20.8°), CYLINDRICAL 0.9°. As before, the model beats the solver's axis only on SLIDER.

**Accuracy.** Two models, one on vertices and one on surface points, reach 67.0%, level with nine vertex seeds (66.90%). Four reach 67.6%, the best result so far and 0.7 points above the nine-seed ensemble with fewer than half the forward passes. The two inputs make different mistakes, so averaging them gains more than averaging seeds of one.

**Minority types.** Macro F1 rises to 0.475 and 0.479, the best so far, mostly on precision. PLANAR recall in the ensembles (8 to 11%) sits between the vertex models (about 8%) and the surface model alone (18.5%): averaging dilutes the one model that finds PLANAR.

**Axis.** The median axis error (0.8° to 1.0°) is worse than the nine-seed ensemble's 0.37°: that one averaged nine axes of the same kind, and the surface models' axes are less precise (Stage 9).

**Export.** Every member exports to ONNX and matches PyTorch (Stage 8 `static` within 2e-4; surface models with normals within 3e-5). `focus50` does not (0.07), so the exportable choice is the pair, or the four with `focus50` swapped for another static vertex seed (untested).

Conclusion: if joint suggestions ship, ship a mixed ensemble (vertex `static` + surface `surf-normals-static`, plus more of each as the budget allows). It is the most accurate and the best on macro F1, both members export, and it costs two forward passes plus the surface sampling at inference.

Artifacts: `static-pair.{md,json}` and `four.{md,json}` under `/mnt/shared/cadgang/joint-mixed-ensemble/`.
