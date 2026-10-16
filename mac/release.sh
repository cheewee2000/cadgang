#!/bin/bash
# Cut a release: build the app, sign the zip for Sparkle, publish the zip and the
# appcast to the VPS, and create the GitHub release.
#
#   bash mac/release.sh ["release notes"]
#
# Needs: the Sparkle EdDSA private key in this Mac's keychain (mac/Sparkle/bin/generate_keys
# made it; its public half is SUPublicEDKey in Info.plist), ssh to the VPS, and `gh auth`.
# The appcast lists the latest version only — every install updates to the newest.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
NOTES="${1:-CADgang $VERSION}"
ZIP="dist/cadgang-$VERSION.zip"
VPS=cwandt@vps52023.dreamhostps.com
URL="https://www.experiments.cwandt.com/releases"

bash mac/build.sh
SIG=$(mac/Sparkle/bin/sign_update "$ZIP")     # sparkle:edSignature="…" length="…"
cat > dist/cadgang.xml <<EOF
<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>CADgang</title>
    <item>
      <title>CADgang $VERSION</title>
      <pubDate>$(date -R)</pubDate>
      <sparkle:version>$VERSION</sparkle:version>
      <sparkle:shortVersionString>$VERSION</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>
      <description><![CDATA[$NOTES]]></description>
      <enclosure url="$URL/cadgang-$VERSION.zip" type="application/octet-stream" $SIG/>
    </item>
  </channel>
</rss>
EOF
ssh "$VPS" 'mkdir -p ~/experiments.cwandt.com/releases'
scp -q "$ZIP" dist/cadgang.xml "$VPS:~/experiments.cwandt.com/releases/"
curl -sfI "$URL/cadgang.xml" >/dev/null && echo "appcast live: $URL/cadgang.xml"
if gh release view "v$VERSION" >/dev/null 2>&1; then
  gh release upload "v$VERSION" "$ZIP" --clobber
else
  gh release create "v$VERSION" "$ZIP" --title "CADgang $VERSION" --notes "$NOTES" --latest
fi
echo "released $VERSION: $URL/cadgang-$VERSION.zip"
