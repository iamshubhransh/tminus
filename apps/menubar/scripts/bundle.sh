#!/usr/bin/env bash
# Build TMinusMenubar in release mode and wrap it into build/TMinus.app
# (LSUIElement, ad-hoc signed) so it can be dragged into /Applications.
#
#   scripts/bundle.sh              # native architecture
#   scripts/bundle.sh --universal  # arm64 + x86_64 (needs full Xcode)
set -euo pipefail

cd "$(dirname "$0")/.."

APP_NAME="TMinus"
EXECUTABLE="TMinusMenubar"
BUNDLE_ID="dev.tminus.menubar"
VERSION="${TMINUS_VERSION:-0.1.0}"
BUILD_NUMBER="${TMINUS_BUILD:-1}"
APP="build/${APP_NAME}.app"

ARCH_FLAGS=()
if [[ "${1:-}" == "--universal" ]]; then
  ARCH_FLAGS=(--arch arm64 --arch x86_64)
fi

echo "› swift build -c release ${ARCH_FLAGS[*]:-}"
swift build -c release ${ARCH_FLAGS[@]+"${ARCH_FLAGS[@]}"}
BIN_DIR="$(swift build -c release ${ARCH_FLAGS[@]+"${ARCH_FLAGS[@]}"} --show-bin-path)"

echo "› assembling ${APP}"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN_DIR/$EXECUTABLE" "$APP/Contents/MacOS/$EXECUTABLE"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>${EXECUTABLE}</string>
  <key>CFBundleIdentifier</key>
  <string>${BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key>
  <string>${APP_NAME}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${VERSION}</string>
  <key>CFBundleVersion</key>
  <string>${BUILD_NUMBER}</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSSupportsAutomaticTermination</key>
  <false/>
  <key>NSSupportsSuddenTermination</key>
  <true/>
</dict>
</plist>
PLIST
printf 'APPL????' > "$APP/Contents/PkgInfo"
plutil -lint "$APP/Contents/Info.plist" >/dev/null

echo "› codesign (ad-hoc)"
codesign -s - --force "$APP"
codesign --verify --strict "$APP"

echo "✓ $(pwd)/$APP"
echo "  run:      open \"$APP\""
echo "  install:  drag it into /Applications (or: cp -R \"$APP\" /Applications/)"
