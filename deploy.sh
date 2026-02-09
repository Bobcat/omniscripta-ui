#!/bin/bash
set -e

# Configuration
APP_DIR="/var/www/omniscripta-app"
TARGET_DIR="/srv/transcribe/static"
ESBUILD="$APP_DIR/node_modules/.bin/esbuild"
VERSION_FILE="$APP_DIR/.version"

echo "🚀 Starting deployment to $TARGET_DIR..."

# 0. Handle Versioning
if [ -f "$VERSION_FILE" ]; then
    VERSION=$(cat "$VERSION_FILE")
    VERSION=$((VERSION + 1))
else
    VERSION=1
fi
echo "$VERSION" > "$VERSION_FILE"
echo "🔖 Version incremented to: $VERSION"

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

# 2. Build JS Bundle (No Sourcemap)
echo "📦 Bundling JavaScript..."
$ESBUILD "$APP_DIR/js/app.js" \
  --bundle \
  --outfile="$TARGET_DIR/app.bundle.js" \
  --minify \
  --target=es2020

# 3. Copy CSS (Flattened)
echo "🎨 Deploying CSS..."
cp "$APP_DIR/css/style.css" "$TARGET_DIR/style.css"
cp "$APP_DIR/css/layout.css" "$TARGET_DIR/layout.css"
cp "$APP_DIR/css/upload.css" "$TARGET_DIR/upload.css"

# 4. Deploy HTML (SPA Shell)
echo "📄 Deploying HTML..."

# Replace module script with bundle reference and update CSS paths
# We use a temp file to avoid modifying source
cp "$APP_DIR/index.html" "$TARGET_DIR/index.html"

# Run sed in-place on the target file
# Use regex to match href="css/style.css..." ignoring existing query params
# Also update the JS src to include version
sed -i \
    -e "s|src=\"js/app.js[^\\\"]*\"|src=\"app.bundle.js?v=$VERSION\"|" \
    -e "s|type=\"module\"||" \
    -e "s|href=\"css/style.css[^\\\"]*\"|href=\"style.css?v=$VERSION\"|" \
    -e "s|href=\"css/layout.css[^\\\"]*\"|href=\"layout.css?v=$VERSION\"|" \
    -e "s|href=\"css/upload.css[^\\\"]*\"|href=\"upload.css?v=$VERSION\"|" \
    "$TARGET_DIR/index.html"

echo "✅ Deployment complete! (Version $VERSION)"
ls -l "$TARGET_DIR"
