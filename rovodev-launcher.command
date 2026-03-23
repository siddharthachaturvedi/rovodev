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
    stop_background_server
    exit 130
}
stop_background_server() {
    if [ -n "${SERVE_PID:-}" ] && kill -0 "${SERVE_PID}" 2>/dev/null; then
        kill "${SERVE_PID}" 2>/dev/null || true
    fi
}
trap cleanup INT
trap stop_background_server EXIT

# --- Elapsed time ---
START_TIME=$(date +%s)

# --- Config ---
ROVODEV_HOME="$HOME/rovodev"
ROVODEV_BIN="$ROVODEV_HOME/bin"
ROVODEV_WORKSPACE="$ROVODEV_HOME/workspace"
ROVODEV_ASSETS="$ROVODEV_HOME/assets"
ROVODEV_SKILLS="$HOME/.rovodev/skills"
ROVODEV_GUI_TOKEN_FILE="$ROVODEV_HOME/gui-api-token"
ACLI_BIN="$ROVODEV_BIN/acli"
ATLASSIAN_SITE="hello.atlassian.net"
ATLASSIAN_SITE_URL="https://${ATLASSIAN_SITE}"
DEFAULT_SERVE_PORT="8123"
DEFAULT_GUI_PORT="3210"
GUI_COMING_SOON=true
EXPERIENCE="terminal"
API_PORT="$DEFAULT_SERVE_PORT"
GUI_PORT="$DEFAULT_GUI_PORT"
SERVE_PID=""
ROVODEV_GUI_DIR="$ROVODEV_HOME/gui"
ROVODEV_RELEASE_REF="${ROVODEV_RELEASE_REF:-main}"

# --- Runtime options ---
RUN_MODE="tui"
SERVE_PORT="$DEFAULT_SERVE_PORT"
CREATE_SHORTCUT=true
PIN_DOCK=true
NON_INTERACTIVE=false
AUTH_STATUS="unknown"
SKIPPED_STEPS=()

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

# --- Helper functions ---
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
info() { echo -e "  ${BLUE}→${NC} $1"; }
usage() {
    cat << 'USAGE_EOF'
Usage: rovodev-launcher.command [options]

Options:
  --experience <terminal|gui> Install/launch experience (default: terminal)
  --mode <tui|serve>      Launch mode (default: tui)
  --port <number>         Port for --mode serve (default: 8123)
  --api-port <number>     API port for GUI mode (default: 8123)
  --gui-port <number>     GUI web port (default: 3210)
  --no-shortcut           Skip creating Desktop app shortcut
  --no-dock               Skip Dock pinning
  --non-interactive       Skip prompts and run with safe defaults
  -h, --help              Show this help
USAGE_EOF
}
pause_if_interactive() {
    if [ "$NON_INTERACTIVE" != true ] && [ -t 0 ]; then
        read -n 1 -s -r -p "  Press any key to exit..."
    fi
}
record_skip() {
    SKIPPED_STEPS+=("$1")
}
ensure_gui_token_file() {
    if [ "$EXPERIENCE" != "gui" ]; then
        return
    fi

    mkdir -p "$ROVODEV_HOME"

    if [ -n "${ROVODEV_API_BEARER_TOKEN:-}" ]; then
        printf "%s" "$ROVODEV_API_BEARER_TOKEN" > "$ROVODEV_GUI_TOKEN_FILE"
        chmod 600 "$ROVODEV_GUI_TOKEN_FILE"
        ok "Stored GUI API token from environment"
        return
    fi

    if [ -s "$ROVODEV_GUI_TOKEN_FILE" ]; then
        ok "Using existing GUI API token"
        return
    fi

    if [ "$NON_INTERACTIVE" = true ]; then
        warn "GUI API token not provided in non-interactive mode."
        info "Set ROVODEV_API_BEARER_TOKEN when launching installer to fully automate GUI API access."
        record_skip "GUI API token setup"
        return
    fi

    echo ""
    echo -e "  ${DIM}Enter your Rovo Dev API token for GUI server access.${NC}"
    echo -e "  ${DIM}Input is hidden. Stored locally at ${ROVODEV_GUI_TOKEN_FILE}.${NC}"
    read -r -s -p "  Token: " GUI_TOKEN_INPUT
    echo ""
    if [ -n "$GUI_TOKEN_INPUT" ]; then
        printf "%s" "$GUI_TOKEN_INPUT" > "$ROVODEV_GUI_TOKEN_FILE"
        chmod 600 "$ROVODEV_GUI_TOKEN_FILE"
        ok "Stored GUI API token"
    else
        warn "No token entered; GUI API calls may fail until token is configured."
        record_skip "GUI API token setup"
    fi
}
require_cmd() {
    local cmd="$1"
    local purpose="$2"
    if ! command -v "$cmd" >/dev/null 2>&1; then
        fail "Missing required command: $cmd (${purpose})"
        echo -e "  ${DIM}Install or enable '$cmd' and re-run this launcher.${NC}"
        pause_if_interactive
        exit 1
    fi
}
validate_serve_port() {
    local port_value="$1"
    local port_label="$2"
    if ! [[ "$port_value" =~ ^[0-9]+$ ]]; then
        fail "Invalid ${port_label} value: $port_value"
        echo -e "  ${DIM}Use a numeric non-privileged port (1024-65535).${NC}"
        exit 1
    fi
    if [ "$port_value" -lt 1024 ] || [ "$port_value" -gt 65535 ]; then
        fail "Port out of range for ${port_label}: $port_value"
        echo -e "  ${DIM}Use a non-privileged port between 1024 and 65535.${NC}"
        exit 1
    fi
}
is_port_in_use() {
    local port_value="$1"
    if ! command -v lsof >/dev/null 2>&1; then
        return 1
    fi
    lsof -nP -iTCP:"$port_value" -sTCP:LISTEN >/dev/null 2>&1
}
find_available_port() {
    local start_port="$1"
    local end_port="$2"
    local avoid_port="${3:-}"
    local candidate
    for ((candidate=start_port; candidate<=end_port; candidate++)); do
        if [ -n "$avoid_port" ] && [ "$candidate" = "$avoid_port" ]; then
            continue
        fi
        if ! is_port_in_use "$candidate"; then
            echo "$candidate"
            return 0
        fi
    done
    return 1
}
resolve_port_conflict() {
    local current_port="$1"
    local port_label="$2"
    local fallback_start="$3"
    local fallback_end="$4"
    local avoid_port="${5:-}"

    local suggested_port
    local option_hint="--port"
    if [ "$port_label" = "GUI port" ]; then
        option_hint="--gui-port"
    fi
    suggested_port="$(find_available_port "$fallback_start" "$fallback_end" "$avoid_port" || true)"
    if [ -z "$suggested_port" ]; then
        fail "$port_label $current_port is already in use, and no fallback ports were found in ${fallback_start}-${fallback_end}."
        echo -e "  ${DIM}Use a free port with ${option_hint} <number>.${NC}"
        exit 1
    fi

    echo -e "  ${YELLOW}⚠${NC} $port_label $current_port is already in use." >&2
    if [ "$NON_INTERACTIVE" = true ]; then
        echo -e "  ${BLUE}→${NC} Auto-selecting free fallback port: $suggested_port" >&2
        echo "$suggested_port"
        return 0
    fi

    read -r -p "  Use fallback port $suggested_port instead? [Y/n] " REPLY >&2
    if [[ "$REPLY" =~ ^[Nn]$ ]]; then
        fail "Port conflict not resolved."
        echo -e "  ${DIM}Rerun with an explicit free port.${NC}"
        exit 1
    fi
    echo "$suggested_port"
}
check_writable_parent() {
    local path="$1"
    local label="$2"
    if [ -e "$path" ]; then
        if [ ! -w "$path" ]; then
            fail "No write permission for $label: $path"
            echo -e "  ${DIM}Choose a user-writable location and re-run.${NC}"
            exit 1
        fi
    else
        local parent
        parent="$(dirname "$path")"
        if [ ! -d "$parent" ] || [ ! -w "$parent" ]; then
            fail "Cannot create $label at $path (parent not writable)"
            echo -e "  ${DIM}Check permissions for: $parent${NC}"
            exit 1
        fi
    fi
}
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

# --- Parse args ---
while [ $# -gt 0 ]; do
    case "$1" in
        --experience)
            shift
            if [ $# -eq 0 ]; then
                fail "--experience requires a value (terminal|gui)"
                usage
                exit 1
            fi
            EXPERIENCE="$1"
            ;;
        --mode)
            shift
            if [ $# -eq 0 ]; then
                fail "--mode requires a value (tui|serve)"
                usage
                exit 1
            fi
            RUN_MODE="$1"
            ;;
        --port)
            shift
            if [ $# -eq 0 ]; then
                fail "--port requires a numeric value"
                usage
                exit 1
            fi
            SERVE_PORT="$1"
            ;;
        --api-port)
            shift
            if [ $# -eq 0 ]; then
                fail "--api-port requires a numeric value"
                usage
                exit 1
            fi
            API_PORT="$1"
            ;;
        --gui-port)
            shift
            if [ $# -eq 0 ]; then
                fail "--gui-port requires a numeric value"
                usage
                exit 1
            fi
            GUI_PORT="$1"
            ;;
        --no-shortcut)
            CREATE_SHORTCUT=false
            ;;
        --no-dock)
            PIN_DOCK=false
            ;;
        --non-interactive)
            NON_INTERACTIVE=true
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            fail "Unknown argument: $1"
            usage
            exit 1
            ;;
    esac
    shift
done

if [ "$EXPERIENCE" != "terminal" ] && [ "$EXPERIENCE" != "gui" ]; then
    fail "Invalid --experience value: $EXPERIENCE"
    usage
    exit 1
fi

if [ "$RUN_MODE" != "tui" ] && [ "$RUN_MODE" != "serve" ]; then
    fail "Invalid --mode value: $RUN_MODE"
    usage
    exit 1
fi

if [ "$RUN_MODE" = "serve" ]; then
    validate_serve_port "$SERVE_PORT" "--port"
fi

if [ "$NON_INTERACTIVE" != true ] && [ ! -t 0 ]; then
    warn "No interactive terminal detected; enabling --non-interactive mode."
    NON_INTERACTIVE=true
fi

if [ "$EXPERIENCE" = "gui" ]; then
    if [ "$GUI_COMING_SOON" = true ]; then
        warn "GUI install (Option 2) is coming soon. Falling back to Terminal experience (Option 1)."
        EXPERIENCE="terminal"
        RUN_MODE="tui"
        record_skip "GUI install (coming soon)"
    else
        RUN_MODE="serve"
        SERVE_PORT="$API_PORT"
        validate_serve_port "$API_PORT" "--api-port"
        validate_serve_port "$GUI_PORT" "--gui-port"
        if [ "$API_PORT" = "$GUI_PORT" ]; then
            fail "API port and GUI port cannot be the same value."
            exit 1
        fi
        CREATE_SHORTCUT=false
        PIN_DOCK=false
    fi
fi

# --- Terminal setup ---
if [ -t 1 ] && [ -n "${TERM:-}" ]; then
    echo -ne "\033]0;PMM AI School\007"
    printf '\e[8;28;85t'
fi

# --- Banner ---
if [ -t 1 ] && [ -n "${TERM:-}" ]; then
    clear || true
fi
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

# --- Experience selector ---
if [ "$NON_INTERACTIVE" != true ] && [ "$EXPERIENCE" = "terminal" ]; then
    echo -e "  Choose experience:"
    echo -e "  ${DIM}1) Terminal (TUI)${NC}"
    echo -e "  ${DIM}2) GUI (Web app + Rovo server) ${YELLOW}[Coming Soon]${NC}"
    read -r -p "  Select [1/2] (default 1): " EXPERIENCE_CHOICE
    if [ "$EXPERIENCE_CHOICE" = "2" ]; then
        warn "Option 2 (GUI) is coming soon. Please choose Option 1 for now."
        EXPERIENCE="terminal"
        RUN_MODE="tui"
        record_skip "GUI install (coming soon)"
    fi
    echo ""
fi

# --- Magic passphrase gate ---
if [ "$NON_INTERACTIVE" = true ] || [ "${ROVODEV_SKIP_GATE:-0}" = "1" ]; then
    info "Skipping passphrase gate (--non-interactive or ROVODEV_SKIP_GATE=1)."
    record_skip "Passphrase gate"
else
    echo -e "  Type \"${BOLD}alohomora${NC}\" to continue:"
    echo ""
    while true; do
        read -r -p "  > " SPELL
        if [ "$(echo "$SPELL" | tr '[:upper:]' '[:lower:]')" = "alohomora" ]; then
            echo ""
            echo -e "  ${GREEN}${BOLD}The map reveals itself...${NC}"
            sleep 1
            break
        else
            echo -e "  ${RED}  That spell doesn't work here. Try again.${NC}"
        fi
    done
fi

# ============================================================================
# PHASE 1: Preflight and detect architecture
# ============================================================================
step "1/10" "Preflight checks and system detection"

require_cmd "curl" "download acli binary"
require_cmd "uname" "detect architecture"
require_cmd "sw_vers" "detect macOS version"
require_cmd "mkdir" "create install directories"
require_cmd "chmod" "make downloaded binaries executable"
require_cmd "mktemp" "safe temporary files"
require_cmd "base64" "install bundled Rovo logo"

check_writable_parent "$ROVODEV_HOME" "Rovo Dev home"
check_writable_parent "$HOME/.rovodev" "Rovo Dev config root"

if curl -fsSI --connect-timeout 10 "https://acli.atlassian.com" >/dev/null 2>&1; then
    ok "Network check passed (acli.atlassian.com reachable)"
else
    warn "Could not reach acli.atlassian.com (network/proxy restriction?)"
    record_skip "Network preflight warning"
fi

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
    pause_if_interactive
    exit 1
fi

OS=$(sw_vers -productVersion 2>/dev/null || echo "unknown")
ok "macOS $OS"

if [ "$RUN_MODE" = "serve" ]; then
    if command -v lsof >/dev/null 2>&1; then
        if is_port_in_use "$SERVE_PORT"; then
            SERVE_PORT="$(resolve_port_conflict "$SERVE_PORT" "Port" "$((SERVE_PORT + 1))" "$((SERVE_PORT + 25))")"
            if [ "$EXPERIENCE" = "gui" ]; then
                API_PORT="$SERVE_PORT"
            fi
        fi
        ok "Port $SERVE_PORT is available for server mode"
    else
        warn "lsof not found, cannot pre-check port availability."
        record_skip "Port availability pre-check"
    fi
fi

if [ "$EXPERIENCE" = "gui" ]; then
    require_cmd "npm" "run GUI web app"
    require_cmd "node" "run GUI web app runtime"
    if command -v lsof >/dev/null 2>&1; then
        if is_port_in_use "$GUI_PORT"; then
            GUI_PORT="$(resolve_port_conflict "$GUI_PORT" "GUI port" "$((GUI_PORT + 1))" "$((GUI_PORT + 25))" "$API_PORT")"
        fi
        ok "GUI port $GUI_PORT is available"
    fi
fi

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
            if [ "$NON_INTERACTIVE" = true ]; then
                mv "$TEMP_ACLI" "$ACLI_BIN"
                ok "Updated to ${NEW_VERSION}"
            else
                read -r -p "  Update now? [Y/n] " -n 1 REPLY
                echo ""
                if [[ ! $REPLY =~ ^[Nn]$ ]]; then
                    mv "$TEMP_ACLI" "$ACLI_BIN"
                    ok "Updated to ${NEW_VERSION}"
                else
                    rm -f "$TEMP_ACLI"
                    info "Skipped update"
                    record_skip "acli update"
                fi
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
    AUTH_STATUS="authenticated"
else
    warn "Not authenticated yet"
    if [ "$NON_INTERACTIVE" = true ]; then
        warn "Skipping interactive login in --non-interactive mode."
        info "Run manually: $ACLI_BIN rovodev auth login"
        AUTH_STATUS="not_authenticated"
        record_skip "Interactive auth login"
    else
        info "Opening browser for login..."
        echo ""
        echo -e "  ${DIM}Your browser will open. Sign in with your Atlassian account.${NC}"
        echo -e "  ${DIM}After approving, return to this window.${NC}"
        echo ""
        "$ACLI_BIN" rovodev auth login
        if "$ACLI_BIN" rovodev auth status &>/dev/null; then
            ok "Authentication successful!"
            AUTH_STATUS="authenticated"
        else
            warn "Authentication may not have completed."
            info "You can re-authenticate later with: acli rovodev auth login"
            AUTH_STATUS="not_authenticated"
        fi
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

if [ "$EXPERIENCE" = "gui" ]; then
    ensure_gui_token_file
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

# On a fresh Mac, /usr/bin/git exists as a shim that triggers the Xcode
# Command Line Tools install dialog instead of actually working. We test
# that git can execute a real command before relying on it.
GIT_AVAILABLE=false
if command -v git &>/dev/null && git --version &>/dev/null; then
    GIT_AVAILABLE=true
fi

if $GIT_AVAILABLE; then
    if [ ! -d "$ROVODEV_WORKSPACE/.git" ]; then
        cd "$ROVODEV_WORKSPACE"
        if git init -q 2>/dev/null && git add -A 2>/dev/null && git commit -q -m "Initial workspace setup by Rovo Dev Launcher" --allow-empty 2>/dev/null; then
            ok "Git repository initialized in workspace"
            info "Safety net: if anything goes wrong, run 'git checkout .' inside ~/rovodev/workspace/"
        else
            warn "Git init failed — skipping version control setup"
            info "Not a problem — version control is optional."
        fi
        cd - >/dev/null
    else
        # Workspace already has git — check if there are uncommitted changes from a previous session
        cd "$ROVODEV_WORKSPACE"
        if git diff --quiet --exit-code 2>/dev/null && git diff --cached --quiet --exit-code 2>/dev/null; then
            ok "Git repo exists — workspace is clean"
        else
            CHANGED=$(cd "$ROVODEV_WORKSPACE" && git status --short 2>/dev/null | wc -l | tr -d ' ')
            ok "Git repo exists — ${CHANGED} file(s) changed since last commit"
            info "Review changes anytime with: cd ~/rovodev/workspace && git diff"
        fi
        cd - >/dev/null
    fi
else
    warn "Git not found — skipping version control setup"
    info "Not a problem — version control is optional."
    info "To install later: xcode-select --install"
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
# PHASE 8.5: Install GUI app (optional)
# ============================================================================
if [ "$EXPERIENCE" = "gui" ]; then
    info "Preparing GUI app files..."
    SCRIPT_SOURCE_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)"
    if [ -d "$SCRIPT_SOURCE_DIR/gui" ]; then
        rm -rf "$ROVODEV_GUI_DIR"
        cp -R "$SCRIPT_SOURCE_DIR/gui" "$ROVODEV_GUI_DIR"
        ok "Installed GUI files from local repository"
    else
        require_cmd "unzip" "extract GUI app package"
        GUI_TMP_ZIP="$(mktemp)"
        GUI_TMP_DIR="$(mktemp -d)"
        if [ "$ROVODEV_RELEASE_REF" = "main" ] || [ "$ROVODEV_RELEASE_REF" = "master" ]; then
            GUI_ARCHIVE_URL="https://github.com/siddharthachaturvedi/rovodev/archive/refs/heads/${ROVODEV_RELEASE_REF}.zip"
            GUI_ARCHIVE_ROOT="rovodev-${ROVODEV_RELEASE_REF}"
        else
            GUI_ARCHIVE_URL="https://github.com/siddharthachaturvedi/rovodev/archive/refs/tags/${ROVODEV_RELEASE_REF}.zip"
            GUI_ARCHIVE_ROOT="rovodev-${ROVODEV_RELEASE_REF}"
        fi
        if curl -fsSL --connect-timeout 30 -o "$GUI_TMP_ZIP" "$GUI_ARCHIVE_URL"; then
            if unzip -q "$GUI_TMP_ZIP" -d "$GUI_TMP_DIR" && [ -d "$GUI_TMP_DIR/$GUI_ARCHIVE_ROOT/gui" ]; then
                rm -rf "$ROVODEV_GUI_DIR"
                cp -R "$GUI_TMP_DIR/$GUI_ARCHIVE_ROOT/gui" "$ROVODEV_GUI_DIR"
                ok "Installed GUI files from remote archive"
            else
                fail "Could not extract GUI app from downloaded archive."
                exit 1
            fi
        else
            fail "Could not download GUI app bundle."
            echo -e "  ${DIM}Check network and rerun, or run from a local clone containing /gui.${NC}"
            exit 1
        fi
        rm -f "$GUI_TMP_ZIP"
        rm -rf "$GUI_TMP_DIR"
    fi
fi

# ============================================================================
# PHASE 9: Create Desktop shortcut
# ============================================================================
step "9/10" "Optional Desktop and Dock setup"

DESKTOP_DIR="${ROVODEV_DESKTOP_DIR:-$HOME/Desktop}"
DESKTOP_APP="$DESKTOP_DIR/Rovo Dev.app"

if [ "$CREATE_SHORTCUT" = true ]; then
    if [ ! -d "$DESKTOP_DIR" ]; then
        warn "Desktop folder not found at $DESKTOP_DIR; skipping shortcut."
        record_skip "Desktop shortcut (desktop folder missing)"
    elif [ ! -w "$DESKTOP_DIR" ]; then
        warn "Desktop folder is not writable; skipping shortcut."
        record_skip "Desktop shortcut (desktop folder not writable)"
    elif ! command -v osascript >/dev/null 2>&1; then
        warn "osascript is unavailable; skipping Desktop shortcut."
        record_skip "Desktop shortcut (osascript unavailable)"
    elif [ -d "$DESKTOP_APP" ]; then
        ok "Desktop shortcut already exists"
    else
        info "Building Rovo Dev.app for Desktop..."

        APP_CONTENTS="$DESKTOP_APP/Contents"
        APP_MACOS="$APP_CONTENTS/MacOS"
        APP_RESOURCES="$APP_CONTENTS/Resources"
        mkdir -p "$APP_MACOS" "$APP_RESOURCES"

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

        if command -v sips >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
            ICONSET_DIR=$(mktemp -d)/AppIcon.iconset
            mkdir -p "$ICONSET_DIR"

            for size in 16 32 64 128 256 512; do
                sips -z "$size" "$size" "$LOGO_PATH" --out "$ICONSET_DIR/icon_${size}x${size}.png" &>/dev/null
            done
            for size in 16 32 128 256 512; do
                double=$((size * 2))
                sips -z "$double" "$double" "$LOGO_PATH" --out "$ICONSET_DIR/icon_${size}x${size}@2x.png" &>/dev/null
            done

            if iconutil -c icns "$ICONSET_DIR" -o "$APP_RESOURCES/AppIcon.icns" 2>/dev/null; then
                ok "Created Desktop shortcut with Rovo icon"
            else
                cp "$LOGO_PATH" "$APP_RESOURCES/AppIcon.png"
                warn "Created Desktop shortcut (icon conversion failed; PNG fallback used)"
                record_skip "Desktop shortcut icon conversion"
            fi

            rm -rf "$(dirname "$ICONSET_DIR")"
        else
            cp "$LOGO_PATH" "$APP_RESOURCES/AppIcon.png"
            warn "Created Desktop shortcut without icns icon (sips/iconutil unavailable)"
            record_skip "Desktop shortcut icon conversion tools"
        fi

        touch "$DESKTOP_APP"
        info "Double-click 'Rovo Dev' on your Desktop to launch the TUI"
    fi
else
    info "Skipping Desktop shortcut (--no-shortcut)."
    record_skip "Desktop shortcut (--no-shortcut)"
fi

if [ "$PIN_DOCK" = true ]; then
    if [ ! -d "$DESKTOP_APP" ]; then
        warn "Skipping Dock pin because Desktop app is unavailable."
        record_skip "Dock pin (shortcut not available)"
    elif ! command -v defaults >/dev/null 2>&1; then
        warn "defaults command not available; skipping Dock pin."
        record_skip "Dock pin (defaults unavailable)"
    elif defaults read com.apple.dock persistent-apps 2>/dev/null | grep -q "com.atlassian.rovodev.shortcut"; then
        ok "Already pinned to Dock"
    else
        DOCK_APP_PATH="$DESKTOP_APP"
        if defaults write com.apple.dock persistent-apps -array-add \
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
            </dict>"; then
            killall Dock 2>/dev/null || true
            ok "Pinned Rovo Dev to Dock"
        else
            warn "Could not pin app to Dock; continuing."
            record_skip "Dock pin (defaults write failed)"
        fi
    fi
else
    info "Skipping Dock pin (--no-dock)."
    record_skip "Dock pin (--no-dock)"
fi

# ============================================================================
# PHASE 10: Launch selected mode
# ============================================================================
step "10/10" "Launching Rovo Dev"

ELAPSED=$(( $(date +%s) - START_TIME ))
MINS=$((ELAPSED / 60))
SECS=$((ELAPSED % 60))

echo ""
echo -e "${DIM}  ─────────────────────────────────────────────────────${NC}"
echo ""
echo -e "  ${GREEN}${BOLD}Ready!${NC} Preparing to launch Rovo Dev (${RUN_MODE} mode, ${EXPERIENCE} experience)..."
echo -e "  ${DIM}Working directory: $ROVODEV_WORKSPACE${NC}"
echo -e "  ${DIM}Skills installed: $(ls "$ROVODEV_SKILLS" 2>/dev/null | wc -l | tr -d ' ') skill(s) in ~/.rovodev/skills/${NC}"
echo -e "  ${DIM}Auth status: ${AUTH_STATUS}${NC}"
if [ "$RUN_MODE" = "serve" ]; then
    echo -e "  ${DIM}Server/API port: ${SERVE_PORT}${NC}"
    echo -e "  ${DIM}Billing site: ${ATLASSIAN_SITE_URL}${NC}"
fi
if [ "$EXPERIENCE" = "gui" ]; then
    echo -e "  ${DIM}GUI web port: ${GUI_PORT}${NC}"
fi
if [ $MINS -gt 0 ]; then
    echo -e "  ${DIM}Setup completed in ${MINS}m ${SECS}s${NC}"
else
    echo -e "  ${DIM}Setup completed in ${SECS}s${NC}"
fi
echo ""

if [ "${#SKIPPED_STEPS[@]}" -gt 0 ]; then
    echo -e "  ${DIM}Optional steps skipped:${NC}"
    for item in "${SKIPPED_STEPS[@]}"; do
        echo -e "  ${DIM}  - ${item}${NC}"
    done
    echo ""
fi

if [ "$RUN_MODE" = "serve" ]; then
    echo -e "  ${DIM}Server mode tips:${NC}"
    echo -e "  ${DIM}  Local endpoint: http://127.0.0.1:${SERVE_PORT}${NC}"
    echo -e "  ${DIM}  Quick check: curl -sS http://127.0.0.1:${SERVE_PORT}/healthcheck${NC}"
else
    echo -e "  ${DIM}TUI tips:${NC}"
    echo -e "  ${DIM}  /models    — switch LLM model${NC}"
    echo -e "  ${DIM}  /skills    — list loaded skills${NC}"
    echo -e "  ${DIM}  /sessions  — manage sessions${NC}"
    echo -e "  ${DIM}  /clear     — reset context${NC}"
fi
echo ""
echo -e "  ${DIM}Next time:${NC}"
if [ "$EXPERIENCE" = "gui" ]; then
    echo -e "  ${DIM}  GUI URL: http://127.0.0.1:${GUI_PORT}${NC}"
elif [ -d "$DESKTOP_APP" ]; then
    echo -e "  ${DIM}  Click ${BOLD}Rovo Dev${NC}${DIM} in your Dock or on your Desktop to jump straight in.${NC}"
else
    if [ "$RUN_MODE" = "serve" ]; then
        echo -e "  ${DIM}  Launch from Terminal: cd ~/rovodev/workspace && ~/rovodev/bin/acli rovodev serve ${SERVE_PORT}${NC}"
    else
        echo -e "  ${DIM}  Launch from Terminal: cd ~/rovodev/workspace && ~/rovodev/bin/acli rovodev tui${NC}"
    fi
fi
echo ""
echo -e "${DIM}  ─────────────────────────────────────────────────────${NC}"
echo ""

cd "$ROVODEV_WORKSPACE"
if [ "$EXPERIENCE" = "gui" ]; then
    if [ "$AUTH_STATUS" != "authenticated" ]; then
        warn "GUI mode may fail until authenticated. Run: $ACLI_BIN rovodev auth login"
    fi
    info "Starting Rovo Dev server on port $SERVE_PORT..."
    "$ACLI_BIN" rovodev serve "$SERVE_PORT" --site-url "$ATLASSIAN_SITE_URL" --disable-session-token > "$ROVODEV_HOME/serve.log" 2>&1 &
    SERVE_PID="$!"
    sleep 2
    if ! kill -0 "$SERVE_PID" 2>/dev/null; then
        fail "Could not start Rovo Dev server. See $ROVODEV_HOME/serve.log"
        info "If credentials changed recently, run: $ACLI_BIN rovodev auth login"
        exit 1
    fi
    ok "Rovo Dev server is running (PID: $SERVE_PID)"
    if [ ! -d "$ROVODEV_GUI_DIR" ]; then
        fail "GUI app directory not found: $ROVODEV_GUI_DIR"
        exit 1
    fi
    cd "$ROVODEV_GUI_DIR"
    if [ ! -d "node_modules" ]; then
        info "Installing GUI dependencies..."
        npm install
    fi
    if command -v open >/dev/null 2>&1; then
        open "http://127.0.0.1:${GUI_PORT}" >/dev/null 2>&1 || true
    fi
    export ROVODEV_API_BASE="http://127.0.0.1:${SERVE_PORT}"
    if [ -s "$ROVODEV_GUI_TOKEN_FILE" ]; then
        export ROVODEV_API_BEARER_TOKEN
        ROVODEV_API_BEARER_TOKEN="$(cat "$ROVODEV_GUI_TOKEN_FILE")"
    fi
    info "Launching GUI at http://127.0.0.1:${GUI_PORT}"
    npm run dev -- --port "$GUI_PORT"
elif [ "$RUN_MODE" = "serve" ]; then
    if [ "$AUTH_STATUS" != "authenticated" ]; then
        warn "Server mode may fail until authenticated. Run: $ACLI_BIN rovodev auth login"
    fi
    exec "$ACLI_BIN" rovodev serve "$SERVE_PORT" --site-url "$ATLASSIAN_SITE_URL"
else
    exec "$ACLI_BIN" rovodev tui
fi
