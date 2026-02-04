#!/bin/bash
set -e

# Configuration
APP_DIR="/var/www/omniscripta-app"
TARGET_DIR="/srv/transcribe/static"
ESBUILD="$APP_DIR/node_modules/.bin/esbuild"

echo "🚀 Starting deployment to $TARGET_DIR..."

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
sed -i \
    -e 's|src="js/app.js"|src="app.bundle.js"|' \
    -e 's|type="module"||' \
    -e 's|href="css/style.css"|href="style.css"|' \
    -e 's|href="css/layout.css"|href="layout.css"|' \
    -e 's|href="css/upload.css"|href="upload.css"|' \
    "$TARGET_DIR/index.html"

echo "✅ Deployment complete!"
ls -l "$TARGET_DIR"
