# Stage 2: joint predictor

Given two touching parts, predict the mate type (FASTENED, REVOLUTE, SLIDER, CYLINDRICAL, PLANAR, BALL or NONE) and, for the axial types, the axis. The spec is the Stage 2 section of `compute/README.md`; this folder implements it.

**Status:** the code has unit tests and a self-test on synthetic data only. It has not been run on the AutoMate dumps, so there are no real results yet. The first cluster run produces them.

## Commands

```sh
pip install -r compute/requirements.txt          # torch for the cluster's GPU first (see the file)
python3 -m unittest discover -s compute/tests -v # unit tests; the torch ones skip without torch
sh compute/joints/selftest.sh                    # synth -> index -> train (SIGTERM + resume) -> export -> eval, in $TMPDIR

D=$AUTOMATE/dump                                 # stage 1's --dump directory
python3 compute/joints/main.py index  --dump $D --out $AUTOMATE/joints-index --workers 16
python3 compute/joints/main.py train  --index $AUTOMATE/joints-index --out $AUTOMATE/joints-run --workers 16 --resume
python3 compute/joints/main.py export --ckpt $AUTOMATE/joints-run/best.pt --out compute/results/joints.onnx
python3 compute/joints/main.py eval   --index $AUTOMATE/joints-index --ckpt $AUTOMATE/joints-run/best.pt \
        --report compute/results/joints-report --export-report compute/results/joints.onnx.json
```

`--help` on each command lists every option.

## What each step does

**index** reads every `<id>.json` in the dump (and checks the size of its `.f32`). It never reads the vertices. It writes `pairs.npz`, one row per pair, and `index.json`, which holds the counts, the split sizes and every skip reason. Rules:

- A pair is two parts whose bboxes are closer than `--gap-mm` (1 mm). The distance is Euclidean between boxes and is 0 when they overlap.
- The **smaller part** (by bbox diagonal, as the stage 1 harness measures it) is always part A. That is the part whose `solve[].dir` the report compares against.
- Label: the mate between the two parts, or NONE. PIN_SLOT becomes SLIDER and PARALLEL becomes PLANAR. When a pair has several mate types, the label is the first in the order REVOLUTE, CYLINDRICAL, SLIDER, BALL, PLANAR, FASTENED; `pair_several_mate_types` in `index.json` counts how often that happened. Mate types outside the set are skipped and counted.
- Mates between parts that do not touch are counted in `mate_not_touching` rather than turned into pairs. Watch that number: if it is large, the touching rule is losing real joints.
- Split: by a hash of the **assembly id** and the seed, so every pair of an assembly is in one split, and adding assemblies later does not move the old ones. The defaults are 80/10/10.

**train** reads two vertex ranges per pair from a memory map of `<id>.f32`, so the corpus never sits in RAM. Per part it samples `--points` (1024) vertices without replacement, or every vertex plus repeats when the part has fewer. The sample is seeded by (seed, assembly, occurrence, epoch), so it is reproducible and still changes from epoch to epoch. Each point has 5 channels:

| channel | meaning |
|---|---|
| x, y, z | world mm, centred on the union bbox of the two parts and divided by its diagonal (unit diagonal) |
| contact | 1 if the point is within `--contact-mm` (1 mm) of a vertex of the other part |
| in other bbox | 1 if the point is inside the other part's bbox grown by `--contact-mm` |

Each pair also gets 4 numbers: log10 of the pair diagonal in mm, each part's diagonal over the pair diagonal, and the bbox gap over the pair diagonal. Without them the model would lose absolute size to the normalisation.

Model (`model.py`): one PointNet encoder shared by both parts (1×1 convolutions 64-128-256, max and mean pooling). An MLP takes `[fA, fB, |fA−fB|, fA·fB, extra]` and feeds two heads: 7 type logits and a unit axis. Loss: cross entropy, weighted per class (`--class-weight`, default 1/√count), plus `--axis-weight` × (1 − |cos|) between the predicted and true axis, on REVOLUTE / SLIDER / CYLINDRICAL pairs only. The |cos| makes it sign-invariant.

NONE pairs far outnumber mated ones. Each epoch takes every mated pair plus `--none-ratio` (2) times as many NONE pairs, drawn afresh per epoch. Evaluation uses the natural distribution, so expect fewer NONE predictions than the truth has; lower the bias or raise `--none-ratio` if that matters.

Checkpoints: `last.pt` is written every `--ckpt-every` steps, at every epoch end and on **SIGTERM / SIGINT**. On a signal the loop finishes the current batch, writes the checkpoint and exits with 143 (or 130). `--resume` continues from the same batch, with the same data order and RNG state; on the CPU the result is bit-for-bit the run that was never stopped, which the tests check. `best.pt` is the best validation score, 0.5 × macro type accuracy + 0.5 × (1 − mean axial error / 90°). `metrics.jsonl` logs every epoch. Without `--resume` or `--overwrite`, an existing `last.pt` stops the run instead of being overwritten.

Device: `--device auto` picks a CUDA or ROCm GPU (ROCm builds of torch call it `cuda`), then Apple MPS, then the CPU. `--device rocm` / `cuda` / `cuda:1` / `cpu` force one, and asking for a GPU that torch cannot see is an error, not a silent CPU run.

**eval** writes `<report>.md` and `<report>.json` with:
- accuracy per type (recall), precision, F1, the confusion matrix and the macro means;
- per axial type, the model's axis error (median, mean, p90, share within 5°) next to the **rule solver's**, which is `solve[].dir` of the smaller part from the same dump. The solver often leaves a part unmoved (`dir: null`), so the solver is reported twice: on the pairs it moved (with coverage), and with unmoved parts counted as 90° off. The model is reported on all pairs and on the solver's subset;
- a line naming the types where the model beats the solver on both comparisons. The README's condition for shipping is CYLINDRICAL, SLIDER and REVOLUTE all on that line.

A report built on synthetic data says so at the top.

**export** writes ONNX (opset 17, dynamic batch and point count) and `<out>.json`, which records the size, whether it is under `--target-mb` (10), and the input/output contract. When onnxruntime is installed, the file is also run once and compared with torch (`verified`); without onnxruntime the file says it was not run. Exit codes: 0 under target, 3 over target, 4 export failed (the error is in the .json), 5 the onnx checker or onnxruntime rejected the file or disagrees with torch. By my count the default model has about 0.6 M parameters (about 2.3 MB in fp32), under the target. The export report gives the measured size.

## Calling it from `src/server/` (for the Mac session)

The app does not include this. Wiring it in is the Mac session's job, and only once the report clears the bar above.

1. Add `onnxruntime-node` and load `joints.onnx` once.
2. For a selected pair (the J key), do in JS what `make_pair` in `data.py` does. Take the two bodies' world vertex buffers. Order them smaller bbox diagonal first. Sample N = `contract.n_points` vertices each; any deterministic sampler works, since the model never sees the seed. Centre and scale by the union bbox, compute the two flags (a three-mesh-bvh `closestPointToPoint` is better than nearest-vertex), and compute the 4 extras.
3. Run the session with `pa`, `pb` and `extra`. Softmax `type_logits` gives the probabilities; `axis` is a world-frame unit vector whose sign is arbitrary.
4. Hint `explodeOffsets` the same way the joints panel does: `{type, axis, origin, parent}`, with the type mapped as in `compute/automate/explode.automate.mjs` (`HINT`). The model predicts no origin, so use the contact region's centroid. Gate on the probability, and leave NONE and FASTENED as no hint.

## Known limits

- The contact flag measures distance to the other part's **vertices**, because the dump has no triangles. On coarse meshes (a big flat face with vertices only at its corners), a point can touch a face and still be more than 1 mm from every vertex. The inside-bbox channel partly covers for this. Adding triangle indices to the stage 1 dump would fix it, but that changes stage 1's output, so it was left alone.
- Points come from mesh vertices, so they are denser where the tessellation is fine (fillets, holes). That is not area-uniform. It matches the README's "sample from the vertices".
- Axes stay in world orientation by default (`--augment none`), because Onshape models are often axis-aligned and the model may lean on that. `--augment so3` rotates each pair and its axis at random; compare the two on the val split before you trust either.
- The model predicts no joint origin.
