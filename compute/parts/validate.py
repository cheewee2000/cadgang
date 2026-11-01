#!/usr/bin/env python3
"""Check a labelled parts JSONL before an expensive training run. Needs numpy only.

  python3 compute/parts/validate.py compute/results/parts-labelled.jsonl[.gz] [--json report.json]

Same as `compute/parts/main.py validate`; exits 1 when the file is not fit to train on."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from main import main  # noqa: E402

if __name__ == '__main__':
    sys.exit(main(['validate', *sys.argv[1:]]))
