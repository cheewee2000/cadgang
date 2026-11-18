# Cluster manifests

The tested Kubernetes Jobs used for the November 2026 compute run. They assume an attached shared volume at `/mnt/shared` and the checkout/data layout described by `compute/README.md`.

- `automate-prepare.yaml` — CPU worker: clone, dependencies, AutoMate download/unpack and selection.
- `automate-shard-100.yaml` — CPU worker: 100-assembly baseline + hint timing gate.
- `automate-full.yaml` — CPU worker: resumable full baseline + hint run and Stage 2 dumps.
- `joints-index.yaml` — CPU worker: build the pair index from Stage 1 dumps.
- `joints-train-sweep-amd.yaml` — one AMD 8-GPU node: eight corrected one-GPU experiments with durable checkpoints.
- `joints-confidence.yaml` — CPU worker: precision/coverage analysis of predictions.

The readback-only Jobs used during the session are intentionally not kept. Before reapplying a named Job, delete the old finished Job or change its name; Job pod templates are immutable.
