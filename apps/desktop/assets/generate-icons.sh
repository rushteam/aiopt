#!/usr/bin/env bash
# Regenerate all app-icon assets from the master SVGs in this directory.
#
# Sources (hand-authored, the single source of truth for the mark):
#   icon.svg        — detailed app icon (with center cutout), used at >= 128px
#   icon-small.svg  — solid variant (no cutout), used at favicon sizes so the mark
#                     stays legible when the cutout would vanish (the "auto-downgrade")
#   mark.svg        — transparent, no plate; for in-app / title-bar embedding
#
# Outputs (committed, consumed by forge.config.ts + index.html):
#   icon.icns              — macOS packaged app icon
#   icon.ico               — Windows packaged app icon
#   favicon-16.png / -32.png, favicon.svg — renderer favicon
#
# Requires: rsvg-convert, iconutil (macOS), python3 + Pillow (for .ico).
# Run from anywhere: `bash apps/desktop/assets/generate-icons.sh`
set -euo pipefail
cd "$(dirname "$0")"

echo "→ favicon (solid small master, auto-downgraded for legibility)"
cp icon-small.svg favicon.svg
rsvg-convert -w 16 -h 16 icon-small.svg -o favicon-16.png
rsvg-convert -w 32 -h 32 icon-small.svg -o favicon-32.png

echo "→ macOS .icns (detailed master; 16/32 slots use the solid one)"
ICONSET="$(mktemp -d)/AiOpt.iconset"
mkdir -p "$ICONSET"
# Large slots: detailed icon
for sz in 128 256 512 1024; do
  rsvg-convert -w "$sz" -h "$sz" icon.svg -o "$ICONSET/icon_${sz}x${sz}.png"
done
# Small slots: solid icon (cutout would disappear)
rsvg-convert -w 16 -h 16 icon-small.svg -o "$ICONSET/icon_16x16.png"
rsvg-convert -w 32 -h 32 icon-small.svg -o "$ICONSET/icon_32x32.png"
# Retina @2x aliases expected by iconutil
cp "$ICONSET/icon_32x32.png"     "$ICONSET/icon_16x16@2x.png"
rsvg-convert -w 64  -h 64  icon.svg -o "$ICONSET/icon_32x32@2x.png"
rsvg-convert -w 256 -h 256 icon.svg -o "$ICONSET/icon_128x128@2x.png"
cp "$ICONSET/icon_512x512.png"   "$ICONSET/icon_256x256@2x.png"
cp "$ICONSET/icon_1024x1024.png" "$ICONSET/icon_512x512@2x.png"
mv "$ICONSET/icon_256x256.png"   "$ICONSET/icon_256x256.png"
iconutil -c icns "$ICONSET" -o icon.icns
rm -rf "$(dirname "$ICONSET")"

echo "→ Windows .ico (multi-resolution; small sizes solid, large detailed)"
# Each size is rendered from the RIGHT master (small→solid, large→detailed) and the
# .ico is assembled byte-for-byte from those independent PNGs — NOT downscaled from
# one base image (which is what Pillow's sizes= does, and it would smear the small
# slots). This is the real auto-downgrade.
python3 - <<'PY'
import subprocess, tempfile, os, struct
plan = [(16, "icon-small.svg"), (32, "icon-small.svg"), (48, "icon-small.svg"),
        (64, "icon.svg"), (128, "icon.svg"), (256, "icon.svg")]
tmp = tempfile.mkdtemp()
pngs = []
for sz, src in plan:
    p = os.path.join(tmp, f"{sz}.png")
    subprocess.run(["rsvg-convert", "-w", str(sz), "-h", str(sz), src, "-o", p], check=True)
    with open(p, "rb") as f:
        pngs.append((sz, f.read()))

# Build ICO container: ICONDIR + ICONDIRENTRY[] + PNG payloads
count = len(pngs)
header = struct.pack("<HHH", 0, 1, count)
entries = b""
offset = 6 + count * 16
payloads = b""
for sz, blob in pngs:
    b = sz if sz < 256 else 0  # 0 means 256 in the ICO spec
    entries += struct.pack("<BBBBHHII", b, b, 0, 0, 1, 32, len(blob), offset)
    offset += len(blob)
    payloads += blob
with open("icon.ico", "wb") as f:
    f.write(header + entries + payloads)
print(f"  icon.ico written with {count} sizes: {[s for s,_ in pngs]}")
PY

echo "→ macOS Tray template icon (monochrome black silhouette, base64 → TS const)"
# The menu-bar icon is a TEMPLATE image: single-colour + alpha, tinted by the OS for
# light/dark bars — so it drops the brand gradient and fills the mark path black. It's
# embedded as base64 in src (not a loose file) so it survives asar packaging without a
# runtime path. Scale 1.35 (vs the app icon's 1.5) leaves a hair of menu-bar padding.
TRAY_SVG="$(mktemp).svg"
cat > "$TRAY_SVG" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <g transform="translate(256,256) scale(1.35)"><path d="M 0 -148 C 42 -14.7, 14.7 -42, 148 0 C 14.7 42, 42 14.7, 0 148 C -42 14.7, -14.7 42, -148 0 C -14.7 -42, -42 -14.7, 0 -148 Z" fill="#000000"/></g>
</svg>
SVG
TRAY_16="$(mktemp).png"; TRAY_32="$(mktemp).png"
rsvg-convert -w 16 -h 16 "$TRAY_SVG" -o "$TRAY_16"
rsvg-convert -w 32 -h 32 "$TRAY_SVG" -o "$TRAY_32"
TRAY_B64_16="$(base64 -i "$TRAY_16" | tr -d '\n')"
TRAY_B64_32="$(base64 -i "$TRAY_32" | tr -d '\n')"
cat > ../src/main/tray/trayIconData.ts <<TS
// GENERATED — do not edit by hand.
//
// macOS menu-bar (Tray) template icon: the AiOpt four-pointed sparkle rendered as
// a monochrome black silhouette + alpha, at @1x (16px) and @2x (32px). A template
// image (see tray.ts \`setTemplateImage(true)\`) is intentionally single-colour — the
// OS tints it for light/dark menu bars — so the brand gradient is NOT used here.
//
// Regenerate with \`bash apps/desktop/assets/generate-icons.sh\` (the tray step),
// which renders assets/mark.svg's path as a black fill and base64-encodes the PNGs.

/** 16×16 black template PNG, base64 data URL (@1x). */
export const TRAY_ICON_16 =
  'data:image/png;base64,${TRAY_B64_16}';

/** 32×32 black template PNG, base64 data URL (@2x, retina menu bars). */
export const TRAY_ICON_32 =
  'data:image/png;base64,${TRAY_B64_32}';
TS
rm -f "$TRAY_SVG" "$TRAY_16" "$TRAY_32"

echo "✓ done:"
ls -la icon.icns icon.ico favicon.svg favicon-16.png favicon-32.png
ls -la ../src/main/tray/trayIconData.ts
