#!/bin/bash
set -e

# Configuration
APP_DIR="/var/www/omniscripta-app"
TARGET_DIR="/srv/transcribe/static"
ESBUILD="$APP_DIR/node_modules/.bin/esbuild"
VERSION_FILE="$APP_DIR/.version"
FOUNDATION_CORE_DIR="/home/gunnar/projects/spa-foundation/core"

echo "🚀 Starting deployment to: $TARGET_DIR"
# 0. Handle Versioning
if [ -f "$VERSION_FILE" ]; then
    VERSION=$(cat "$VERSION_FILE")
    VERSION=$((VERSION + 1))
else
    VERSION=1
fi
echo "$VERSION" > "$VERSION_FILE"
echo "🔖 Version incremented to: $VERSION"

# 0b. Refresh local foundation packages (file: dependencies)
echo "🔗 Refreshing local foundation packages..."
if [ ! -d "$FOUNDATION_CORE_DIR" ]; then
    echo "❌ Missing local spa-foundation package directories:"
    echo "   $FOUNDATION_CORE_DIR"
    exit 1
fi
rm -rf "$APP_DIR/node_modules/@spa-foundation/core"
npm --prefix "$APP_DIR" install --no-audit --no-fund \
    "@spa-foundation/core@file:$FOUNDATION_CORE_DIR" >/dev/null

# 1. Clean legacy files
echo "🧹 Cleaning target directory..."
rm -f "$TARGET_DIR/editor.html"
rm -f "$TARGET_DIR/app.bundle.js"
rm -f "$TARGET_DIR/app.bundle.js.map"
rm -f "$TARGET_DIR/style.css"
rm -f "$TARGET_DIR/layout.css"
rm -f "$TARGET_DIR/upload.css"
rm -rf "$TARGET_DIR/assets"
rm -rf "$TARGET_DIR/editor_build"
rm -rf "$TARGET_DIR/dev-fixtures"

# 2. Build JS Bundle (No Sourcemap)
echo "📦 Bundling JavaScript..."
$ESBUILD "$APP_DIR/js/app.js" \
  --bundle \
  --outfile="$TARGET_DIR/app.bundle.js" \
  --minify \
  --log-level=error \
  --target=es2020

# 3. Build CSS bundle
echo "🎨 Bundling CSS..."
$ESBUILD "$APP_DIR/css/style.css" \
  --bundle \
  --outfile="$TARGET_DIR/style.css" \
  --minify \
  --log-level=error \
  --target=es2020

# 4. Copy standalone CSS files
cp "$APP_DIR/css/layout.css" "$TARGET_DIR/layout.css"
cp "$APP_DIR/css/upload.css" "$TARGET_DIR/upload.css"

# 5. Deploy HTML (SPA Shell)
cp "$APP_DIR/index.html" "$TARGET_DIR/index.html"

# 5b. Deploy dev fixtures (optional)
if [ -d "$APP_DIR/dev-fixtures" ]; then
    cp -r "$APP_DIR/dev-fixtures" "$TARGET_DIR/dev-fixtures"
fi

sed -i \
    -e "s|src=\"js/app.js[^\\\"]*\"|src=\"app.bundle.js?v=$VERSION\"|" \
    -e "s|type=\"module\"||" \
    -e "s|href=\"css/style.css[^\\\"]*\"|href=\"style.css?v=$VERSION\"|" \
    -e "s|href=\"css/layout.css[^\\\"]*\"|href=\"layout.css?v=$VERSION\"|" \
    -e "s|href=\"css/upload.css[^\\\"]*\"|href=\"upload.css?v=$VERSION\"|" \
    "$TARGET_DIR/index.html"

echo "✅ Deployment complete! (Version $VERSION)"
ls -l "$TARGET_DIR"
