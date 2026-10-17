#!/bin/bash
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DESTINATION="${SKINS_DIR:-/Volumes/out_device/ZushiSkins}"
[[ -d "$(dirname "$DESTINATION")" ]] || { echo '请先连接 out_device 外置盘。'; exit 1; }
mkdir -p "$PROJECT_DIR/.local-build"
ARCHIVE="$PROJECT_DIR/.local-build/all-skins.tar.gz"
if [[ "${1:-}" != --import-existing ]]; then
  curl -fL --connect-timeout 20 --max-time 600 --retry 3 --retry-delay 3 \
    https://codeload.github.com/Alban1911/LeagueSkins/tar.gz/refs/heads/main -o "$ARCHIVE.part"
  mv "$ARCHIVE.part" "$ARCHIVE"
fi
python3 "$PROJECT_DIR/scripts/import-skin-library.py" "$ARCHIVE" "$DESTINATION"
echo '导入完成。重新打开 Zushi 后，My Skins 会读取外置盘的全部皮肤。'
