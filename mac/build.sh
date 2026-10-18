#!/bin/bash
# Build dist/cadgang.app: Swift shell + the system node binary + this repo (prod node_modules).
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
APP=dist/cadgang.app
RES=$APP/Contents/Resources
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$RES/app"
# Sparkle (auto-update): the framework ships inside the app; mac/release.sh signs each zip for it.
SPARKLE=mac/Sparkle
if [ ! -d "$SPARKLE/Sparkle.framework" ]; then
  mkdir -p "$SPARKLE"; curl -sL -o "$SPARKLE/sparkle.tar.xz" https://github.com/sparkle-project/Sparkle/releases/download/2.10.0/Sparkle-2.10.0.tar.xz
  tar -xf "$SPARKLE/sparkle.tar.xz" -C "$SPARKLE"; rm "$SPARKLE/sparkle.tar.xz"
fi
mkdir -p "$APP/Contents/Frameworks"; cp -R "$SPARKLE/Sparkle.framework" "$APP/Contents/Frameworks/"
swiftc -O -o "$APP/Contents/MacOS/cadgang" mac/main.swift -framework Cocoa -framework WebKit \
  -F "$SPARKLE" -framework Sparkle -Xlinker -rpath -Xlinker @executable_path/../Frameworks
sed "s/__VERSION__/$VERSION/g" mac/Info.plist > "$APP/Contents/Info.plist"
cp "$(command -v node)" "$RES/node"
# Icons: the Icon Composer bundle fills the macOS 26 squircle natively (Assets.car + its icns);
# the iconset-built icns is the fallback for older macOS. Both come from mac/icon/make.mjs.
if [ -d mac/AppIcon.icon ]; then
  ICONS=$(mktemp -d)
  xcrun actool mac/AppIcon.icon --compile "$ICONS" --platform macosx --minimum-deployment-target 13.0 \
    --app-icon AppIcon --output-partial-info-plist "$ICONS/p.plist" >/dev/null
  cp "$ICONS/Assets.car" "$RES/Assets.car"; cp "$ICONS/AppIcon.icns" "$RES/AppIcon.icns"; rm -rf "$ICONS"
elif [ -d mac/AppIcon.iconset ]; then
  iconutil -c icns mac/AppIcon.iconset -o "$RES/AppIcon.icns"
fi
rsync -a package.json src web "$RES/app/"
# three.js is a devDependency only because web/vendor carries its own copy.
rsync -a --exclude three node_modules "$RES/app/"
# Native STEP/IGES/BREP import with its OCCT dylibs (src/core/step.js falls back to WASM without it).
bash mac/occt/build.sh "$RES/app/bin" >/dev/null 2>&1 || echo "warning: no native OCCT importer (brew install opencascade); the app falls back to WASM"
# A Dock-less way in from a shell: `dist/cadgang.app/Contents/MacOS/cadgang-open file.step`.
cp mac/cadgang-open "$APP/Contents/MacOS/cadgang-open"
codesign --force --deep --sign - "$APP"
# Zip for sharing (ditto keeps the bundle's resource forks and signature).
rm -f "dist/cadgang-$VERSION.zip"; ditto -c -k --keepParent "$APP" "dist/cadgang-$VERSION.zip"
echo "built $APP ($VERSION) and dist/cadgang-$VERSION.zip"
