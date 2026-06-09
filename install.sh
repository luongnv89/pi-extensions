#!/bin/bash

# Pi Extensions Installation Script
# Installs all extensions, skills, and themes to your Pi setup
#
# Usage:
#   Interactive (default):
#     curl -fsSL https://raw.githubusercontent.com/luongnv89/pi-extensions/main/install.sh | bash
#
#   Silent / automated:
#     curl -fsSL https://raw.githubusercontent.com/luongnv89/pi-extensions/main/install.sh | bash -s -- --auto
#
#   From cloned repo:
#     ~/.pi/pi-extensions/install.sh
#     ~/.pi/pi-extensions/install.sh --auto
#     ~/.pi/pi-extensions/install.sh --auto --keep      # keep the repo after install

set -e

# ─── Defaults ────────────────────────────────────────────────────────────────
GITHUB_REPO="https://github.com/luongnv89/pi-extensions"
REMOTE_BRANCH="main"

PI_EXTENSIONS="${HOME}/.pi/agent/extensions"
PI_THEMES="${HOME}/.pi/agent/themes"
PI_SKILLS="${HOME}/.pi/agent/skills"

MODE="interactive"     # or "auto", "from-clone", "dry-run"
KEEP_REPO=false         # or "true"

# Auto-detect: if run from within the repo, skip bootstrap entirely
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ "$SCRIPT_DIR" == "${HOME}/.pi/pi-extensions" ]]; then
    MODE="from-clone"
fi

# ─── Parse flags ─────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --auto)       MODE="auto"; shift ;;
        --keep)       KEEP_REPO=true; shift ;;
        --dry-run)    MODE="dry-run"; shift ;;
        --repo-url)   GITHUB_REPO="$2"; shift 2 ;;
        --branch)     REMOTE_BRANCH="$2"; shift 2 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

# ─── Colour helpers ──────────────────────────────────────────────────────────
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${BLUE}ℹ️  $*${NC}"; }
ok()    { echo -e "${GREEN}✅ $*${NC}"; }
warn()  { echo -e "${YELLOW}⚠️  $*${NC}"; }
fail()  { echo -e "${RED}❌ $*${NC}"; }

# ─── Bootstrap ───────────────────────────────────────────────────────────────
install() {
    local SRC_DIR="$1"

    info "Extensions target: $PI_EXTENSIONS"
    info "Themes target:     $PI_THEMES"
    info "Skills target:     $PI_SKILLS"

    mkdir -p "$PI_EXTENSIONS" "$PI_THEMES" "$PI_SKILLS"

    local ext_count=0 theme_count=0 skill_count=0

    if [ -d "$SRC_DIR/extensions" ]; then
        for d in "$SRC_DIR"/extensions/*/; do
            [ -d "$d" ] || continue
            local name; name="$(basename "$d")"
            info "  → $name"
            cp -r "$d" "$PI_EXTENSIONS/${name}"
            ext_count=$((ext_count + 1))
        done
        ok "$ext_count extension(s) installed"
    fi

    if [ -d "$SRC_DIR/themes" ]; then
        for f in "$SRC_DIR"/themes/*; do
            [ -f "$f" ] || continue
            local name; name="$(basename "$f")"
            info "  → $name"
            cp "$f" "$PI_THEMES/${name}"
            theme_count=$((theme_count + 1))
        done
        ok "$theme_count theme(s) installed"
    fi

    if [ -d "$SRC_DIR/skills" ]; then
        for d in "$SRC_DIR"/skills/*/; do
            [ -d "$d" ] || continue
            local name; name="$(basename "$d")"
            info "  → $name"
            cp -r "$d" "$PI_SKILLS/${name}"
            skill_count=$((skill_count + 1))
        done
        ok "$skill_count skill(s) installed"
    fi

    info "Total: $ext_count extensions + $theme_count themes + $skill_count skills"
}

cleanup() {
    if [[ "$KEEP_REPO" == "true" ]] || [[ "$MODE" == "from-clone" ]]; then
        return
    fi

    local TMP_DIR="$1"
    info "Cleaning up temporary files…"
    rm -rf "$TMP_DIR"
    ok "Temporary directory removed"
}

# ─── Main ────────────────────────────────────────────────────────────────────
echo -e "${BLUE}╔═══════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Pi Extensions Installer v1.0.0     ║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════╝${NC}"
echo

# Determine source location
SRC_DIR=""
if [[ "$MODE" == "from-clone" ]]; then
    SRC_DIR="$SCRIPT_DIR"
elif [[ -d "${HOME}/.pi/pi-extensions" ]] && [[ "$MODE" != "auto" ]]; then
    # Already cloned — ask user
    info "Found existing repo at ${HOME}/.pi/pi-extensions"
    read -rp "  Use it? [Y/n] " ans
    ans="${ans:-Y}"
    if [[ "$ans" =~ ^[Nn]$ ]]; then
        # Download fresh
        TMP_DIR=$(mktemp -d)
        SRC_DIR="$TMP_DIR"
        info "Cloning $GITHUB_REPO ($REMOTE_BRANCH) into $TMP_DIR …"
        git clone --depth 1 -b "$REMOTE_BRANCH" "$GITHUB_REPO" "$TMP_DIR"
    else
        SRC_DIR="${HOME}/.pi/pi-extensions"
    fi
elif [[ "$MODE" == "auto" ]] || [[ -z "$SRC_DIR" ]]; then
    TMP_DIR=$(mktemp -d)
    SRC_DIR="$TMP_DIR"
    info "Cloning $GITHUB_REPO ($REMOTE_BRANCH) …"
    git clone --depth 1 -b "$REMOTE_BRANCH" "$GITHUB_REPO" "$TMP_DIR"
fi

if [[ ! -d "$SRC_DIR" ]]; then
    fail "Source directory not found: $SRC_DIR"
    exit 1
fi

install "$SRC_DIR"

echo
ok "Installation complete!"
echo "  Reload Pi and type: /reload"
echo

# Cleanup (only if repo was bootstrapped by this script)
if [[ "$MODE" == "auto" ]] || [[ "$MODE" == "interactive" && "$KEEP_REPO" != "true" ]]; then
    cleanup "$TMP_DIR"
fi

exit 0
