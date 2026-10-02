#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$APP_DIR/.." && pwd)"
PACKAGE_NAME="KharratCode-Windows10-Portable"
OUTPUT="$REPO_DIR/${PACKAGE_NAME}.zip"
WORK_DIR="$APP_DIR/.portable-build"
PACKAGE_DIR="$WORK_DIR/$PACKAGE_NAME"
LAUNCHER_SOURCE="$APP_DIR/portable/windows-launcher/main.c"

if ! command -v zip >/dev/null 2>&1; then
  echo "The zip command is required." >&2
  exit 1
fi

rm -rf "$WORK_DIR"
mkdir -p "$PACKAGE_DIR"
trap 'rm -rf "$WORK_DIR"' EXIT

cd "$APP_DIR"
npm run build
node scripts/prepare-portable-html.mjs dist/index.html "$PACKAGE_DIR/KharratCode.html"

# An explicit Zig path takes precedence so local and CI builds can use the same
# pinned compiler: ZIG_BIN=/path/to/zig npm run build:portable:win
if [[ -n "${ZIG_BIN:-}" && -x "${ZIG_BIN}" ]]; then
  "$ZIG_BIN" cc -target x86_64-windows-gnu -Os -s -Wl,--subsystem,windows \
    -o "$PACKAGE_DIR/KharratCode.exe" "$LAUNCHER_SOURCE" -lshell32
elif command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1; then
  x86_64-w64-mingw32-gcc -Os -s -mwindows -Wl,--no-insert-timestamp \
    -o "$PACKAGE_DIR/KharratCode.exe" "$LAUNCHER_SOURCE" -lshell32
elif command -v zig >/dev/null 2>&1; then
  zig cc -target x86_64-windows-gnu -Os -s -Wl,--subsystem,windows \
    -o "$PACKAGE_DIR/KharratCode.exe" "$LAUNCHER_SOURCE" -lshell32
else
  echo "A Windows MinGW compiler or Zig is required to build KharratCode.exe." >&2
  exit 1
fi
node scripts/normalize-pe-timestamp.mjs "$PACKAGE_DIR/KharratCode.exe"

cat > "$PACKAGE_DIR/README.txt" <<'README'
KharratCode — Windows 10 Portable
=================================

English
-------
1. Extract this ZIP completely to any writable folder.
2. Double-click KharratCode.exe.
3. The application opens in your default browser and works entirely offline.
4. Keep KharratCode.exe and KharratCode.html in the same folder.

No installation, administrator access, or internet connection is required.
The launcher only opens the bundled local HTML application. If Windows
SmartScreen warns about an unsigned application, choose "More info" and then
"Run anyway" after confirming that this ZIP came from the project repository.

فارسی
-----
۱. فایل ZIP را به‌طور کامل در یک پوشه دلخواه استخراج کنید.
۲. فایل KharratCode.exe را اجرا کنید.
۳. نرم‌افزار در مرورگر پیش‌فرض باز می‌شود و کاملاً آفلاین کار می‌کند.
۴. دو فایل KharratCode.exe و KharratCode.html را کنار یکدیگر نگه دارید.

نصب، دسترسی Administrator یا اتصال اینترنت لازم نیست. اگر SmartScreen به دلیل
امضانشدن فایل هشدار داد، پس از اطمینان از دریافت ZIP از مخزن پروژه، گزینه‌های
More info و سپس Run anyway را انتخاب کنید.
README

# Fixed timestamps and stripped ZIP metadata keep the archive reproducible.
find "$PACKAGE_DIR" -exec touch -t 200001010000 {} +
TMP_OUTPUT="$WORK_DIR/${PACKAGE_NAME}.zip"
(
  cd "$WORK_DIR"
  zip -X -9 -q "$TMP_OUTPUT" \
    "$PACKAGE_NAME/" \
    "$PACKAGE_NAME/KharratCode.exe" \
    "$PACKAGE_NAME/KharratCode.html" \
    "$PACKAGE_NAME/README.txt"
)
mv -f "$TMP_OUTPUT" "$OUTPUT"

echo "Created: $OUTPUT"
