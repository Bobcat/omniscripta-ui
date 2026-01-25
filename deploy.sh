#!/bin/bash
set -e

# Configuration
APP_DIR="/var/www/omniscripta-app"
TARGET_DIR="/srv/transcribe/static"
ESBUILD="$APP_DIR/node_modules/.bin/esbuild"

echo "🚀 Starting deployment to $TARGET_DIR..."

# 1. Clean legacy files (be explicit to avoid accidents)
echo "🧹 Cleaning target directory..."
rm -f "$TARGET_DIR/editor.html"
rm -f "$TARGET_DIR/app.bundle.js"
rm -f "$TARGET_DIR/style.css"
rm -rf "$TARGET_DIR/assets"
rm -rf "$TARGET_DIR/editor_build"

# 2. Build JS Bundle
echo "📦 Bundling JavaScript..."
$ESBUILD "$APP_DIR/js/app.js" \
  --bundle \
  --outfile="$TARGET_DIR/app.bundle.js" \
  --minify \
  --sourcemap \
  --target=es2020

# 3. Copy/Process CSS
# For now, just copy. We could concat if we had multiple.
echo "🎨 Deploying CSS..."
cp "$APP_DIR/css/style.css" "$TARGET_DIR/style.css"

# 4. Deploy HTML
# We rename omniscripta.html to editor.html to match server expectations,
# BUT we need to update the references inside it effectively.
echo "📄 Deploying HTML..."

# Use sed to replace module script with bundle reference and css path
# Original: <script type="module" src="js/app.js"></script>
# Target:   <script src="app.bundle.js"></script>
# Original: <link rel="stylesheet" href="css/style.css">
# Target:   <link rel="stylesheet" href="style.css">

sed -e 's|src="js/app.js"|src="app.bundle.js"|' \
    -e 's|type="module"||' \
    -e 's|href="css/style.css"|href="style.css"|' \
    "$APP_DIR/omniscripta.html" > "$TARGET_DIR/editor.html"

echo "✅ Deployment complete!"
ls -l "$TARGET_DIR"
