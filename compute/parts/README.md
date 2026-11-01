# Stage 3: part classifier

Predicts screw, nut, washer, standoff, pcb, bearing or other from a body's shape and size, so unnamed bodies get a guess on import. The spec is the Stage 3 section of `compute/README.md`.

**Status:** the code has unit tests and a self-test on synthetic data only. The labels (`compute/results/parts-labelled.jsonl[.gz]`) come from the Mac session on request and are not in the repo, so there are no real results yet.

## Commands

```sh
pip install -r compute/requirements.txt
python3 -m unittest discover -s compute/tests -v
sh compute/parts/selftest.sh                      # synth -> validate -> cache -> pretrain -> train -> export -> eval

L=compute/results/parts-labelled.jsonl[.gz]
python3 compute/parts/validate.py $L               # numpy only: run this before anything else; exit 1 = do not train
python3 compute/parts/main.py cache  --jsonl $L --out $WORK/parts-cache
python3 compute/parts/main.py train  --cache $WORK/parts-cache --out $WORK/parts-run --resume
python3 compute/parts/main.py export --ckpt $WORK/parts-run/best.pt --out compute/results/parts.onnx
python3 compute/parts/main.py eval   --ckpt $WORK/parts-run/best.pt --report compute/results/parts-report \
        --export-report compute/results/parts.onnx.json --predictions $WORK/parts-test.jsonl
```

## The labelled JSONL

One body per line. The parser accepts several layouts, because the Mac export's exact shape is not fixed yet:

| field | keys tried, in order | accepted forms |
|---|---|---|
| label (required) | `label`, `class`, `category` | case-insensitive; `Screws` → screw. Nothing else is guessed: `Hex Nut` is an unknown label, not a nut |
| points (required) | `points`, `pts`, `cloud`, `point_cloud`, `pointcloud`, `xyz`, `pc` | flat `[x,y,z,x,y,z,…]`, nested `[[x,y,z],…]`, channels-first `[[x…],[y…],[z…]]`, `{x:[…],y:[…],z:[…]}`; at least 8 finite points |
| bbox | `bbox`, `box`, `aabb`, `bounds`, `size` | `[minx,miny,minz,maxx,maxy,maxz]`, `[[min],[max]]`, `{min,max}` (lists or `{x,y,z}`), `{center,size}`, or 3 extents |
| group | `group`, `assembly`, `assembly_id`, `file`, `file_id`, `path`, `document`, `doc`, `source` | any string |
| id | `id`, `body_id`, `uid`, `name` | any string |

The bbox gives the body's **real size in mm**, so the point cloud may be normalised. Without a bbox the size comes from the points, which is wrong if they are normalised; `validate` warns when that happens. `--bbox-scale` converts other units.

Blank lines and `#` source-path comments are ignored. Unknown labels are counted and **skipped** by default. `cache --unknown other` folds them into `other`, and `--unknown error` stops on the first one. Neither happens unless asked.

**Ask the Mac session for** a group key per body (the source file), the bbox in mm, and the label set above. Without a group key, bodies from one file can land in both train and test, and the score comes out optimistic.

`validate` prints the line count, the usable/invalid/unknown counts, the error kinds with example line numbers, the classes, the point formats and counts, the groups, the duplicates, and a preview of the split per class. It warns about unknown labels, empty or small classes, classes missing from val or test, a missing or coarse group key (e.g. a constant `source`), resampling, bodies duplicated across groups, normalised points and missing bboxes. It is **fatal** (exit 1) when nothing is usable, when more than `--max-invalid` (1%) of the lines are bad, or when there is only one class.

## Split, cache, training

- Split by a hash of the group, so a file never straddles splits. Groups that share an **exactly identical body** (the same normalised cloud, in any point order) are merged first, so a part reused in many files cannot be in train and test at once. Near-duplicates (the same screw sampled differently) are not caught.
- `cache` makes two streaming passes over the JSONL and never holds all the clouds in RAM. Each cloud is resampled to `--points` (seeded per line), centred on its own bbox and scaled to unit diagonal, then written to a memory-mapped `points.npy`. Labels, size features, splits, groups and ids go to `meta.npz`. `cache.json` records the source path and its sha256.
- Model: the same PointNet encoder as stage 2 (`cadnn/pointnet.py`, 3 channels), with the size feature (log10 of the bbox extents in mm, largest first) appended before an MLP and 7 logits. Cross entropy, weighted by `--class-weight` (default `inv`, 1/count normalised to a mean of 1 over the training bodies and clipped at 50). Random rotations (`--augment so3`) by default.
- Checkpoints, SIGTERM, `--resume`, device choice and the export checks work exactly as in stage 2 (`cadnn/runtime.py`). `best.pt` is the best validation macro F1.
- `eval` reports accuracy, macro recall, macro F1, per-class recall / precision / F1 and the confusion matrix. `--predictions` writes one line per body, which is the quickest way to find mislabelled bodies.

## Optional: unsupervised pretraining on AutoMate

`main.py pretrain --dump $AUTOMATE/dump --out $WORK/parts-pretrain` trains a point autoencoder (the same encoder, a fully connected decoder, chamfer loss) on the distinct AutoMate parts from the stage 1 dumps. It writes `encoder.pt`, tagged `kind: unsupervised-pretrain, labels_used: none`. `train --init-encoder $WORK/parts-pretrain/encoder.pt` starts from it. The checkpoint config and the report both say which encoder was used and that it saw no labels. Use the same `--widths` for both; a mismatch is refused, not half-loaded. Whether it helps is an empirical question: run with and without it and compare the val macro F1.

**Not implemented on purpose:** a weak "fastener" label from FASTENED-mate counts. A FASTENED mate joins brackets to plates as often as screws to holes, so it would not map onto these seven classes. Mixing it in would also make the reported accuracy measure something other than the labelled ground truth. If it is tried later, it belongs in a separate pretraining step like the one above, not in the label set.

## Export and the app

`export` writes ONNX with inputs `points (B,N,3)` and `size (B,3)` and output `logits (B,7)`. `<out>.json` has the size check against 10 MB and the preprocessing contract. In the app, a body's world vertices go through the same steps as `prepare_points` and `size_feature` in `data.py`. The Bodies panel's guess would be the argmax, shown only above a probability threshold. That wiring is the Mac session's job.
