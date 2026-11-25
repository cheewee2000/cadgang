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
