#!/usr/bin/env bash
set -euo pipefail

REPO="${ROVODEV_REPO:-siddharthachaturvedi/rovodev}"
REF="${ROVODEV_VERSION:-}"

resolve_ref() {
  if [ -n "$REF" ]; then
    printf "%s" "$REF"
    return
  fi

  local latest_tag
  latest_tag="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | python3 -c 'import json,sys; print((json.load(sys.stdin).get("tag_name") or "").strip())' 2>/dev/null || true)"
  if [ -n "$latest_tag" ]; then
    printf "%s" "$latest_tag"
    return
  fi

  printf "main"
}

TARGET_REF="$(resolve_ref)"
TMP_DIR="$(mktemp -d)"
ARCHIVE_PATH="${TMP_DIR}/rovodev.tgz"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

download_archive() {
  local url="$1"
  set +e
  curl -fsSL "$url" -o "$ARCHIVE_PATH"
  local status=$?
  set -e
  return $status
}

clone_repo_fallback() {
  local ref="$1"
  local clone_dir="${TMP_DIR}/clone"
  if command -v git >/dev/null 2>&1; then
    if git clone --depth 1 --branch "$ref" "https://github.com/${REPO}.git" "$clone_dir" >/dev/null 2>&1; then
      printf "%s" "$clone_dir"
      return 0
    fi
    if [ "$ref" = "main" ] || [ "$ref" = "master" ]; then
      if git clone --depth 1 "https://github.com/${REPO}.git" "$clone_dir" >/dev/null 2>&1; then
        printf "%s" "$clone_dir"
        return 0
      fi
    fi
  fi
  return 1
}

if [[ "$TARGET_REF" == "main" ]] || [[ "$TARGET_REF" == "master" ]]; then
  ARCHIVE_URL="https://github.com/${REPO}/archive/refs/heads/${TARGET_REF}.tar.gz"
else
  ARCHIVE_URL="https://github.com/${REPO}/archive/refs/tags/${TARGET_REF}.tar.gz"
fi

echo "Fetching RovoDev Hub uninstaller (${TARGET_REF})..."
EXTRACTED_ROOT=""
if download_archive "$ARCHIVE_URL"; then
  tar -xzf "$ARCHIVE_PATH" -C "$TMP_DIR"
  EXTRACTED_ROOT="$(ls -1d "${TMP_DIR}"/rovodev-* | head -n 1)"
else
  echo "Archive download failed, trying git clone fallback..."
  EXTRACTED_ROOT="$(clone_repo_fallback "$TARGET_REF" || true)"
fi

UNINSTALL_PATH="${EXTRACTED_ROOT}/rovodev-uninstall.command"
if [ ! -f "$UNINSTALL_PATH" ]; then
  echo "Could not find uninstaller in downloaded archive (${UNINSTALL_PATH})." >&2
  echo "Set ROVODEV_VERSION to a valid tag/branch or ensure repository access." >&2
  exit 1
fi

bash "$UNINSTALL_PATH" "$@"
