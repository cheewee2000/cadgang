#!/usr/bin/env python3
"""Picks the AutoMate assemblies the oracle runs on and writes their ids to $AUTOMATE/selected.txt.

Top-level assemblies with 3..MAX_PARTS parts, STEP geometry for every part, and at least one mate with
STEP on both sides. MAX_PARTS=60 keeps a solve under a minute on the WASM importer."""
import os, pandas as pd
root = os.environ.get('AUTOMATE', os.path.expanduser('~/cadgang-corpus/automate'))
a = pd.read_parquet(f'{root}/assemblies.parquet')
ok = a[(a.n_step == a.n_parts) & a.n_parts.between(3, int(os.environ.get('MAX_PARTS', 60))) & (a.n_step_mates > 0) & ~a.is_subassembly]
ok.assemblyId.to_csv(f'{root}/selected.txt', index=False, header=False)
print(f'{len(ok)} of {len(a)} assemblies -> {root}/selected.txt')
