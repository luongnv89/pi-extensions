#!/bin/bash

# Pi Extensions Installation Script
# Installs all extensions, skills, and themes to your Pi setup
#
# Usage:
#   Interactive (default) — shows selection menu:
#     curl -fsSL https://raw.githubusercontent.com/luongnv89/pi-extensions/main/install.sh | bash
#
#   Selective CLI (no menu):
#     install.sh --auto --extensions advisor-pi,opencode-pi --themes neon-green
#
#   Everything (backward compatible):
#     curl -fsSL https://raw.githubusercontent.com/luongnv89/pi-extensions/main/install.sh | bash -s -- --auto
#
#   From cloned repo:
#     ~/.pi/pi-extensions/install.sh
#     ~/.pi/pi-extensions/install.sh --auto
#     ~/.pi/pi-extensions/install.sh --auto --keep
#
#   Dry-run (list available items):
#     install.sh --dry-run

set -e

# ─── Defaults ────────────────────────────────────────────────────────────────
GITHUB_REPO="https://github.com/luongnv89/pi-extensions"
REMOTE_BRANCH="main"

PI_EXTENSIONS="${HOME}/.pi/agent/extensions"
PI_THEMES="${HOME}/.pi/agent/themes"
PI_SKILLS="${HOME}/.pi/agent/skills"

MODE="interactive"     # or "auto", "from-clone", "dry-run"
KEEP_REPO=false         # or "true"

# Selective install flags
SELECT_EXTENSIONS=""   # comma-separated list of extension names
SELECT_THEMES=""       # comma-separated list of theme filenames
SELECT_SKILLS=""       # comma-separated list of skill names

# Auto-detect: if run from within the repo, skip bootstrap entirely
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ "$SCRIPT_DIR" == "${HOME}/.pi/pi-extensions" ]]; then
    MODE="from-clone"
fi

# ─── Parse flags ─────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --auto)           MODE="auto"; shift ;;
        --keep)           KEEP_REPO=true; shift ;;
        --dry-run)        MODE="dry-run"; shift ;;
        --repo-url)       GITHUB_REPO="$2"; shift 2 ;;
        --branch)         REMOTE_BRANCH="$2"; shift 2 ;;
        --extensions)
            if [[ -z "$2" || "$2" == --* ]]; then
                echo "Error: --extensions requires a value (comma-separated list of names)"
                exit 1
            fi
            SELECT_EXTENSIONS="$2"; shift 2 ;;
        --themes)
            if [[ -z "$2" || "$2" == --* ]]; then
                echo "Error: --themes requires a value (comma-separated list of filenames)"
                exit 1
            fi
            SELECT_THEMES="$2"; shift 2 ;;
        --skills)
            if [[ -z "$2" || "$2" == --* ]]; then
                echo "Error: --skills requires a value (comma-separated list of names)"
                exit 1
            fi
            SELECT_SKILLS="$2"; shift 2 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

# ─── Colour helpers ──────────────────────────────────────────────────────────
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${BLUE}ℹ️  $*${NC}"; }
ok()    { echo -e "${GREEN}✅ $*${NC}"; }
warn()  { echo -e "${YELLOW}⚠️  $*${NC}"; }
fail()  { echo -e "${RED}❌ $*${NC}"; }
select_style() { echo -e "${CYAN}◉ $*${NC}"; }

# ─── Inventory helpers ───────────────────────────────────────────────────────
discover_items() {
    local SRC_DIR="$1"

    # Discover extensions
    EXT_ITEMS=()
    if [ -d "$SRC_DIR/extensions" ]; then
        for d in "$SRC_DIR"/extensions/*/; do
            [ -d "$d" ] || continue
            EXT_ITEMS+=("$(basename "$d")")
        done
    fi

    # Discover themes
    THEME_ITEMS=()
    if [ -d "$SRC_DIR/themes" ]; then
        for f in "$SRC_DIR"/themes/*; do
            [ -f "$f" ] || continue
            THEME_ITEMS+=("$(basename "$f")")
        done
    fi

    # Discover skills
    SKILL_ITEMS=()
    if [ -d "$SRC_DIR/skills" ]; then
        for d in "$SRC_DIR"/skills/*/; do
            [ -d "$d" ] || continue
            SKILL_ITEMS+=("$(basename "$d")")
        done
    fi
}

# ─── Interactive selection menu ──────────────────────────────────────────────
select_items_interactive() {
    local SRC_DIR="$1"

    # If CLI selective flags were provided, skip interactive menu entirely
    if [[ -n "$SELECT_EXTENSIONS" ]] || [[ -n "$SELECT_THEMES" ]] || [[ -n "$SELECT_SKILLS" ]]; then
        return
    fi

    # Check if we have a TTY for interactive input
    if [ ! -t 0 ]; then
        warn "No TTY detected — falling back to installing all items (--auto behavior)."
        return
    fi

    discover_items "$SRC_DIR"

    # Show category selection
    echo ""
    echo -e "  ${CYAN}══════════════════════════════════════════${NC}"
    echo -e "  ${CYAN}Select categories to install${NC}"
    echo -e "  ${CYAN}══════════════════════════════════════════${NC}"
    echo ""
    echo -e "  ${YELLOW}[space] to toggle, [enter] to confirm${NC}"
    echo ""

    local cat_count=${#EXT_ITEMS[@]}
    [ ${#THEME_ITEMS[@]} -gt 0 ] && cat_count=$((cat_count + 1))
    [ ${#SKILL_ITEMS[@]} -gt 0 ] && cat_count=$((cat_count + 1))

    # Default: all categories selected
    local sel_ext=1 sel_theme=1 sel_skill=1

    local idx=1
    if [ ${#EXT_ITEMS[@]} -gt 0 ]; then
        select_style "[ ] Extensions (${#EXT_ITEMS[@]} available)"
        idx=$((idx + 1))
    fi
    if [ ${#THEME_ITEMS[@]} -gt 0 ]; then
        select_style "[ ] Themes (${#THEME_ITEMS[@]} available)"
        idx=$((idx + 1))
    fi
    if [ ${#SKILL_ITEMS[@]} -gt 0 ]; then
        select_style "[ ] Skills (${#SKILL_ITEMS[@]} available)"
        idx=$((idx + 1))
    fi

    if [ $cat_count -eq 0 ]; then
        warn "No items found to install."
        return
    fi

    # Category selection loop
    echo ""
    idx=1
    if [ ${#EXT_ITEMS[@]} -gt 0 ]; then
        read -rp "  Extensions [${sel_ext}]? " ans
        ans="${ans:-$sel_ext}"
        [[ "$ans" =~ ^[Yy1]$ ]] && sel_ext=1 || sel_ext=0
        idx=$((idx + 1))
    fi
    if [ ${#THEME_ITEMS[@]} -gt 0 ]; then
        read -rp "  Themes [${sel_theme}]? " ans
        ans="${ans:-$sel_theme}"
        [[ "$ans" =~ ^[Yy1]$ ]] && sel_theme=1 || sel_theme=0
        idx=$((idx + 1))
    fi
    if [ ${#SKILL_ITEMS[@]} -gt 0 ]; then
        read -rp "  Skills [${sel_skill}]? " ans
        ans="${ans:-$sel_skill}"
        [[ "$ans" =~ ^[Yy1]$ ]] && sel_skill=1 || sel_skill=0
    fi

    # Item selection per category
    SEL_EXT_ITEMS=()
    SEL_THEME_ITEMS=()
    SEL_SKILL_ITEMS=()

    if [ "$sel_ext" -eq 1 ]; then
        select_items_from_list "Extensions" "${EXT_ITEMS[@]}" SEL_EXT_ITEMS
    fi

    if [ "$sel_theme" -eq 1 ]; then
        select_items_from_list "Themes" "${THEME_ITEMS[@]}" SEL_THEME_ITEMS
    fi

    if [ "$sel_skill" -eq 1 ]; then
        select_items_from_list "Skills" "${SKILL_ITEMS[@]}" SEL_SKILL_ITEMS
    fi
}

select_items_from_list() {
    local category="$1"
    shift
    local -a items=("$@")

    if [ ${#items[@]} -eq 0 ]; then
        return
    fi

    echo ""
    echo -e "  ${CYAN}══════════════════════════════════════════${NC}"
    echo -e "  ${CYAN}${category} — select items to install${NC}"
    echo -e "  ${CYAN}══════════════════════════════════════════${NC}"
    echo ""
    echo -e "  ${YELLOW}[space] to toggle, [enter] to confirm${NC}"
    echo ""

    # Default: all selected
    local -a selected=()
    for item in "${items[@]}"; do
        selected+=("$item")
    done

    # Show selection menu
    local idx=1
    for item in "${items[@]}"; do
        local mark="◉"
        if printf '%s\n' "${selected[@]}" | grep -qxF "$item"; then
            mark="◉"
        else
            mark="○"
        fi
        echo -e "    ${mark} ${idx}) ${item}"
        idx=$((idx + 1))
    done
    echo ""
    echo -e "  ${YELLOW}Enter numbers to toggle (e.g. 1 3 5), or press Enter to keep current selection${NC}"
    echo ""

    read -rp "  Selection> " selection_input
    selection_input="${selection_input:-all}"

    # Reset to empty if user explicitly types something
    if [ "$selection_input" = "all" ] || [ -z "$selection_input" ]; then
        selected=("${items[@]}")
    else
        selected=()
        for num in $selection_input; do
            if [[ "$num" =~ ^[0-9]+$ ]] && [ "$num" -ge 1 ] && [ "$num" -le ${#items[@]} ]; then
                selected+=("${items[$((num - 1))]}")
            fi
        done
    fi

    # Show final summary
    echo ""
    if [ ${#selected[@]} -eq 0 ]; then
        echo -e "  ${YELLOW}  ⚠ No ${category,,} selected — skipping.${NC}"
    else
        echo -e "  ${GREEN}  ✓ ${#selected[@]} ${category,,} selected:${NC}"
        for item in "${selected[@]}"; do
            echo -e "    ${GREEN}  →${NC} ${item}"
        done
    fi
    echo ""

    # Export selected items via global variable
    case "$category" in
        Extensions) SEL_EXT_ITEMS=("${selected[@]}");;
        Themes)     SEL_THEME_ITEMS=("${selected[@]}");;
        Skills)     SEL_SKILL_ITEMS=("${selected[@]}");;
    esac
}

# ─── Bootstrap ───────────────────────────────────────────────────────────────
install() {
    local SRC_DIR="$1"

    info "Extensions target: $PI_EXTENSIONS"
    info "Themes target:     $PI_THEMES"
    info "Skills target:     $PI_SKILLS"

    mkdir -p "$PI_EXTENSIONS" "$PI_THEMES" "$PI_SKILLS"

    local ext_count=0 theme_count=0 skill_count=0

    # Install extensions
    if [ -d "$SRC_DIR/extensions" ]; then
        if [ -n "${SEL_EXT_ITEMS:-}" ]; then
            # Selective install
            for name in "${SEL_EXT_ITEMS[@]}"; do
                # Sanitize: reject path traversal attempts
                if [[ "$name" == *..* ]] || [[ "$name" == */* ]]; then
                    warn "  ! Invalid extension name (path traversal blocked): $name"
                    continue
                fi
                local d="$SRC_DIR/extensions/${name}"
                if [ -d "$d" ]; then
                    info "  → $name"
                    cp -r "$d" "$PI_EXTENSIONS/${name}"
                    ext_count=$((ext_count + 1))
                else
                    warn "  ! Extension not found: $name"
                fi
            done
        else
            # Install all
            for d in "$SRC_DIR"/extensions/*/; do
                [ -d "$d" ] || continue
                local name; name="$(basename "$d")"
                info "  → $name"
                cp -r "$d" "$PI_EXTENSIONS/${name}"
                ext_count=$((ext_count + 1))
            done
        fi
        ok "$ext_count extension(s) installed"
    fi

    # Install themes
    if [ -d "$SRC_DIR/themes" ]; then
        if [ -n "${SEL_THEME_ITEMS:-}" ]; then
            # Selective install
            for name in "${SEL_THEME_ITEMS[@]}"; do
                # Sanitize: reject path traversal attempts
                if [[ "$name" == *..* ]] || [[ "$name" == */* ]]; then
                    warn "  ! Invalid theme name (path traversal blocked): $name"
                    continue
                fi
                local f="$SRC_DIR/themes/${name}"
                if [ -f "$f" ]; then
                    info "  → $name"
                    cp "$f" "$PI_THEMES/${name}"
                    theme_count=$((theme_count + 1))
                else
                    warn "  ! Theme not found: $name"
                fi
            done
        else
            # Install all
            for f in "$SRC_DIR"/themes/*; do
                [ -f "$f" ] || continue
                local name; name="$(basename "$f")"
                info "  → $name"
                cp "$f" "$PI_THEMES/${name}"
                theme_count=$((theme_count + 1))
            done
        fi
        ok "$theme_count theme(s) installed"
    fi

    # Install skills
    if [ -d "$SRC_DIR/skills" ]; then
        if [ -n "${SEL_SKILL_ITEMS:-}" ]; then
            # Selective install
            for name in "${SEL_SKILL_ITEMS[@]}"; do
                # Sanitize: reject path traversal attempts
                if [[ "$name" == *..* ]] || [[ "$name" == */* ]]; then
                    warn "  ! Invalid skill name (path traversal blocked): $name"
                    continue
                fi
                local d="$SRC_DIR/skills/${name}"
                if [ -d "$d" ]; then
                    info "  → $name"
                    cp -r "$d" "$PI_SKILLS/${name}"
                    skill_count=$((skill_count + 1))
                else
                    warn "  ! Skill not found: $name"
                fi
            done
        else
            # Install all
            for d in "$SRC_DIR"/skills/*/; do
                [ -d "$d" ] || continue
                local name; name="$(basename "$d")"
                info "  → $name"
                cp -r "$d" "$PI_SKILLS/${name}"
                skill_count=$((skill_count + 1))
            done
        fi
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

# ─── Dry-run: list available items ───────────────────────────────────────────
dry_run() {
    echo ""
    echo -e "  ${CYAN}══════════════════════════════════════════${NC}"
    echo -e "  ${CYAN}Available items${NC}"
    echo -e "  ${CYAN}══════════════════════════════════════════${NC}"
    echo ""

    discover_items "$SRC_DIR"

    if [ ${#EXT_ITEMS[@]} -gt 0 ]; then
        echo -e "  ${YELLOW}Extensions (${#EXT_ITEMS[@]}):${NC}"
        for item in "${EXT_ITEMS[@]}"; do
            echo -e "    ◉ $item"
        done
        echo ""
    fi

    if [ ${#THEME_ITEMS[@]} -gt 0 ]; then
        echo -e "  ${YELLOW}Themes (${#THEME_ITEMS[@]}):${NC}"
        for item in "${THEME_ITEMS[@]}"; do
            echo -e "    ◉ $item"
        done
        echo ""
    fi

    if [ ${#SKILL_ITEMS[@]} -gt 0 ]; then
        echo -e "  ${YELLOW}Skills (${#SKILL_ITEMS[@]}):${NC}"
        for item in "${SKILL_ITEMS[@]}"; do
            echo -e "    ◉ $item"
        done
        echo ""
    fi

    echo -e "  ${BLUE}Use --extensions, --themes, --skills to select specific items${NC}"
    echo -e "  ${BLUE}Run without flags for interactive selection${NC}"
}

# ─── Main ────────────────────────────────────────────────────────────────────
echo -e "${BLUE}╔═══════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Pi Extensions Installer v1.1.0     ║${NC}"
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

# Dry-run: list available items
if [[ "$MODE" == "dry-run" ]]; then
    dry_run
    exit 0
fi

# Selective install via CLI flags — discover items and set selection arrays
if [[ -n "$SELECT_EXTENSIONS" ]] || [[ -n "$SELECT_THEMES" ]] || [[ -n "$SELECT_SKILLS" ]]; then
    discover_items "$SRC_DIR"

    # Parse extension selection (filter empty elements, validate paths)
    if [ -n "$SELECT_EXTENSIONS" ]; then
        IFS=',' read -ra _raw_ext <<< "$SELECT_EXTENSIONS"
        SEL_EXT_ITEMS=()
        for _item in "${_raw_ext[@]}"; do
            _item="$(echo "$_item" | xargs)"  # trim whitespace
            [ -z "$_item" ] && continue
            if [[ "$_item" == *..* ]] || [[ "$_item" == */* ]]; then
                warn "  ! Invalid extension name (path traversal blocked): $_item"
                continue
            fi
            SEL_EXT_ITEMS+=("$_item")
        done
    fi

    # Parse theme selection (filter empty elements, validate paths)
    if [ -n "$SELECT_THEMES" ]; then
        IFS=',' read -ra _raw_theme <<< "$SELECT_THEMES"
        SEL_THEME_ITEMS=()
        for _item in "${_raw_theme[@]}"; do
            _item="$(echo "$_item" | xargs)"
            [ -z "$_item" ] && continue
            if [[ "$_item" == *..* ]] || [[ "$_item" == */* ]]; then
                warn "  ! Invalid theme name (path traversal blocked): $_item"
                continue
            fi
            SEL_THEME_ITEMS+=("$_item")
        done
    fi

    # Parse skill selection (filter empty elements, validate paths)
    if [ -n "$SELECT_SKILLS" ]; then
        IFS=',' read -ra _raw_skill <<< "$SELECT_SKILLS"
        SEL_SKILL_ITEMS=()
        for _item in "${_raw_skill[@]}"; do
            _item="$(echo "$_item" | xargs)"
            [ -z "$_item" ] && continue
            if [[ "$_item" == *..* ]] || [[ "$_item" == */* ]]; then
                warn "  ! Invalid skill name (path traversal blocked): $_item"
                continue
            fi
            SEL_SKILL_ITEMS+=("$_item")
        done
    fi
fi

# Interactive mode: show selection menu (only when no CLI flags and not --auto)
if [[ "$MODE" == "interactive" ]] && \
   [[ -z "$SELECT_EXTENSIONS" ]] && \
   [[ -z "$SELECT_THEMES" ]] && \
   [[ -z "$SELECT_SKILLS" ]]; then
    select_items_interactive "$SRC_DIR"
fi

# Show what will be installed
if [[ -n "${SEL_EXT_ITEMS:-}" ]] || [[ -n "${SEL_THEME_ITEMS:-}" ]] || [[ -n "${SEL_SKILL_ITEMS:-}" ]]; then
    echo -e "  ${BLUE}──────────────────────────────────────────${NC}"
    echo -e "  ${BLUE}Selective install mode${NC}"
    echo -e "  ${BLUE}──────────────────────────────────────────${NC}"
    if [ ${#SEL_EXT_ITEMS[@]} -gt 0 ]; then
        echo -e "  Extensions: ${SEL_EXT_ITEMS[*]}"
    fi
    if [ ${#SEL_THEME_ITEMS[@]} -gt 0 ]; then
        echo -e "  Themes:     ${SEL_THEME_ITEMS[*]}"
    fi
    if [ ${#SEL_SKILL_ITEMS[@]} -gt 0 ]; then
        echo -e "  Skills:     ${SEL_SKILL_ITEMS[*]}"
    fi
    echo ""
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
