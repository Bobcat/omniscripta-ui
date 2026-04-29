#!/bin/bash
set -e

# Configuration
APP_DIR="/var/www/omniscripta-ui"
TARGET_DIR="/srv/omniscripta/static"
ESBUILD="$APP_DIR/node_modules/.bin/esbuild"
FOUNDATION_CORE_DIR="/home/gunnar/projects/spa-foundation/core"

echo "🚀 Starting deployment to: $TARGET_DIR"
# 0. Generate a stateless cache-busting token for this deploy.
VERSION="$(date -u +%Y%m%d%H%M%S)-$$"
echo "🔖 Cache-busting version: $VERSION"

# 0b. Refresh local foundation packages (file: dependencies)
echo "🔗 Refreshing local foundation packages..."
if [ ! -d "$FOUNDATION_CORE_DIR" ]; then
    echo "❌ Missing local spa-foundation package directories:"
    echo "   $FOUNDATION_CORE_DIR"
    exit 1
fi
rm -rf "$APP_DIR/node_modules/@spa-foundation/core"
npm --prefix "$APP_DIR" install --no-audit --no-fund \
    --no-save \
    "@spa-foundation/core@file:$FOUNDATION_CORE_DIR" >/dev/null

# 1. Clean legacy files
echo "🧹 Cleaning target directory..."
rm -f "$TARGET_DIR/editor.html"
rm -f "$TARGET_DIR/app.bundle.js"
rm -f "$TARGET_DIR/app.bundle.js.map"
rm -f "$TARGET_DIR/style.css"
rm -f "$TARGET_DIR/layout.css"
rm -f "$TARGET_DIR/upload.css"
rm -rf "$TARGET_DIR/app"
rm -rf "$TARGET_DIR/assets"
rm -rf "$TARGET_DIR/editor_build"
rm -rf "$TARGET_DIR/dev-fixtures"
rm -rf "$TARGET_DIR/landing-screenshots"

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
  --loader:.svg=dataurl \
  --minify \
  --log-level=error \
  --target=es2020

# 4. Copy standalone CSS files
cp "$APP_DIR/css/layout.css" "$TARGET_DIR/layout.css"
cp "$APP_DIR/css/upload.css" "$TARGET_DIR/upload.css"

# 5. Deploy HTML (SPA Shell)
cp "$APP_DIR/index.html" "$TARGET_DIR/index.html"
mkdir -p "$TARGET_DIR/app"
cp "$APP_DIR/app/index.html" "$TARGET_DIR/app/index.html"

# Prod-only UI policy: hide Settings entry from sidebar in deployed app shell.
perl -0pi -e 's/\n\s*<li data-action="settings" title="Settings">.*?<\/li>\n/\n/s' "$TARGET_DIR/app/index.html"

# 5b. Deploy dev fixtures (optional)
if [ -d "$APP_DIR/dev-fixtures" ]; then
    cp -r "$APP_DIR/dev-fixtures" "$TARGET_DIR/dev-fixtures"
    find "$TARGET_DIR/dev-fixtures" -type d -exec chmod 755 {} \;
    find "$TARGET_DIR/dev-fixtures" -type f -exec chmod 644 {} \;
fi

# 5c. Deploy landing screenshots
if [ -d "$APP_DIR/landing-screenshots" ]; then
    cp -r "$APP_DIR/landing-screenshots" "$TARGET_DIR/landing-screenshots"
    find "$TARGET_DIR/landing-screenshots" -type d -exec chmod 755 {} \;
    find "$TARGET_DIR/landing-screenshots" -type f -exec chmod 644 {} \;
fi

sed -i \
    -e "s|src=\"/js/app.js[^\\\"]*\"|src=\"/app.bundle.js?v=$VERSION\"|" \
    -e "s|type=\"module\"||" \
    -e "s|href=\"/css/style.css[^\\\"]*\"|href=\"/style.css?v=$VERSION\"|" \
    -e "s|href=\"/css/layout.css[^\\\"]*\"|href=\"/layout.css?v=$VERSION\"|" \
    -e "s|href=\"/css/upload.css[^\\\"]*\"|href=\"/upload.css?v=$VERSION\"|" \
    "$TARGET_DIR/index.html"

perl -0pi -e "s|src=\"/landing-screenshots/([^\"?]+)(?:\?v=\d+)?\"|src=\"/landing-screenshots/\$1?v=$VERSION\"|g" "$TARGET_DIR/index.html"

sed -i \
    -e "s|src=\"/js/app.js[^\\\"]*\"|src=\"/app.bundle.js?v=$VERSION\"|" \
    -e "s|type=\"module\"||" \
    -e "s|href=\"/css/style.css[^\\\"]*\"|href=\"/style.css?v=$VERSION\"|" \
    -e "s|href=\"/css/layout.css[^\\\"]*\"|href=\"/layout.css?v=$VERSION\"|" \
    -e "s|href=\"/css/upload.css[^\\\"]*\"|href=\"/upload.css?v=$VERSION\"|" \
    "$TARGET_DIR/app/index.html"

echo "✅ Deployment complete! (Version $VERSION)"
ls -l "$TARGET_DIR"
