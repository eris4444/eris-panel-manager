#!/usr/bin/env bash
# ==============================================================================
#  ERIS PANEL MANAGER - installer
#    curl -fsSL https://raw.githubusercontent.com/eris4444/eris-panel-manager/main/install.sh | bash
# ==============================================================================
set -u

REPO_RAW="https://raw.githubusercontent.com/eris4444/eris-panel-manager/main"
DEST="/usr/local/bin/erispm"
BASE_DIR="/etc/eris-panel-manager"
WEB_DIR="$BASE_DIR/web"
MARKER="ERIS-PANEL-MANAGER-SCRIPT"

R=$'\e[38;5;203m'; G=$'\e[38;5;114m'; C=$'\e[38;5;81m'; P=$'\e[38;5;177m'; D=$'\e[38;5;244m'; N=$'\e[0m'
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$1"; }
bad()  { printf '  %s✗%s %s\n' "$R" "$N" "$1" >&2; }
info() { printf '  %s·%s %s\n' "$C" "$N" "$1"; }

echo
printf '  %s%sERIS PANEL MANAGER%s  installer\n' "$P" "$(printf '\e[1m')" "$N"
echo

# --- root ---------------------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
  bad "must run as root - try again with sudo"
  exit 1
fi

# --- dependencies -------------------------------------------------------------
need_pkgs=""
for c in curl tar python3; do
  command -v "$c" >/dev/null 2>&1 || need_pkgs="$need_pkgs $c"
done
if [ -n "$need_pkgs" ]; then
  info "installing:$need_pkgs"
  if   command -v apt-get >/dev/null 2>&1; then apt-get update -qq && apt-get install -y -qq $need_pkgs
  elif command -v dnf     >/dev/null 2>&1; then dnf install -y -q $need_pkgs
  elif command -v yum     >/dev/null 2>&1; then yum install -y -q $need_pkgs
  elif command -v apk     >/dev/null 2>&1; then apk add --no-cache $need_pkgs
  elif command -v pacman  >/dev/null 2>&1; then pacman -Sy --noconfirm $need_pkgs
  else bad "install these manually:$need_pkgs"; exit 1; fi
fi

# --- download manager ---------------------------------------------------------
tmp="$(mktemp)" || { bad "cannot create temp file"; exit 1; }
trap 'rm -f "$tmp"' EXIT
info "downloading manager"
if ! curl -fsSL --retry 3 --max-time 90 -o "$tmp" "$REPO_RAW/eris-panel-manager.sh"; then
  bad "download failed - check connectivity to raw.githubusercontent.com"
  exit 1
fi
sed -i 's/\r$//' "$tmp" 2>/dev/null || true
grep -q "$MARKER" "$tmp" || { bad "downloaded file is not the manager"; exit 1; }
bash -n "$tmp" 2>/dev/null || { bad "downloaded file has syntax errors"; exit 1; }
ver="$(grep -m1 '^SCRIPT_VER=' "$tmp" | cut -d'"' -f2)"

# --- install manager ----------------------------------------------------------
mkdir -p "$BASE_DIR" "$WEB_DIR/static" && chmod 700 "$BASE_DIR"
[ -f "$DEST" ] && cp -f "$DEST" "$DEST.bak" 2>/dev/null
install -m 0755 "$tmp" "$DEST" || { bad "could not write $DEST"; exit 1; }
ok "installed erispm v${ver:-?} to $DEST"

# --- fetch web panel assets ---------------------------------------------------
info "fetching web panel"
web_ok=1
for f in server.py static/index.html static/login.html static/app.css static/app.js; do
  if ! curl -fsSL --retry 3 --max-time 60 -o "$WEB_DIR/$f" "$REPO_RAW/web/$f"; then
    web_ok=0; bad "could not fetch web/$f"
  fi
done
[ "$web_ok" = "1" ] && ok "web panel assets ready in $WEB_DIR"

echo
printf '  %s────────────────────────────────────────────%s\n' "$D" "$N"
printf '  %srun the terminal menu:%s  %serispm%s\n' "$D" "$N" "$C" "$N"
printf '  %sstart the web panel  :%s  %serispm web install%s\n' "$D" "$N" "$C" "$N"
printf '  %s────────────────────────────────────────────%s\n' "$D" "$N"
echo

# --- launch -------------------------------------------------------------------
if [ -r /dev/tty ]; then
  exec "$DEST" </dev/tty
fi
