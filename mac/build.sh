#!/bin/bash
# Build dist/cadgang.app: Swift shell + the system node binary + this repo (prod node_modules).
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
APP=dist/cadgang.app
RES=$APP/Contents/Resources
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$RES/app"
swiftc -O -o "$APP/Contents/MacOS/cadgang" mac/main.swift -framework Cocoa -framework WebKit
sed "s/__VERSION__/$VERSION/g" mac/Info.plist > "$APP/Contents/Info.plist"
cp "$(command -v node)" "$RES/node"
[ -f mac/AppIcon.icns ] && cp mac/AppIcon.icns "$RES/AppIcon.icns"
rsync -a package.json src web "$RES/app/"
# three.js is a devDependency only because web/vendor carries its own copy.
rsync -a --exclude three node_modules "$RES/app/"
codesign --force --deep --sign - "$APP"
echo "built $APP ($VERSION)"
