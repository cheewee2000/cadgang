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
