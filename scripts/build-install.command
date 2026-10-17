#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# Also allow the delivered copy in outputs/ to run this checkout.
if [[ ! -f "$PROJECT_DIR/package.json" ]]; then
  PROJECT_DIR="$PROJECT_DIR/out_device"
fi
cd "$PROJECT_DIR"
LOCAL_TOOLS="$PROJECT_DIR/.local-build/tools"
[[ -d "$LOCAL_TOOLS" ]] || LOCAL_TOOLS="$PROJECT_DIR/../work"
if [[ -d "$LOCAL_TOOLS/toolchain/cargo/bin" ]]; then
  export CARGO_HOME="$LOCAL_TOOLS/toolchain/cargo"
  export RUSTUP_HOME="$LOCAL_TOOLS/toolchain/rustup"
  export PATH="$CARGO_HOME/bin:$PATH"
fi
for tool_dir in "$LOCAL_TOOLS"/node-*-darwin-*/bin "$LOCAL_TOOLS"/cmake-*-macos-universal/CMake.app/Contents/bin; do
  [[ ! -d "$tool_dir" ]] || export PATH="$tool_dir:$PATH"
done
[[ "$(uname -s)" == Darwin ]] || { echo '此脚本仅支持 macOS。'; exit 1; }
for tool in node npm cargo rustc cmake; do
  command -v "$tool" >/dev/null || { echo "缺少 $tool，请先安装 Node.js 22+、Rust 和 CMake。"; exit 1; }
done
xcrun --find clang >/dev/null || { echo '请先运行 xcode-select --install。'; exit 1; }
TARGET="$(rustc -vV | sed -n 's/^host: //p')"
case "$TARGET" in
  aarch64-apple-darwin) ARCH=arm64 ;;
  x86_64-apple-darwin) ARCH=x86_64 ;;
  *) echo "不支持的目标：$TARGET"; exit 1 ;;
esac
APP="$PROJECT_DIR/src-tauri/target/$TARGET/release/bundle/macos/Zushi.app"
if [[ "${1:-}" != --install-only ]]; then
  echo '正在安装依赖…'
  npm ci --no-audit --no-fund
  [[ "${SKIP_TESTS:-0}" == 1 ]] || npm test
  echo '正在编译 mod-tools…'
  CMAKE_ARGS=(-S mod-tools -B mod-tools/build -DCMAKE_BUILD_TYPE=Release "-DCMAKE_OSX_ARCHITECTURES=$ARCH")
  for dependency in xxhash zstd libdeflate miniz fmt fmtlog; do
    source_dir="$PROJECT_DIR/.local-build/deps/$dependency-src"
    if [[ -d "$source_dir" ]]; then
      dependency_upper="$(echo "$dependency" | tr '[:lower:]' '[:upper:]')"
      CMAKE_ARGS+=("-DFETCHCONTENT_SOURCE_DIR_$dependency_upper=$source_dir")
    fi
  done
  cmake "${CMAKE_ARGS[@]}"
  cmake --build "mod-tools/build" -j "$(sysctl -n hw.ncpu)"
  mkdir -p src-tauri/binaries
  cp "mod-tools/build/mod-tools" "src-tauri/binaries/mod-tools-$TARGET"
  chmod +x "src-tauri/binaries/mod-tools-$TARGET"
  echo '正在编译 Zushi…'
  npm run tauri -- build --target "$TARGET" --bundles app
  [[ "${SKIP_TESTS:-0}" == 1 ]] || cargo test --release --locked --target "$TARGET" --manifest-path src-tauri/Cargo.toml --lib commands::
fi
[[ -d "$APP" ]] || { echo "找不到编译结果：$APP"; exit 1; }
codesign --force --sign - "$APP/Contents/MacOS/mod-tools"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"
[[ "${BUILD_ONLY:-0}" != 1 ]] || { echo "编译完成：$APP"; exit 0; }
INSTALL_DIR="${INSTALL_DIR:-/Applications}"
mkdir -p "$INSTALL_DIR"
STAGED="$INSTALL_DIR/.Zushi-install-$$.app"
BACKUP="$PROJECT_DIR/.local-build/backups/Zushi-$(date +%Y%m%d-%H%M%S).app"
cleanup() {
  [[ ! -d "$STAGED" ]] || rm -rf "$STAGED"
  if [[ ! -d "$INSTALL_DIR/Zushi.app" && -d "$BACKUP" ]]; then
    mv "$BACKUP" "$INSTALL_DIR/Zushi.app"
  fi
}
trap cleanup EXIT
# Stage and verify before replacing the installed app.
ditto "$APP" "$STAGED"
codesign --verify --deep --strict "$STAGED"
if pgrep -x zushi >/dev/null; then
  osascript -e 'tell application "Zushi" to quit'
  for attempt in {1..10}; do
    pgrep -x zushi >/dev/null || break
    sleep 1
  done
  if pgrep -x zushi >/dev/null; then
    echo '请关闭正在运行的 Zushi 后重新执行脚本。'; exit 1
  fi
fi
if [[ -d "$INSTALL_DIR/Zushi.app" ]]; then
  mkdir -p "$(dirname "$BACKUP")"
  mv "$INSTALL_DIR/Zushi.app" "$BACKUP"
  echo "旧版已备份：$BACKUP"
fi
mv "$STAGED" "$INSTALL_DIR/Zushi.app"
touch "$INSTALL_DIR/Zushi.app"
echo "已安装：$INSTALL_DIR/Zushi.app"
[[ "${NO_OPEN:-0}" == 1 ]] || open "$INSTALL_DIR/Zushi.app"
