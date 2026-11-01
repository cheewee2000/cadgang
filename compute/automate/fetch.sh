#!/bin/sh
# Downloads the AutoMate dataset (CC0, https://zenodo.org/records/7776208) into $AUTOMATE and unzips it.
# ~14 GB download, ~60 GB unzipped. Resumable: files already present are skipped.
set -e
AUTOMATE=${AUTOMATE:-$HOME/cadgang-corpus/automate}
mkdir -p "$AUTOMATE" && cd "$AUTOMATE"
for f in README.md assemblies.parquet mates.parquet parts.parquet config_encodings.json assemblies.zip step.zip; do
  [ -s "$f" ] || curl -sSL -C - -o "$f" "https://zenodo.org/records/7776208/files/$f?download=1"
done
[ -d assemblies ] || unzip -q assemblies.zip
[ -d step ] || unzip -q step.zip
echo "$AUTOMATE: $(ls assemblies | wc -l) assembly jsons, $(ls step | wc -l) step parts"
