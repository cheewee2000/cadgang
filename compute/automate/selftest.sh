#!/bin/sh
# The oracle harness on two repo fixtures laid out like the dataset: two cubes 30 mm apart on x with a SLIDER mate along x.
# Passes when the harness reports 2 bodies and scores the one axial mate. No download needed.
set -e
cd "$(dirname "$0")/../.."
T=${TMPDIR:-/tmp}/cadgang-automate-selftest; rm -rf "$T"; mkdir -p "$T/assemblies" "$T/step"
cp test/fixtures/cube.stp "$T/step/cube.step"
I='[1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]'
X='[0,0,1,0, 0,1,0,0, -1,0,0,0, 0,0,0,1]'
X2='[0,0,1,-0.03, 0,1,0,0, -1,0,0,0, 0,0,0,1]'
cat > "$T/assemblies/selftest.json" <<EOF
{"assemblyId":"selftest","n_occurrences":2,"parts":[{"id":"cube","has_step":true}],
 "occurrences":[{"part":0,"id":"a","transform":$I,"fixed":true,"hidden":false,"has_step":true},
                {"part":0,"id":"b","transform":[1,0,0,0.03, 0,1,0,0, 0,0,1,0, 0,0,0,1],"fixed":false,"hidden":false,"has_step":true}],
 "mates":[{"name":"slide","id":"m","mateType":"SLIDER","occurrences":[0,1],"mcfs":[$X,$X2],"has_step":true}],
 "mateRelations":[],"mateGroups":[],"subAssemblies":[]}
EOF
OUT=$(node compute/automate/explode.automate.mjs --root "$T" --one selftest --dump "$T/dump")
echo "$OUT"
echo "$OUT" | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8")); if(r.error||r.bodies!==2||r.axialN!==1||r.mcfAgree>0.01) { console.error("selftest FAILED"); process.exit(1);} console.log("selftest ok: axial", r.axialOk+"/"+r.axialN, "caused", r.caused)'
ls "$T/dump"
