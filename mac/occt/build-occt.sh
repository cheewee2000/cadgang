#!/bin/bash
# Build OCCT 7.9.3 (Homebrew's version and options) into $1 (default ~/.cache/cadgang-occt-7.9.3) without
# OCC_CONVERT_SIGNALS, then: CADGANG_OCCT_PREFIX=<that dir> bash mac/occt/build.sh.
# cadgang: OCC_CONVERT_SIGNALS makes every OCC_CATCH_SIGNALS (thousands per STEP transfer and mesh) set up a
# setjmp buffer on a global handler list behind a mutex. That only turns SIGSEGV into Standard_Failure after
# OSD::SetSignal, which cadgang never calls, so dropping it changes no result, only the time. One-time, ~20 min.
# A different compiler than the bottle's (Apple clang 21 here) meshes a few faces with other diagonals in
# TKMesh, define or not: same vertices and triangle counts, not the same bytes as the Homebrew build.
# Needs `brew install cmake tbb freetype` on the build machine only.
set -euo pipefail
PREFIX=${1:-$HOME/.cache/cadgang-occt-7.9.3}
SRC=$HOME/.cache/cadgang-occt-src
mkdir -p "$SRC" && cd "$SRC"
[ -f occt-7.9.3.tar.gz ] || curl -fsSL -o occt-7.9.3.tar.gz https://github.com/Open-Cascade-SAS/OCCT/archive/refs/tags/V7_9_3.tar.gz
echo "5ecf094ec6b12d5413dfb851d8c3590c354058aee556e32e408bdfbf8c357d57  occt-7.9.3.tar.gz" | shasum -a 256 -c -
rm -rf OCCT-7_9_3 && tar xzf occt-7.9.3.tar.gz
sed -i '' '/add_definitions(-DOCC_CONVERT_SIGNALS)/d' OCCT-7_9_3/adm/cmake/occt_defs_flags.cmake
! grep -q OCC_CONVERT_SIGNALS OCCT-7_9_3/adm/cmake/occt_defs_flags.cmake
# Only the toolkits build.sh ends up linking (bin/lib); each pulls in its own dependencies.
TK="TKDESTEP TKDEIGES TKXCAF TKVCAF TKCAF TKLCAF TKCDF TKMesh TKShHealing TKBool TKBO TKPrim TKHLR TKTopAlgo TKGeomAlgo TKV3d TKService"
cmake -S OCCT-7_9_3 -B build -G "Unix Makefiles" -DCMAKE_BUILD_TYPE=Release -DBUILD_LIBRARY_TYPE=Shared \
  -DCMAKE_INSTALL_PREFIX="$PREFIX" -DINSTALL_DIR_LAYOUT=Unix -DCMAKE_INSTALL_RPATH="$PREFIX/lib" \
  -DBUILD_RELEASE_DISABLE_EXCEPTIONS=OFF -DUSE_TBB=ON -D3RDPARTY_TBB_DIR="$(brew --prefix tbb)" \
  -DUSE_FREETYPE=ON -D3RDPARTY_FREETYPE_DIR="$(brew --prefix freetype)" \
  -DUSE_FREEIMAGE=OFF -DUSE_RAPIDJSON=OFF -DUSE_TK=OFF -DUSE_VTK=OFF -DUSE_OPENVR=OFF -DUSE_DRACO=OFF \
  -DBUILD_MODULE_FoundationClasses=OFF -DBUILD_MODULE_ModelingData=OFF -DBUILD_MODULE_ModelingAlgorithms=OFF \
  -DBUILD_MODULE_Visualization=OFF -DBUILD_MODULE_ApplicationFramework=OFF -DBUILD_MODULE_DataExchange=OFF \
  -DBUILD_MODULE_DETools=OFF -DBUILD_MODULE_Draw=OFF -DBUILD_DOC_Overview=OFF -DBUILD_ADDITIONAL_TOOLKITS="$TK"
cmake --build build -j "$(sysctl -n hw.ncpu)"
cmake --install build
echo "OCCT in $PREFIX; now: CADGANG_OCCT_PREFIX=$PREFIX bash mac/occt/build.sh"
