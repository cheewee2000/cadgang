#!/bin/bash
# Build the iPhone and iPad app (ios/build/…/cadgang.app). With a device's name or id, install and open it there:
#   ios/build.sh                 the simulator build
#   ios/build.sh <device>        a device build, installed on that device (xcrun devicectl list devices)
set -euo pipefail
cd "$(dirname "$0")"
export VERSION=$(node -p "require('../package.json').version") BUILD=$(git rev-list --count HEAD)
xcodegen -q
if [ $# -eq 0 ]; then
  xcodebuild -quiet -project cadgang.xcodeproj -scheme cadgang -sdk iphonesimulator -configuration Debug -derivedDataPath build CODE_SIGNING_ALLOWED=NO
  echo "built $(pwd)/build/Build/Products/Debug-iphonesimulator/cadgang.app"
else
  xcodebuild -quiet -project cadgang.xcodeproj -scheme cadgang -sdk iphoneos -configuration Release -derivedDataPath build -allowProvisioningUpdates
  APP="$(pwd)/build/Build/Products/Release-iphoneos/cadgang.app"
  xcrun devicectl device install app --device "$1" "$APP"
  xcrun devicectl device process launch --device "$1" com.cwandt.cadgang.ios >/dev/null 2>&1 || echo "installed: unlock the device and open CADgang"
fi
