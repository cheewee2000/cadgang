#!/bin/bash
# Build cadgang-occt (native STEP/IGES/BREP import, see main.cpp) into $1 (default bin/), with every
# non-system dylib it needs copied into $1/lib and rewired to @rpath, so the folder runs anywhere.
# Needs `brew install opencascade` on the build machine only.
set -euo pipefail
cd "$(dirname "$0")"
OUT=$(mkdir -p "${1:-../../bin}" && cd "${1:-../../bin}" && pwd)
OC=$(brew --prefix opencascade)
LIBS=$(cd "$OC/lib" && ls libTK*.dylib | grep -E '^libTK[A-Za-z]+\.dylib$' | sed -E 's/^lib(.*)\.dylib$/-l\1/')
clang++ -std=c++17 -O2 -I"$OC/include/opencascade" *.cpp -L"$OC/lib" $LIBS -Wl,-dead_strip_dylibs \
  -Wl,-rpath,@executable_path/lib -o "$OUT/cadgang-occt"
rm -rf "$OUT/lib"; mkdir -p "$OUT/lib"
# Walk the dependency tree: @rpath names resolve in OCCT's lib dir, absolute ones are Homebrew's.
queue=("$OUT/cadgang-occt")
while [ ${#queue[@]} -gt 0 ]; do
  f=${queue[0]}; queue=("${queue[@]:1}")
  for dep in $(otool -L "$f" | tail -n +2 | awk '{print $1}' | grep -v -E '^(/usr/lib|/System)'); do
    base=$(basename "$dep")
    [ "$dep" = "$(otool -D "$f" | tail -1)" ] && continue
    if [ ! -e "$OUT/lib/$base" ]; then
      src=$dep; [[ $dep == @rpath/* ]] && src="$OC/lib/$base"
      cp -L "$src" "$OUT/lib/$base"; chmod u+w "$OUT/lib/$base"
      install_name_tool -id "@rpath/$base" "$OUT/lib/$base" 2>/dev/null
      install_name_tool -add_rpath @loader_path "$OUT/lib/$base" 2>/dev/null || true
      queue+=("$OUT/lib/$base")
    fi
    [[ $dep == @rpath/* ]] || install_name_tool -change "$dep" "@rpath/$base" "$f" 2>/dev/null
  done
done
for f in "$OUT"/lib/*.dylib "$OUT/cadgang-occt"; do codesign --force --sign - "$f" 2>/dev/null; done
echo "built $OUT/cadgang-occt ($(ls "$OUT/lib" | wc -l | tr -d ' ') dylibs, $(du -sh "$OUT" | cut -f1))"
