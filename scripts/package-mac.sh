#!/bin/bash
# Empaqueta Codycube como app de macOS (dist/Codycube.app) sin dependencias extra: parte del
# Electron.app de node_modules, le pone el código compilado, el nombre, el icono y la firma ad hoc.
#
# Uso (desde cualquier carpeta):
#   npm run package:mac   → solo genera dist/Codycube.app
#   npm run install:mac   → la genera y la mueve a /Applications (o ~/Applications si no hay permiso)
set -euo pipefail
cd "$(dirname "$0")/.."

NAME=Codycube
BUNDLE_ID=com.godie007.codycube
VERSION=$(node -p "require('./package.json').version")
ELECTRON=node_modules/electron/dist/Electron.app
OUT=dist/$NAME.app
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

[ "$(uname)" = Darwin ] || { echo "Solo en macOS" >&2; exit 1; }
[ -d "$ELECTRON" ] || { echo "Falta $ELECTRON: ejecuta npm install" >&2; exit 1; }
[ -f resources/icon.png ] || { echo "Falta resources/icon.png: ejecuta npx electron scripts/icon.cjs" >&2; exit 1; }

echo "› Compilando"
npm run --silent typecheck
npx electron-vite build >/dev/null

echo "› Armando $OUT ($VERSION)"
rm -rf "$OUT"
mkdir -p dist
# ditto conserva los enlaces simbólicos de los frameworks
ditto "$ELECTRON" "$OUT"
mv "$OUT/Contents/MacOS/Electron" "$OUT/Contents/MacOS/$NAME"
rm -f "$OUT/Contents/Resources/default_app.asar" "$OUT/Contents/Resources/electron.icns"

# El código: lo compilado, el icono y un package.json mínimo. Todas las dependencias, también las
# del proceso principal, van dentro de los bundles de Vite: no hace falta node_modules.
APP="$OUT/Contents/Resources/app"
mkdir -p "$APP"
ditto out "$APP/out"
ditto resources "$APP/resources"
# Mismo "name" que en desarrollo: comparten kubeconfigs cargados y preferencias
node -e "const p = require('./package.json'); require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ name: p.name, version: p.version, description: p.description, main: p.main, private: true }, null, 2) + '\n')" "$APP/package.json"

echo "› Icono"
ICONSET=$(mktemp -d)/$NAME.iconset
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z $size $size resources/icon.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) resources/icon.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$OUT/Contents/Resources/$NAME.icns"
rm -rf "$(dirname "$ICONSET")"

PLIST="$OUT/Contents/Info.plist"
plutil -replace CFBundleExecutable -string "$NAME" "$PLIST"
plutil -replace CFBundleName -string "$NAME" "$PLIST"
plutil -replace CFBundleDisplayName -string "$NAME" "$PLIST"
plutil -replace CFBundleIdentifier -string "$BUNDLE_ID" "$PLIST"
plutil -replace CFBundleIconFile -string "$NAME.icns" "$PLIST"
plutil -replace CFBundleShortVersionString -string "$VERSION" "$PLIST"
plutil -replace CFBundleVersion -string "$VERSION" "$PLIST"
# Apuntaba a default_app.asar, que ya no está
plutil -remove ElectronAsarIntegrity "$PLIST" 2>/dev/null || true

echo "› Firmando (ad hoc)"
xattr -cr "$OUT" 2>/dev/null || true
codesign --force --deep --sign - "$OUT" 2>/dev/null
codesign --verify --deep --strict "$OUT"
echo "✓ $OUT ($(du -sh "$OUT" | cut -f1))"

[ "${1:-}" = "--install" ] || exit 0

if pgrep -xq "$NAME"; then
  echo "Codycube está abierto: ciérralo (⌘Q) y vuelve a ejecutar npm run install:mac" >&2
  exit 1
fi
DEST=/Applications
[ -w "$DEST" ] || { DEST="$HOME/Applications"; mkdir -p "$DEST"; }
rm -rf "${DEST:?}/$NAME.app"
# Se mueve en vez de copiar: con una copia en dist/, Spotlight y Launchpad mostrarían dos Codycube
"$LSREGISTER" -u "$OUT" 2>/dev/null || true
mv "$OUT" "$DEST/$NAME.app"
# Para que Spotlight, Launchpad y el Dock vean la versión nueva (y su icono) enseguida
"$LSREGISTER" -f "$DEST/$NAME.app" 2>/dev/null || true
touch "$DEST/$NAME.app"
echo "✓ Instalada en $DEST/$NAME.app"
