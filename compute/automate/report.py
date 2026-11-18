#!/usr/bin/env python3
"""Summarize AutoMate oracle JSONL runs into the Stage 1 markdown report.

Usage:
  python3 compute/automate/report.py \
    --base compute/results/automate-base.jsonl \
    --hints compute/results/automate-hints.jsonl \
    --dump /mnt/shared/cadgang/automate/dump \
    --out compute/results/automate-report.md

The dump is optional. When present, its per-mate rows are used to report which
mate types most often disagree with the solver's direction.
"""
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path


def read_jsonl(path: Path) -> list[dict]:
    rows = []
    with path.open(encoding="utf-8") as src:
        for number, line in enumerate(src, 1):
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise SystemExit(f"{path}:{number}: invalid JSON: {exc}") from exc
    return rows


def ratio(ok: int, total: int) -> str:
    return "n/a" if not total else f"{ok:,}/{total:,} ({100 * ok / total:.2f}%)"


def totals(rows: list[dict]) -> dict:
    good = [r for r in rows if not r.get("error")]
    return {
        "rows": len(rows),
        "ok": len(good),
        "errors": len(rows) - len(good),
        "axial_n": sum(r.get("axialN", 0) for r in good),
        "axial_ok": sum(r.get("axialOk", 0) for r in good),
        "fast_n": sum(r.get("fastN", 0) for r in good),
        "fast_ok": sum(r.get("fastOk", 0) for r in good),
        "caused": sum(r.get("caused", 0) for r in good),
        "overlaps": sum(r.get("modelOverlaps", 0) for r in good),
        "still": sum(r.get("stillAtK1", 0) for r in good),
        "runtime_ms": sum(r.get("ms", 0) for r in good),
    }


def mate_misses(dump: Path | None, ids: set[str]) -> list[tuple[str, int, int]]:
    if dump is None:
        return []
    counts: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for assembly_id in sorted(ids):
        path = dump / f"{assembly_id}.json"
        if not path.is_file():
            continue
        try:
            row = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        for mate in row.get("mates", []):
            kind = str(mate.get("type", "UNKNOWN"))
            counts[kind][1] += 1
            axial = kind in {"SLIDER", "CYLINDRICAL", "REVOLUTE", "PIN_SLOT"}
            correct = mate.get("dot", 0) > 0.95 if axial else bool(mate.get("together")) if kind == "FASTENED" else True
            if not correct:
                counts[kind][0] += 1
    return sorted(((kind, miss, total) for kind, (miss, total) in counts.items()), key=lambda x: (-x[1], x[0]))


def section(name: str, rows: list[dict]) -> list[str]:
    t = totals(rows)
    hours = t["runtime_ms"] / 3_600_000
    return [
        f"## {name}", "",
        f"- Assemblies: **{t['ok']:,} succeeded**, **{t['errors']:,} errors** of {t['rows']:,}",
        f"- Axial mates correct: **{ratio(t['axial_ok'], t['axial_n'])}**",
        f"- FASTENED mates moving together: **{ratio(t['fast_ok'], t['fast_n'])}**",
        f"- Model overlaps at rest: **{t['overlaps']:,}**",
        f"- Collision pairs caused during explode: **{t['caused']:,}**",
        f"- Caused pairs still colliding at k=1: **{t['still']:,}**",
        f"- Sum of per-assembly wall time: **{hours:,.2f} h** (parallel elapsed time is lower)", "",
    ]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--hints", type=Path)
    parser.add_argument("--dump", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    base = read_jsonl(args.base)
    hints = read_jsonl(args.hints) if args.hints else []
    lines = ["# AutoMate explode oracle report", "", "Generated from resumable oracle JSONL output.", ""]
    lines += section("Shape-only baseline", base)
    if hints:
        lines += section("Mate-hint upper bound", hints)

    lines += ["## Worst 50 baseline assemblies by caused collisions", "", "| rank | assembly | caused | still at k=1 | bodies | error |", "|---:|---|---:|---:|---:|---|"]
    worst = sorted(base, key=lambda r: (-int(r.get("caused", -1)), str(r.get("id", ""))))[:50]
    for rank, row in enumerate(worst, 1):
        error = str(row.get("error", "")).replace("|", "\\|").replace("\n", " ")
        lines.append(f"| {rank} | `{row.get('id', '')}` | {row.get('caused', '')} | {row.get('stillAtK1', '')} | {row.get('bodies', '')} | {error} |")

    misses = mate_misses(args.dump, {str(r.get("id")) for r in base if r.get("id")})
    lines += ["", "## Mate-type disagreements", ""]
    if not misses:
        lines.append("Per-mate dump files were not supplied; rerun with `--dump` to populate this table.")
    else:
        lines += ["| mate type | wrong | scored | error rate |", "|---|---:|---:|---:|"]
        for kind, wrong, total in misses:
            lines.append(f"| {kind} | {wrong:,} | {total:,} | {100 * wrong / total:.2f}% |")

    errors = [r for r in base if r.get("error")]
    lines += ["", "## Errors", ""]
    if not errors:
        lines.append("None.")
    else:
        lines += ["| assembly | error |", "|---|---|"]
        for row in errors[:200]:
            error = str(row.get("error", "")).replace("|", "\\|").replace("\n", " ")
            lines.append(f"| `{row.get('id', '')}` | {error} |")
        if len(errors) > 200:
            lines.append(f"\nOnly the first 200 of {len(errors):,} errors are shown.")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(args.out)


if __name__ == "__main__":
    main()
