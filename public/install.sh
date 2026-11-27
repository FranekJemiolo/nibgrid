#!/usr/bin/env sh
set -eu

REPO="FranekJemiolo/nibgrid"
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS-$ARCH" in
  Darwin-arm64)  ASSET_MATCH="macos-arm64.dmg" ;;
  Darwin-x86_64) ASSET_MATCH="macos-x64.dmg" ;;
  Linux-x86_64)  ASSET_MATCH="linux-x64.AppImage" ;;
  *)
    echo "Unsupported platform: $OS-$ARCH" >&2
    exit 1
    ;;
esac

TAG="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": "\([^"]*\)".*/\1/p' | head -n1)"
if [ -z "$TAG" ]; then
  echo "Failed to resolve latest release tag for $REPO." >&2
  exit 1
fi

VERSION="${TAG#v}"
BASE_URL="https://github.com/$REPO/releases/download/$TAG"
ASSET="Nibgrid-Studio-${VERSION}-${ASSET_MATCH}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Downloading $ASSET ($TAG)..."
curl -fL "$BASE_URL/$ASSET" -o "$TMP_DIR/$ASSET"
curl -fsSL "$BASE_URL/SHA256SUMS.txt" -o "$TMP_DIR/SHA256SUMS.txt"

echo "Verifying SHA-256 checksum..."
EXPECTED="$(grep "  $ASSET$" "$TMP_DIR/SHA256SUMS.txt" | awk '{print $1}' | head -n1)"
if [ -z "$EXPECTED" ]; then
  echo "Checksum entry missing for $ASSET in SHA256SUMS.txt!" >&2
  exit 1
fi

if command -v shasum >/dev/null 2>&1; then
  ACTUAL="$(shasum -a 256 "$TMP_DIR/$ASSET" | awk '{print $1}')"
else
  ACTUAL="$(sha256sum "$TMP_DIR/$ASSET" | awk '{print $1}')"
fi

[ "$EXPECTED" = "$ACTUAL" ] || {
  echo "Checksum mismatch! Expected $EXPECTED, got $ACTUAL" >&2
  exit 1
}

if [ "$OS" = "Darwin" ]; then
  MOUNT_DIR="$TMP_DIR/mnt"
  mkdir -p "$MOUNT_DIR"
  hdiutil attach "$TMP_DIR/$ASSET" -nobrowse -quiet -mountpoint "$MOUNT_DIR"
  rm -rf "/Applications/Nibgrid Studio.app"
  cp -R "$MOUNT_DIR/Nibgrid Studio.app" "/Applications/"
  hdiutil detach "$MOUNT_DIR" -quiet
  echo "Installed to /Applications/Nibgrid Studio.app"
else
  mkdir -p "$HOME/.local/bin"
  mv "$TMP_DIR/$ASSET" "$HOME/.local/bin/nibgrid-studio"
  chmod +x "$HOME/.local/bin/nibgrid-studio"
  echo "Installed to $HOME/.local/bin/nibgrid-studio"
fi
