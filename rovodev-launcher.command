#!/bin/bash
# ============================================================================
#  Rovo Dev Launcher
#  Double-click to install & launch Rovo Dev TUI — no admin rights needed.
#  For Atlassian employees on macOS.
# ============================================================================
set -euo pipefail

# --- Ctrl+C handler ---
cleanup() {
    echo ""
    echo -e "\n  ${RED}${BOLD}Installation cancelled.${NC}"
    echo -e "  ${DIM}You can re-run the launcher anytime to pick up where you left off.${NC}"
    echo ""
    exit 130
}
trap cleanup INT

# --- Elapsed time ---
START_TIME=$(date +%s)

# --- Config ---
ROVODEV_HOME="$HOME/rovodev"
ROVODEV_BIN="$ROVODEV_HOME/bin"
ROVODEV_WORKSPACE="$ROVODEV_HOME/workspace"
ROVODEV_ASSETS="$ROVODEV_HOME/assets"
ROVODEV_SKILLS="$HOME/.rovodev/skills"
ACLI_BIN="$ROVODEV_BIN/acli"
ATLASSIAN_SITE="hello.atlassian.net"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m' # No Color

# --- Terminal setup ---
echo -ne "\033]0;PMM AI School\007"
printf '\e[8;28;85t'

# --- Helper functions ---
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
info() { echo -e "  ${BLUE}→${NC} $1"; }
step() {
    local current="${1%%/*}"
    local total="${1##*/}"
    local filled=$((current * 20 / total))
    local empty=$((20 - filled))
    local bar=""
    local i
    for ((i=0; i<filled; i++)); do bar="${bar}█"; done
    for ((i=0; i<empty; i++)); do bar="${bar}░"; done
    echo -e "\n  ${DIM}${bar} ${current}/${total}${NC}"
    echo -e "  ${BOLD}${PURPLE}$2${NC}"
}

# --- Banner ---
clear
echo ""
echo -e "${PURPLE}${BOLD}"
cat << 'BANNER'
 ____  __  __ __  __      _    ___   ____       _                 _
|  _ \|  \/  |  \/  |    / \  |_ _| / ___|  ___| |__   ___   ___ | |
| |_) | |\/| | |\/| |   / _ \  | |  \___ \ / __| '_ \ / _ \ / _ \| |
|  __/| |  | | |  | |  / ___ \ | |   ___) | (__| | | | (_) | (_) | |
|_|   |_|  |_|_|  |_| /_/   \_\___| |____/ \___|_| |_|\___/ \___/|_|

BANNER
echo -e "${NC}"
echo -e "${DIM}  Zero-admin installer & launcher for Atlassian employees${NC}"
echo -e "${DIM}  Site: ${ATLASSIAN_SITE}${NC}"
echo ""
echo -e "${DIM}  ─────────────────────────────────────────────────────${NC}"
echo ""
echo -e "${DIM}  Mmes ${BOLD}Adrienn${NC}${DIM}, ${BOLD}Daniella${NC}${DIM}, ${BOLD}Himja${NC}${DIM}, ${BOLD}Hosana${NC}${DIM}, and ${BOLD}Monica${NC}${DIM},${NC}"
echo -e "${DIM}  and Messrs ${BOLD}Andrew${NC}${DIM} and ${BOLD}Sid${NC}"
echo ""
echo -e "${DIM}  of the ${PURPLE}${BOLD}PMM AI School${NC}${DIM} team bring to you${NC}"
echo -e "${DIM}  the magic of ${CYAN}${BOLD}Rovo Dev TUI${NC}${DIM} without the mess of reading the docs.${NC}"
echo ""
echo -e "${YELLOW}  ⚠  /yolo mode can be dangerous, so act with caution${NC}"
echo ""
echo -e "${DIM}  ─────────────────────────────────────────────────────${NC}"
echo ""

# --- Magic passphrase gate ---
echo -e "  Type \"${BOLD}alohomora${NC}\" to continue:"
echo ""
while true; do
    read -p "  🪄 " SPELL
    if [ "$(echo "$SPELL" | tr '[:upper:]' '[:lower:]')" = "alohomora" ]; then
        echo ""
        echo -e "  ${GREEN}${BOLD}✨ The map reveals itself...${NC}"
        sleep 1
        break
    else
        echo -e "  ${RED}  That spell doesn't work here. Try again.${NC}"
    fi
done

# ============================================================================
# PHASE 1: Detect architecture
# ============================================================================
step "1/10" "Detecting system"

ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
    ACLI_ARCH="acli_darwin_arm64"
    ok "Apple Silicon (arm64) detected"
elif [ "$ARCH" = "x86_64" ]; then
    ACLI_ARCH="acli_darwin_amd64"
    ok "Intel (x86_64) detected"
else
    fail "Unsupported architecture: $ARCH"
    echo -e "  ${DIM}This launcher supports macOS only (Apple Silicon or Intel).${NC}"
    read -n 1 -s -r -p "  Press any key to exit..."
    exit 1
fi

OS=$(sw_vers -productVersion 2>/dev/null || echo "unknown")
ok "macOS $OS"

# ============================================================================
# PHASE 2: Create folder structure
# ============================================================================
step "2/10" "Setting up folders"

for dir in "$ROVODEV_BIN" "$ROVODEV_WORKSPACE" "$ROVODEV_ASSETS" "$ROVODEV_SKILLS"; do
    if [ ! -d "$dir" ]; then
        mkdir -p "$dir"
        ok "Created $dir"
    else
        ok "Exists: $dir"
    fi
done

# ============================================================================
# PHASE 3: Install acli binary
# ============================================================================
step "3/10" "Installing Atlassian CLI"

DOWNLOAD_URL="https://acli.atlassian.com/darwin/latest/${ACLI_ARCH}/acli"

if [ -f "$ACLI_BIN" ]; then
    CURRENT_VERSION=$("$ACLI_BIN" --version 2>/dev/null || echo "unknown")
    ok "acli already installed (${CURRENT_VERSION})"

    # Check for updates
    info "Checking for updates..."
    TEMP_ACLI=$(mktemp)
    if curl -fsSL --connect-timeout 10 -o "$TEMP_ACLI" "$DOWNLOAD_URL" 2>/dev/null; then
        chmod +x "$TEMP_ACLI"
        NEW_VERSION=$("$TEMP_ACLI" --version 2>/dev/null || echo "unknown")
        if [ "$NEW_VERSION" != "$CURRENT_VERSION" ] && [ "$NEW_VERSION" != "unknown" ]; then
            echo ""
            echo -e "  ${YELLOW}New version available: ${NEW_VERSION} (current: ${CURRENT_VERSION})${NC}"
            read -p "  Update now? [Y/n] " -n 1 -r REPLY
            echo ""
            if [[ ! $REPLY =~ ^[Nn]$ ]]; then
                mv "$TEMP_ACLI" "$ACLI_BIN"
                ok "Updated to ${NEW_VERSION}"
            else
                rm -f "$TEMP_ACLI"
                info "Skipped update"
            fi
        else
            ok "Already up to date"
            rm -f "$TEMP_ACLI"
        fi
    else
        warn "Could not check for updates (network issue?)"
        rm -f "$TEMP_ACLI"
    fi
else
    info "Downloading acli (${ACLI_ARCH})..."
    if curl -fsSL --connect-timeout 30 --progress-bar -o "$ACLI_BIN" "$DOWNLOAD_URL"; then
        chmod +x "$ACLI_BIN"
        VERSION=$("$ACLI_BIN" --version 2>/dev/null || echo "unknown")
        ok "Installed acli ${VERSION}"
    else
        fail "Download failed. Check your network connection."
        read -n 1 -s -r -p "  Press any key to exit..."
        exit 1
    fi
fi

# Add to PATH for this session
export PATH="$ROVODEV_BIN:$PATH"

# ============================================================================
# PHASE 4: Authentication
# ============================================================================
step "4/10" "Checking authentication"

if "$ACLI_BIN" rovodev auth status &>/dev/null; then
    ok "Authenticated with Atlassian"
else
    warn "Not authenticated yet"
    info "Opening browser for login..."
    echo ""
    echo -e "  ${DIM}Your browser will open. Sign in with your Atlassian account.${NC}"
    echo -e "  ${DIM}After approving, return to this window.${NC}"
    echo ""
    "$ACLI_BIN" rovodev auth login
    if "$ACLI_BIN" rovodev auth status &>/dev/null; then
        ok "Authentication successful!"
    else
        warn "Authentication may not have completed."
        info "You can re-authenticate later with: acli rovodev auth login"
    fi
fi

# ============================================================================
# PHASE 5: Install Rovo logo
# ============================================================================
step "5/10" "Setting up assets"

LOGO_PATH="$ROVODEV_ASSETS/rovo-logo.png"
if [ ! -f "$LOGO_PATH" ]; then
    echo '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' | base64 -d > "$LOGO_PATH"
    ok "Rovo logo installed"
else
    ok "Rovo logo exists"
fi

# ============================================================================
# PHASE 6: Seed workspace AGENTS.md
# ============================================================================
step "6/10" "Configuring workspace"

AGENTS_FILE="$ROVODEV_WORKSPACE/AGENTS.md"
if [ ! -f "$AGENTS_FILE" ]; then
    cat > "$AGENTS_FILE" << 'AGENTS_EOF'
# Rovo Dev Workspace — Universal Guidelines

## Identity
- You are Rovo Dev, an AI coding and productivity agent for Atlassian employees.
- Primary Atlassian site: hello.atlassian.net
- Design system reference: https://atlassian.design

## Absolute Rules

### Workspace Boundary — CRITICAL
- You are running inside ~/rovodev/workspace/. This is your sandbox.
- NEVER read, write, modify, or delete files outside of ~/rovodev/workspace/.
- NEVER use commands that affect the broader filesystem (e.g., no \`rm -rf /\`, no \`sudo\`, no writing to /tmp, ~/Desktop, ~/Documents, or any path outside your workspace).
- If a task requires files outside the workspace, ASK the user to copy them in first.
- All temporary files must be created inside the workspace and cleaned up after use.

### No Emojis — Ever
- NEVER use emoji characters in any output: documents, code comments, Confluence pages, commit messages, or conversation.
- When icons are needed, use inline SVGs (stroke-based, 14x14, `currentColor`, `stroke-width:2`, `stroke-linecap:round`, `stroke-linejoin:round`).
- Theme toggle icons (sun/moon) are commonly missed because they live in JavaScript strings, not HTML — check those too.
- If replacing emojis in existing content, use a comprehensive Python regex covering all Unicode emoji ranges including variation selectors (`\uFE0F`).

### Professional Visual Standards
- Fonts: Use system fonts or standard web fonts (Bricolage Grotesque for sans, Newsreader for serif/italic, JetBrains Mono for mono when building Atlassian content).
- Colors: Follow Atlassian Design System tokens. Key accent palette: Blue (#5B8DEF), Teal (#2DD4BF), Purple (#A78BFA), Amber (#FBBF24), Rose (#FB7185).
- All icons must be inline SVGs — no emoji, no icon fonts without explicit approval.

## macOS Shell Compatibility
- `head -n -N` (negative line count) does NOT work on macOS. Use Python or `sed` for tail-trimming files.
- `grep -P` (Perl regex) is NOT available on macOS. Use Python for Unicode/emoji pattern matching.
- `sed -i` requires `sed -i ''` on macOS (empty string backup extension).

## Large File Creation Strategy
- The `create_file` tool can fail silently on very large content. Use `bash` with heredocs (`cat > file << 'EOF'`) to write large files, splitting into multiple appends if needed.
- When building large HTML files iteratively, insert content before a known marker using `sed` or Python file splicing, rather than appending to the end.
- Always validate HTML structure after insertions using Python's `html.parser.HTMLParser`.

## CSS Best Practices
- Elements with `max-width` do NOT auto-center — they need `margin-left: auto; margin-right: auto` explicitly.
- `text-align: center` only centers inline content within a full-width block, not the block itself.
- For text headings that wrap shorter than their container, use `width: fit-content; margin-left: auto; margin-right: auto`.
- Dark-first design systems need explicit light mode overrides for pills, badges, and labels. Dark-mode pastel text (e.g., `#7CA8FF`) becomes unreadable on white backgrounds.
- Light mode pill pattern: 10% opacity background + dark text (e.g., `rgba(12,102,228,0.10)` bg + `#0055CC` text).

## Confluence Tips
- Use `text ~ "term"` for full-text search, `creator ~ "name"` for author search in CQL.
- Search by person name in text (`text ~ "Firstname Lastname"`) is more reliable than `creator` field matching.
- When creating Confluence pages, produce full, well-structured pages with real hierarchy and depth — not skeleton drafts.

## Playwright Verification (when testing HTML output)
- Install: `npm install playwright && npx playwright install chromium`
- Always prefix temp files with `tmp_rovodev_` and clean up after.
- Key checks: dimensions, horizontal centering (check actual elements, not containers), color accuracy, content counts.
- Playwright `.textContent` returns empty for SVG elements — use attribute checks instead.

## Context / Intelligence / Action Framework
When building Rovo-related content, map steps to three pillars:
- **Context** (blue) — gathering data, scanning, querying
- **Intelligence** (teal) — reasoning, analysis, routing, classifying
- **Action** (purple) — executing, deploying, creating, delivering

## Resources
- Atlassian Design System: https://atlassian.design
- Rovo logo: ~/rovodev/assets/rovo-logo.png
- Skills source: https://bitbucket.org/atlassian/skills
AGENTS_EOF
    ok "Created workspace AGENTS.md with universal guidelines"
else
    ok "Workspace AGENTS.md already exists"
fi

# ============================================================================
# PHASE 7: Git-init workspace (safety net)
# ============================================================================
step "7/10" "Setting up version control"

if command -v git &>/dev/null; then
    if [ ! -d "$ROVODEV_WORKSPACE/.git" ]; then
        cd "$ROVODEV_WORKSPACE"
        git init -q
        git add -A
        git commit -q -m "Initial workspace setup by Rovo Dev Launcher" --allow-empty
        cd - >/dev/null
        ok "Git repository initialized in workspace"
        info "Safety net: if anything goes wrong, run 'git checkout .' inside ~/rovodev/workspace/"
    else
        # Workspace already has git — check if there are uncommitted changes from a previous session
        cd "$ROVODEV_WORKSPACE"
        if git diff --quiet --exit-code 2>/dev/null && git diff --cached --quiet --exit-code 2>/dev/null; then
            ok "Git repo exists — workspace is clean"
        else
            CHANGED=$(cd "$ROVODEV_WORKSPACE" && git status --short | wc -l | tr -d ' ')
            ok "Git repo exists — ${CHANGED} file(s) changed since last commit"
            info "Review changes anytime with: cd ~/rovodev/workspace && git diff"
        fi
        cd - >/dev/null
    fi
else
    warn "Git not found — skipping version control setup"
    info "Git provides an undo safety net for your workspace."
    info "To install git, your Mac will prompt you next time a tool needs it,"
    info "or you can run: xcode-select --install"
fi

# ============================================================================
# PHASE 8: Install skills
# ============================================================================
step "8/10" "Installing skills"

# --- Skill: getting-started ---
SKILL_DIR="$ROVODEV_SKILLS/getting-started"
if [ ! -f "$SKILL_DIR/SKILL.md" ]; then
    mkdir -p "$SKILL_DIR"
    cat > "$SKILL_DIR/SKILL.md" << 'SKILL1_EOF'
---
name: getting-started
description: "General-purpose Atlassian employee assistant. Handles Confluence page creation, Jira workflow, research synthesis, document drafting, and internal knowledge discovery on hello.atlassian.net."
---

# Getting Started Skill

## Role
You are a productivity partner for an Atlassian employee working on hello.atlassian.net. You help with content creation, research, analysis, and workflow automation across the Atlassian suite.

## Key Behaviors
- Write for humans, not algorithms. Be clear, direct, and structured.
- Use Atlassian Design System conventions for any visual output.
- NEVER use emoji characters. Use inline SVG icons when visual markers are needed.
- When creating Confluence pages, produce complete, well-structured content with real depth — not skeleton drafts.
- When searching Confluence, use CQL with `text ~ "term"` for full-text search.
- Default site: hello.atlassian.net

## Available Integrations
- Confluence: Read, create, update pages. Search with CQL.
- Jira: Read, create, update issues. Search with JQL.
- Bitbucket: Read repos, PRs, diffs.
- Teamwork Graph: Discover people, teams, projects, collaboration patterns.
- Slack: Read channels and messages.

## Output Standards
- All documents: No emojis. Professional tone. Clear hierarchy with H1/H2/H3.
- Tables: Use for structured comparisons. Always include headers.
- Code blocks: Use fenced code blocks with language tags.
- Lists: Prefer bullet lists for scanning. Numbered lists for sequences.
SKILL1_EOF
    ok "Installed skill: getting-started"
else
    ok "Skill exists: getting-started"
fi

# --- Skill: pdf-research ---
SKILL_DIR="$ROVODEV_SKILLS/pdf-research"
if [ ! -f "$SKILL_DIR/SKILL.md" ]; then
    mkdir -p "$SKILL_DIR"
    cat > "$SKILL_DIR/SKILL.md" << 'SKILL2_EOF'
---
name: pdf-research
description: "Deep research skill for reading PDFs, synthesizing knowledge bases, building technical differentiation reports, and conducting multi-source analysis across Confluence, PDFs, and web sources."
---

# PDF Research & Knowledge Synthesis Skill

## Role
You are a research analyst that reads PDFs, Confluence pages, and other sources to build structured knowledge bases, differentiation reports, and executive summaries.

## Capabilities
1. **PDF Analysis**: Read and extract structured content from PDF documents.
2. **Knowledge Base Building**: Create comprehensive knowledge bases with concept inventories, relationship maps, and scoring matrices.
3. **Multi-Source Synthesis**: Cross-reference findings across Confluence pages, PDFs, and conversation context.
4. **Differentiation Analysis**: Score concepts on uniqueness, defensibility, and strategic value.
5. **Executive Reporting**: Produce role-targeted summaries (PM, Engineering, Sales, Executive).

## Methodology
- Start with source enumeration: list all inputs before analysis.
- Build a concept inventory: extract every distinct technical concept.
- Score and rank: use consistent rubrics (e.g., 0-10 for uniqueness, depth, defensibility).
- Prune parity: identify table-stakes concepts and separate them from true differentiators.
- Cross-reference: verify claims across multiple sources before including.

## Output Format
- **INDEX.md**: Navigation guide with role-based reading paths.
- **MASTER_KNOWLEDGE_BASE.md**: Full knowledge base with all concepts, rankings, and relationship maps.
- **TECHNICAL_DIFFERENTIATION_REPORT.md**: Curated differentiators with scoring and attribution.
- **CONCEPT_INVENTORY.md**: Alphabetical listing of all concepts found.
- **AGGREGATION_SUMMARY.md**: Methodology documentation.

## Quality Rules
- NEVER use emoji characters in any output.
- Always include source attribution (Confluence URL, PDF page, expert name).
- Include confidence levels and limitations section.
- Use tables for structured comparisons, not prose.
SKILL2_EOF
    ok "Installed skill: pdf-research"
else
    ok "Skill exists: pdf-research"
fi

# --- Skill: presentation-builder ---
SKILL_DIR="$ROVODEV_SKILLS/presentation-builder"
if [ ! -f "$SKILL_DIR/SKILL.md" ]; then
    mkdir -p "$SKILL_DIR"
    cat > "$SKILL_DIR/SKILL.md" << 'SKILL3_EOF'
---
name: presentation-builder
description: "Build polished static HTML presentations, social media cards, and interactive visualizations with dark/light mode, SVG icons, snap-scroll, and Playwright-verified layouts."
---

# Presentation Builder Skill

## Role
You build pixel-perfect static HTML presentations, landing pages, social media cards, and interactive visualizations. You produce standalone files with no build step and no framework dependencies.

## Design System
- **Fonts**: Bricolage Grotesque (sans), Newsreader (serif/italic), JetBrains Mono (mono)
- **Colors**: Blue (#5B8DEF), Teal (#2DD4BF), Purple (#A78BFA), Amber (#FBBF24), Rose (#FB7185)
- **Icons**: Inline SVGs only (stroke-based, 14x14, `currentColor`, `stroke-width:2`, `stroke-linecap:round`, `stroke-linejoin:round`). NEVER use emojis.
- **Modes**: Dark-first design with light mode via `html.light` class. Always include light mode overrides.
- **Reference**: https://atlassian.design for tokens and components.

## Visual Formats
1. **Three-lane trace**: Horizontal swimlane diagrams
2. **Pipeline**: Linear flow with nodes and connectors
3. **RAG 3-stage**: Retrieve/Augment/Generate with phase badges
4. **Sequence diagram**: Actor-message interaction flows
5. **Timeline**: Chronological event visualization

## Build Patterns
- All files standalone static HTML — no build step, no framework.
- Prefer handcrafted CSS over frameworks. Inline styles for one-off elements, shared CSS files for reuse.
- Use `scroll-snap-type: y mandatory` for full-screen presentations.
- Large files: use bash heredocs (`cat > file << 'EOF'`), split into multiple appends if needed.
- Always validate HTML after insertions with Python HTMLParser.

## Light Mode Checklist
- Override dark-mode pastel text colors for white backgrounds.
- Pill pattern: 10% opacity background + dark text.
- Use CSS attribute selectors for inline-styled elements.
- Test both modes in Playwright.

## CSS Gotchas
- `max-width` does NOT auto-center. Always add `margin-left: auto; margin-right: auto`.
- For text centering: `width: fit-content; margin: 0 auto`.
- `text-align: center` only centers inline content, not blocks.

## Verification
- Use Playwright with chromium for automated checks.
- Verify: dimensions, centering (actual elements, not containers), color accuracy, content counts.
- Always clean up: `rm -f tmp_rovodev_*`
- Playwright `.textContent` returns empty for SVGs — use attribute checks.

## Social Media Card Specs
- LinkedIn: 1200x630px
- Include tech pills (color-coded by phase), legend, brand URL.
- Headlines: influencer-grade hooks, not technical titles. Bold key numbers.
SKILL3_EOF
    ok "Installed skill: presentation-builder"
else
    ok "Skill exists: presentation-builder"
fi



# ============================================================================
# PHASE 9: Create Desktop shortcut
# ============================================================================
step "9/10" "Creating Desktop shortcut"

DESKTOP_APP="$HOME/Desktop/Rovo Dev.app"
if [ -d "$DESKTOP_APP" ]; then
    ok "Desktop shortcut already exists"
else
    info "Building Rovo Dev.app for Desktop..."

    # --- Create .app bundle structure ---
    APP_CONTENTS="$DESKTOP_APP/Contents"
    APP_MACOS="$APP_CONTENTS/MacOS"
    APP_RESOURCES="$APP_CONTENTS/Resources"
    mkdir -p "$APP_MACOS" "$APP_RESOURCES"

    # --- Create the launcher script ---
    cat > "$APP_MACOS/launch" << 'LAUNCHER_EOF'
#!/bin/bash
# Rovo Dev Desktop Shortcut — opens Terminal and launches TUI
ROVODEV_BIN="$HOME/rovodev/bin"
ROVODEV_WORKSPACE="$HOME/rovodev/workspace"

if [ ! -f "$ROVODEV_BIN/acli" ]; then
    osascript -e 'display alert "Rovo Dev Not Installed" message "Please run the Rovo Dev Launcher first to install." as warning'
    exit 1
fi

osascript << EOF
tell application "Terminal"
    activate
    do script "cd '$ROVODEV_WORKSPACE' && '$ROVODEV_BIN/acli' rovodev tui"
end tell
EOF
LAUNCHER_EOF
    chmod +x "$APP_MACOS/launch"

    # --- Create Info.plist ---
    cat > "$APP_CONTENTS/Info.plist" << 'PLIST_EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>Rovo Dev</string>
    <key>CFBundleDisplayName</key>
    <string>Rovo Dev</string>
    <key>CFBundleIdentifier</key>
    <string>com.atlassian.rovodev.shortcut</string>
    <key>CFBundleVersion</key>
    <string>1.0</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleExecutable</key>
    <string>launch</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>LSUIElement</key>
    <true/>
</dict>
</plist>
PLIST_EOF

    # --- Convert rovo-logo.png to .icns ---
    ICONSET_DIR=$(mktemp -d)/AppIcon.iconset
    mkdir -p "$ICONSET_DIR"

    # Generate all required icon sizes from the source PNG
    for size in 16 32 64 128 256 512; do
        sips -z $size $size "$LOGO_PATH" --out "$ICONSET_DIR/icon_${size}x${size}.png" &>/dev/null
    done
    for size in 16 32 128 256 512; do
        double=$((size * 2))
        sips -z $double $double "$LOGO_PATH" --out "$ICONSET_DIR/icon_${size}x${size}@2x.png" &>/dev/null
    done

    if iconutil -c icns "$ICONSET_DIR" -o "$APP_RESOURCES/AppIcon.icns" 2>/dev/null; then
        ok "Created Desktop shortcut with Rovo icon"
    else
        # Fallback: copy PNG directly (icon may not display perfectly)
        cp "$LOGO_PATH" "$APP_RESOURCES/AppIcon.png"
        warn "Created Desktop shortcut (icon conversion failed — using PNG fallback)"
    fi

    # Clean up temp iconset
    rm -rf "$(dirname "$ICONSET_DIR")"

    # Force macOS to register the new .app
    touch "$DESKTOP_APP"

    info "Double-click 'Rovo Dev' on your Desktop to launch the TUI"
fi

# --- Add to Dock (if not already there) ---
DOCK_APP_PATH="$DESKTOP_APP"
if defaults read com.apple.dock persistent-apps 2>/dev/null | grep -q "com.atlassian.rovodev.shortcut"; then
    ok "Already pinned to Dock"
else
    # Add the .app to the end of the Dock's persistent-apps array
    defaults write com.apple.dock persistent-apps -array-add \
        "<dict>
            <key>tile-data</key>
            <dict>
                <key>file-data</key>
                <dict>
                    <key>_CFURLString</key>
                    <string>file://${DOCK_APP_PATH// /%20}/</string>
                    <key>_CFURLStringType</key>
                    <integer>15</integer>
                </dict>
                <key>file-label</key>
                <string>Rovo Dev</string>
                <key>bundle-identifier</key>
                <string>com.atlassian.rovodev.shortcut</string>
            </dict>
            <key>tile-type</key>
            <string>file-tile</string>
        </dict>"
    # Restart the Dock to pick up changes
    killall Dock 2>/dev/null || true
    ok "Pinned Rovo Dev to Dock"
fi

# ============================================================================
# PHASE 10: Launch TUI
# ============================================================================
step "10/10" "Launching Rovo Dev TUI"

ELAPSED=$(( $(date +%s) - START_TIME ))
MINS=$((ELAPSED / 60))
SECS=$((ELAPSED % 60))

echo ""
echo -e "${DIM}  ─────────────────────────────────────────────────────${NC}"
echo ""
echo -e "  ${GREEN}${BOLD}Ready!${NC} Launching Rovo Dev TUI..."
echo -e "  ${DIM}Working directory: $ROVODEV_WORKSPACE${NC}"
echo -e "  ${DIM}Skills installed: $(ls "$ROVODEV_SKILLS" 2>/dev/null | wc -l | tr -d ' ') skill(s) in ~/.rovodev/skills/${NC}"
if [ $MINS -gt 0 ]; then
    echo -e "  ${DIM}Setup completed in ${MINS}m ${SECS}s${NC}"
else
    echo -e "  ${DIM}Setup completed in ${SECS}s${NC}"
fi
echo ""
echo -e "  ${DIM}Tips:${NC}"
echo -e "  ${DIM}  /models    — switch LLM model${NC}"
echo -e "  ${DIM}  /skills    — list loaded skills${NC}"
echo -e "  ${DIM}  /sessions  — manage sessions${NC}"
echo -e "  ${DIM}  /clear     — reset context${NC}"
echo ""
echo -e "  ${DIM}Next time:${NC}"
echo -e "  ${DIM}  Click ${BOLD}Rovo Dev${NC}${DIM} in your Dock or on your Desktop to jump straight in.${NC}"
echo ""
echo -e "${DIM}  ─────────────────────────────────────────────────────${NC}"
echo ""

cd "$ROVODEV_WORKSPACE"
exec "$ACLI_BIN" rovodev tui
