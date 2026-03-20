#!/bin/bash
# ============================================================================
#  Rovo Dev Uninstaller
#  Double-click to cleanly remove everything installed by rovodev-launcher.
# ============================================================================
set -euo pipefail

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
PURPLE='\033[0;35m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# --- Terminal setup ---
echo -ne "\033]0;Rovo Dev Uninstaller\007"

ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; }
info() { echo -e "  ${DIM}  $1${NC}"; }

clear
echo ""
echo -e "${RED}${BOLD}"
cat << 'BANNER'
    ____                      ____
   / __ \____  _   ______    / __ \___  _   __
  / /_/ / __ \| | / / __ \  / / / / _ \| | / /
 / _, _/ /_/ /| |/ / /_/ / / /_/ /  __/| |/ /
/_/ |_|\____/ |___/\____/ /_____/\___/ |___/

          U N I N S T A L L E R
BANNER
echo -e "${NC}"
echo -e "${DIM}  This will remove everything installed by rovodev-launcher.${NC}"
echo ""

# --- Show what will be removed ---
echo -e "${BOLD}The following will be removed:${NC}"
echo ""

ITEMS_FOUND=0

if [ -d "$HOME/rovodev" ]; then
    SIZE=$(du -sh "$HOME/rovodev" 2>/dev/null | cut -f1)
    echo -e "  ${YELLOW}→${NC} ~/rovodev/              ${DIM}($SIZE — binary, workspace, assets)${NC}"
    ITEMS_FOUND=$((ITEMS_FOUND + 1))
fi

if [ -d "$HOME/Desktop/Rovo Dev.app" ]; then
    echo -e "  ${YELLOW}→${NC} ~/Desktop/Rovo Dev.app  ${DIM}(Desktop shortcut)${NC}"
    ITEMS_FOUND=$((ITEMS_FOUND + 1))
fi

if defaults read com.apple.dock persistent-apps 2>/dev/null | grep -q "com.atlassian.rovodev.shortcut"; then
    echo -e "  ${YELLOW}→${NC} Dock pin                ${DIM}(Rovo Dev shortcut in Dock)${NC}"
    ITEMS_FOUND=$((ITEMS_FOUND + 1))
fi

LAUNCHER_SKILLS=("getting-started" "pdf-research" "presentation-builder")
for skill in "${LAUNCHER_SKILLS[@]}"; do
    if [ -d "$HOME/.rovodev/skills/$skill" ]; then
        echo -e "  ${YELLOW}→${NC} ~/.rovodev/skills/$skill/"
        ITEMS_FOUND=$((ITEMS_FOUND + 1))
    fi
done

echo ""

if [ "$ITEMS_FOUND" -eq 0 ]; then
    ok "Nothing to remove — Rovo Dev Launcher was not installed."
    echo ""
    read -n 1 -s -r -p "  Press any key to close..."
    exit 0
fi

# --- What is preserved ---
echo -e "${BOLD}The following will ${GREEN}NOT${NC}${BOLD} be removed:${NC}"
echo ""
echo -e "  ${GREEN}✓${NC} ~/.rovodev/              ${DIM}(your global config, other skills, auth tokens)${NC}"
echo -e "  ${GREEN}✓${NC} Registry-installed skills ${DIM}(anything from npx @atlassian/skills)${NC}"
echo -e "  ${GREEN}✓${NC} Homebrew acli             ${DIM}(if installed separately via brew)${NC}"
echo ""

# --- Confirm ---
echo -e "${DIM}  ─────────────────────────────────────────────────────${NC}"
echo ""
read -p "  Are you sure you want to uninstall? Type 'yes' to confirm: " CONFIRM
echo ""

if [ "$CONFIRM" != "yes" ]; then
    warn "Cancelled. Nothing was removed."
    echo ""
    read -n 1 -s -r -p "  Press any key to close..."
    exit 0
fi

# --- Remove ---
echo -e "${BOLD}Removing...${NC}"
echo ""

if [ -d "$HOME/Desktop/Rovo Dev.app" ]; then
    rm -rf "$HOME/Desktop/Rovo Dev.app"
    ok "Removed ~/Desktop/Rovo Dev.app"
fi

# Remove from Dock if pinned
if defaults read com.apple.dock persistent-apps 2>/dev/null | grep -q "com.atlassian.rovodev.shortcut"; then
    # Read current Dock apps, filter out the Rovo Dev entry, and rewrite
    python3 -c "
import plistlib, os, sys

dock_plist = os.path.expanduser('~/Library/Preferences/com.apple.dock.plist')
with open(dock_plist, 'rb') as f:
    dock = plistlib.load(f)

apps = dock.get('persistent-apps', [])
dock['persistent-apps'] = [
    app for app in apps
    if app.get('tile-data', {}).get('bundle-identifier') != 'com.atlassian.rovodev.shortcut'
]

with open(dock_plist, 'wb') as f:
    plistlib.dump(dock, f)
"
    killall Dock 2>/dev/null || true
    ok "Removed Rovo Dev from Dock"
fi

if [ -d "$HOME/rovodev" ]; then
    rm -rf "$HOME/rovodev"
    ok "Removed ~/rovodev/"
fi

for skill in "${LAUNCHER_SKILLS[@]}"; do
    if [ -d "$HOME/.rovodev/skills/$skill" ]; then
        rm -rf "$HOME/.rovodev/skills/$skill"
        ok "Removed ~/.rovodev/skills/$skill/"
    fi
done

echo ""
echo -e "  ${GREEN}${BOLD}Done!${NC} Rovo Dev Launcher has been cleanly removed."
echo ""
echo -e "  ${DIM}Your auth tokens in ~/.rovodev/ are untouched.${NC}"
echo -e "  ${DIM}To fully remove all Rovo Dev config: rm -rf ~/.rovodev${NC}"
echo ""
read -n 1 -s -r -p "  Press any key to close..."
