#!/bin/sh
# Build the Paseo Daemon tray app into build/PaseoDaemon.app and open it.
set -e
cd "$(dirname "$0")"

APP=build/PaseoDaemon.app
rm -rf build
mkdir -p "$APP/Contents/MacOS"

swiftc -O -parse-as-library -o "$APP/Contents/MacOS/PaseoDaemon" Sources/main.swift

cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>PaseoDaemon</string>
  <key>CFBundleDisplayName</key><string>Paseo Daemon</string>
  <key>CFBundleIdentifier</key><string>sh.paseo.daemon-tray</string>
  <key>CFBundleExecutable</key><string>PaseoDaemon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
</dict>
</plist>
EOF

open "$APP"
