#!/usr/bin/env bash
set -euo pipefail

LAUNCHER_PATH="${1:-./rovodev-launcher.command}"

if [ ! -f "$LAUNCHER_PATH" ]; then
  echo "Launcher not found: $LAUNCHER_PATH" >&2
  exit 1
fi

OUT="$(mktemp)"
cleanup() {
  rm -f "$OUT"
}
trap cleanup EXIT

set +e
ROVODEV_SKIP_GATE=1 "$LAUNCHER_PATH" --non-interactive --no-shortcut --no-dock >"$OUT" 2>&1
RC=$?
set -e

CONTENT="$(<"$OUT")"

if [[ "$CONTENT" == *"ImportError: Failed to initialize: Cmd('git') failed due to: exit code(1)"* ]]; then
  echo "FAIL: git/Xcode bootstrap regression detected" >&2
  exit 1
fi

if [[ "$CONTENT" == *"xcode-select: note: No developer tools were found, requesting install."* ]]; then
  echo "FAIL: launcher still triggers xcode-select CLT prompt" >&2
  exit 1
fi

if [[ "$CONTENT" != *"Checking authentication"* ]]; then
  echo "FAIL: auth phase did not execute" >&2
  exit 1
fi

if [[ "$CONTENT" != *"Launching Rovo Dev"* ]]; then
  echo "FAIL: launch phase did not execute" >&2
  exit 1
fi

if [ "$RC" -ne 0 ]; then
  if [[ "$CONTENT" == *"Cannot launch Rovo Dev without valid authentication."* ]]; then
    echo "PASS: launcher reached auth gate and failed fast (expected when unauthenticated)"
    exit 0
  fi
  if [[ "$CONTENT" == *"403 Forbidden"* ]]; then
    echo "PASS: launcher reached auth/access checks (403 returned by backend)"
    exit 0
  fi
  echo "FAIL: launcher failed unexpectedly (exit=$RC)" >&2
  exit 1
fi

echo "PASS: launcher smoke test succeeded"
