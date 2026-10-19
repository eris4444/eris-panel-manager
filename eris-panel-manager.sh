#!/usr/bin/env bash
# ==============================================================================
#  ERIS-PANEL-MANAGER-SCRIPT
#  Eris Panel Manager  -  one command to rule your proxy panels, nodes & tunnels
#
#  Install:
#    curl -fsSL https://raw.githubusercontent.com/eris4444/eris-panel-manager/main/install.sh | bash
#  Run:
#    erispm
#
#  Covers: PasarGuard / Marzban / Marzneshin / 3x-ui (Sanaei) panels and their
#  nodes, Let's Encrypt / ZeroSSL certificates, database backup & restore,
#  server-to-server migration (one-by-one or all-at-once), Spoof Tunnel +
#  Spoof Tester, and Eris Tunnel 2 - all driven from a colourful terminal menu
#  or the bundled Python web panel.
#
#  License: MIT  (c) 2026 eris4444
# ==============================================================================
set -u

# HOME is referenced below (acme.sh lives under it). Under `set -u` an unset HOME
# - as happens from some systemd/cron/sudo contexts - would abort the whole
# script on startup, so give it a sane default before anything uses it.
: "${HOME:=/root}"
export HOME

SCRIPT_VER="1.4.1"
MARKER="ERIS-PANEL-MANAGER-SCRIPT"

# --- paths --------------------------------------------------------------------
BASE_DIR="/etc/eris-panel-manager"
BACKUP_DIR="$BASE_DIR/backups"
CERT_DIR="$BASE_DIR/certs"
WEB_DIR="$BASE_DIR/web"
STATE_DIR="$BASE_DIR/state"
CONF="$BASE_DIR/config.env"
LOG_DIR="/var/log/eris-panel-manager"
LOG_FILE="$LOG_DIR/erispm.log"
SELF="/usr/local/bin/erispm"
RAW_SELF="https://raw.githubusercontent.com/eris4444/eris-panel-manager/main/eris-panel-manager.sh"
RAW_WEB_BASE="https://raw.githubusercontent.com/eris4444/eris-panel-manager/main/web"

# --- official upstream installers (wrapped, never rebranded) ------------------
URL_PASARGUARD="https://raw.githubusercontent.com/PasarGuard/scripts/main/pasarguard.sh"
URL_PG_NODE="https://raw.githubusercontent.com/PasarGuard/scripts/main/pg-node.sh"
URL_MARZBAN="https://github.com/Gozargah/Marzban-scripts/raw/master/marzban.sh"
URL_MARZBAN_NODE="https://github.com/Gozargah/Marzban-scripts/raw/master/marzban-node.sh"
URL_MARZNESHIN="https://github.com/marzneshin/Marzneshin/raw/master/script.sh"
URL_3XUI="https://raw.githubusercontent.com/mhsanaei/3x-ui/main/install.sh"
URL_SPOOF="https://raw.githubusercontent.com/ParsaKSH/spoof-tunnel/main/panel/install.sh"
SPOOF_UNIT="/etc/systemd/system/spoof-panel.service"   # written by the official Spoof installer
URL_ERISTUN2="https://raw.githubusercontent.com/eris4444/eris-tunnel-2/main/install.sh"

# ==============================================================================
#  Appearance
# ==============================================================================
if [ -t 1 ] && [ "${NO_COLOR:-}" = "" ]; then
  R=$'\e[38;5;203m'      # red / danger
  G=$'\e[38;5;114m'      # green / ok
  C=$'\e[38;5;81m'       # cyan / brand
  Y=$'\e[38;5;221m'      # yellow / warn
  P=$'\e[38;5;177m'      # purple / accent
  B=$'\e[38;5;75m'       # blue
  O=$'\e[38;5;215m'      # orange
  D=$'\e[38;5;244m'      # dim
  W=$'\e[38;5;252m'      # white-ish
  BOLD=$'\e[1m'; DIM=$'\e[2m'; ITAL=$'\e[3m'; UL=$'\e[4m'
  N=$'\e[0m'
else
  R=''; G=''; C=''; Y=''; P=''; B=''; O=''; D=''; W=''
  BOLD=''; DIM=''; ITAL=''; UL=''; N=''
fi

# ==============================================================================
#  Logging & helpers
# ==============================================================================
_log() { mkdir -p "$LOG_DIR" 2>/dev/null; printf '%s | %s\n' "$(date '+%F %T')" "$1" >>"$LOG_FILE" 2>/dev/null; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$1"; _log "OK  : $1"; }
bad()  { printf '  %s✗%s %s\n' "$R" "$N" "$1" >&2; _log "ERR : $1"; }
info() { printf '  %s·%s %s\n' "$C" "$N" "$1"; _log "INFO: $1"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$1"; _log "WARN: $1"; }
step() { printf '\n%s▸ %s%s%s\n' "$P" "$BOLD" "$1" "$N"; _log "STEP: $1"; }
die()  { bad "$1"; exit "${2:-1}"; }
hr()   { printf '%s' "$D"; printf '─%.0s' $(seq 1 "${1:-62}"); printf '%s\n' "$N"; }

# interactivity -----------------------------------------------------------------
ASSUME_YES="${ERISPM_YES:-0}"
NONINT="${ERISPM_NONINTERACTIVE:-0}"

confirm() { # confirm "question" [default:y|n]
  local q="$1" def="${2:-n}" ans
  if [ "$ASSUME_YES" = "1" ]; then return 0; fi
  if [ "$NONINT" = "1" ]; then [ "$def" = "y" ]; return; fi
  local hint="[y/N]"; [ "$def" = "y" ] && hint="[Y/n]"
  printf '  %s?%s %s %s%s%s ' "$Y" "$N" "$q" "$D" "$hint" "$N"
  read -r ans </dev/tty || ans=""
  ans="${ans:-$def}"
  case "$ans" in [yY]*) return 0;; *) return 1;; esac
}

ask() { # ask "prompt" [default] -> echoes value
  local q="$1" def="${2:-}" ans
  if [ "$NONINT" = "1" ]; then printf '%s' "$def"; return; fi
  if [ -n "$def" ]; then printf '  %s»%s %s %s(%s)%s: ' "$C" "$N" "$q" "$D" "$def" "$N" >&2
  else printf '  %s»%s %s: ' "$C" "$N" "$q" >&2; fi
  read -r ans </dev/tty || ans=""
  printf '%s' "${ans:-$def}"
}

ask_secret() { # ask_secret "prompt" -> echoes value (no echo to screen)
  local q="$1" ans
  printf '  %s»%s %s: ' "$C" "$N" "$q" >&2
  read -rs ans </dev/tty || ans=""; printf '\n' >&2
  printf '%s' "$ans"
}

pause() { [ "$NONINT" = "1" ] && return 0; printf '\n  %spress Enter to continue%s' "$D" "$N"; read -r _ </dev/tty || true; }

# ==============================================================================
#  System detection
# ==============================================================================
need_root() { [ "$(id -u)" -eq 0 ] || die "must run as root - try: sudo erispm"; }
have()      { command -v "$1" >/dev/null 2>&1; }

PM=""
pm_detect() {
  if   have apt-get; then PM="apt"
  elif have dnf;     then PM="dnf"
  elif have yum;     then PM="yum"
  elif have apk;     then PM="apk"
  elif have pacman;  then PM="pacman"
  else PM=""; fi
}

ensure_pkg() { # ensure_pkg pkg...
  local miss="" p
  for p in "$@"; do have "$p" || miss="$miss $p"; done
  [ -z "$miss" ] && return 0
  pm_detect
  info "installing:$miss"
  case "$PM" in
    apt)    apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq $miss >/dev/null 2>&1 ;;
    dnf)    dnf install -y -q $miss >/dev/null 2>&1 ;;
    yum)    yum install -y -q $miss >/dev/null 2>&1 ;;
    apk)    apk add --no-cache $miss >/dev/null 2>&1 ;;
    pacman) pacman -Sy --noconfirm $miss >/dev/null 2>&1 ;;
    *)      bad "no supported package manager - install manually:$miss"; return 1 ;;
  esac
  local p2 fail=""
  for p2 in $miss; do have "$p2" || fail="$fail $p2"; done
  [ -z "$fail" ] && return 0
  warn "some packages may map to a different binary name:$fail"
  return 0
}

ensure_docker() {
  if have docker; then return 0; fi
  step "Installing Docker"
  if curl -fsSL https://get.docker.com | sh >/dev/null 2>&1; then
    systemctl enable --now docker >/dev/null 2>&1 || true
    ok "docker installed"
  else
    die "docker install failed - install it manually and re-run"
  fi
}

PUBIP=""
pub_ip() {
  [ -n "$PUBIP" ] && { printf '%s' "$PUBIP"; return; }
  PUBIP="$(curl -fsSL --max-time 6 https://api.ipify.org 2>/dev/null \
            || curl -fsSL --max-time 6 https://ifconfig.me 2>/dev/null \
            || hostname -I 2>/dev/null | awk '{print $1}')"
  printf '%s' "$PUBIP"
}

# ==============================================================================
#  Config store
# ==============================================================================
conf_init() {
  mkdir -p "$BASE_DIR" "$BACKUP_DIR" "$CERT_DIR" "$STATE_DIR" "$LOG_DIR" 2>/dev/null
  chmod 700 "$BASE_DIR" 2>/dev/null || true
  [ -f "$CONF" ] || { umask 077; : >"$CONF"; }
}
conf_get() { conf_init; grep -m1 "^$1=" "$CONF" 2>/dev/null | cut -d= -f2-; }
conf_set() { # conf_set KEY VALUE
  conf_init
  local k="$1" v="$2" tmp
  tmp="$(mktemp)"; grep -v "^$k=" "$CONF" 2>/dev/null >"$tmp" || true
  printf '%s=%s\n' "$k" "$v" >>"$tmp"
  mv "$tmp" "$CONF"; chmod 600 "$CONF"
}

# ==============================================================================
#  Panel / node detection
# ==============================================================================
# echoes "name|installed(0/1)|kind|detail"
PANEL_KEYS="pasarguard marzban marzneshin 3x-ui"
NODE_KEYS="pasarguard-node marzban-node marzneshin-node"

# Detects a panel/node/tunnel even when it was installed OUTSIDE erispm, by
# checking its real data dir, compose dir, CLI command and docker containers.
is_installed() {
  case "$1" in
    pasarguard)      [ -d /opt/pasarguard ] || [ -d /var/lib/pasarguard ] || have pasarguard ;;
    marzban)         [ -d /opt/marzban ]    || [ -d /var/lib/marzban ]    || have marzban ;;
    marzneshin)      [ -d /var/lib/marzneshin ] || [ -d /etc/opt/marzneshin ] || have marzneshin ;;
    3x-ui)           [ -d /etc/x-ui ] || [ -d /usr/local/x-ui ] || have x-ui ;;
    pasarguard-node) [ -d /var/lib/pg-node ] || [ -d /opt/pasarguard-node ] || docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qiE 'pasarguard.*node|pg-node' ;;
    marzban-node)    [ -d /var/lib/marzban-node ] || [ -d /opt/marzban-node ] || docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qi 'marzban.*node' ;;
    marzneshin-node) [ -d /var/lib/marznode ] || docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qi 'marznode' ;;
    eris-tunnel-2)   [ -x /usr/local/bin/eristun2 ] ;;
    spoof-tunnel)    [ -x /usr/local/bin/spoof-panel ] || [ -f "$SPOOF_UNIT" ] || [ -d /opt/spoof-tunnel ] || have spoof-tunnel \
                       || systemctl list-unit-files 2>/dev/null | grep -qi spoof ;;
    *) return 1 ;;
  esac
}

svc_active() { systemctl is-active --quiet "$1" 2>/dev/null; }

# True when the thing is actually UP. The docker panels have no systemd unit of
# their own name (they run via docker compose), so check live containers; 3x-ui
# is a real systemd service.
_dps() { docker ps --format '{{.Names}}' 2>/dev/null; }
is_running() {
  case "$1" in
    marzban)         _dps | grep -i 'marzban'    | grep -qvi 'node' ;;
    pasarguard)      _dps | grep -i 'pasarguard' | grep -qvi 'node' ;;
    marzneshin)      _dps | grep -i 'marzneshin' | grep -qvi 'node' ;;
    3x-ui)           svc_active x-ui ;;
    marzban-node)    _dps | grep -qi 'marzban.*node' ;;
    pasarguard-node) _dps | grep -qiE 'pasarguard.*node|pg-node' ;;
    marzneshin-node) _dps | grep -qi 'marznode' ;;
    eris-tunnel-2)   systemctl list-units --type=service 2>/dev/null | grep -qi 'eristun\|backhaul\|gost' ;;
    spoof-tunnel)    systemctl is-active --quiet spoof-panel 2>/dev/null || _dps | grep -qi 'spoof' \
                       || systemctl is-active --quiet 'spoof-tunnel' 2>/dev/null ;;
    *) return 1 ;;
  esac
}

# ---- panel metadata (where each panel keeps config the container can read) ----
# appdir = where docker-compose.yml + .env live; datadir = volume mounted INTO
# the container (so certs placed here are visible to the dockerised panel).
panel_appdir() {
  local def=""
  case "$1" in
    marzban)    def=/opt/marzban ;;
    pasarguard) def=/opt/pasarguard ;;
    marzneshin) def=/etc/opt/marzneshin ;;
    *)          echo ""; return ;;
  esac
  if [ -f "$def/docker-compose.yml" ] || ! have docker; then echo "$def"; return; fi
  # installed somewhere else by hand: docker compose records where it ran from
  local wd
  wd="$(docker ps -a --filter "label=com.docker.compose.service=$1" \
          --format '{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null | head -n1)"
  echo "${wd:-$def}"
}

# "host_dir|container_dir" of the panel's data volume, read from the container's
# REAL mounts - so a cert written to host_dir is guaranteed to be visible inside
# the container at container_dir (they are equal on standard installs).
panel_mount() { # key
  local key="$1" def; def="$(panel_datadir "$key")"
  if panel_dockerized "$key" && have docker; then
    local cid m
    cid="$(docker ps -aq --filter "label=com.docker.compose.service=$key" 2>/dev/null | head -n1)"
    if [ -n "$cid" ]; then
      m="$(docker inspect -f '{{range .Mounts}}{{.Source}}|{{.Destination}}{{"\n"}}{{end}}' "$cid" 2>/dev/null \
            | grep "|$def\$" | head -n1)"
      [ -n "$m" ] && { echo "$m"; return; }
    fi
  fi
  echo "$def|$def"
}
panel_datadir() {
  case "$1" in
    marzban)    echo /var/lib/marzban ;;
    pasarguard) echo /var/lib/pasarguard ;;
    marzneshin) echo /var/lib/marzneshin ;;
    3x-ui)      echo /etc/x-ui ;;
    *)          echo "" ;;
  esac
}
panel_dockerized() { case "$1" in marzban|pasarguard|marzneshin) return 0 ;; *) return 1 ;; esac; }

# Talk to a dockerised panel's compose project directly. The panels' own CLIs
# (`marzban restart`, `marzban up`, ...) end by FOLLOWING the logs forever, which
# would hang erispm, and a plain `restart` does not re-read .env - so recreate.
panel_compose() { # key compose-args...
  local key="$1"; shift
  local dir; dir="$(panel_appdir "$key")"
  [ -n "$dir" ] && [ -f "$dir/docker-compose.yml" ] || { warn "no docker-compose.yml in ${dir:-?}"; return 1; }
  if docker compose version >/dev/null 2>&1; then
    docker compose -p "$(basename "$dir")" --project-directory "$dir" -f "$dir/docker-compose.yml" "$@"
  elif have docker-compose; then
    docker-compose -p "$(basename "$dir")" --project-directory "$dir" -f "$dir/docker-compose.yml" "$@"
  else
    warn "docker compose is not available"; return 1
  fi
}
panel_restart() { # recreate so a changed .env (e.g. SSL paths) is picked up
  case "$1" in
    marzban|pasarguard|marzneshin) panel_compose "$1" up -d --force-recreate --no-deps "$1" >/dev/null 2>&1 ;;
    3x-ui) systemctl restart x-ui >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}
panel_stop() {
  case "$1" in
    marzban|pasarguard|marzneshin) panel_compose "$1" down >/dev/null 2>&1 ;;
    3x-ui) systemctl stop x-ui >/dev/null 2>&1 ;;
  esac
}
panel_start() {
  case "$1" in
    marzban|pasarguard|marzneshin) panel_compose "$1" up -d >/dev/null 2>&1 ;;
    3x-ui) systemctl start x-ui >/dev/null 2>&1 ;;
  esac
}
XUI_BIN="/usr/local/x-ui/x-ui"   # the Go binary (the `x-ui` on PATH is only the menu script)

pretty_name() {
  case "$1" in
    pasarguard) echo "PasarGuard";; marzban) echo "Marzban";;
    marzneshin) echo "Marzneshin";; 3x-ui) echo "3x-ui (Sanaei)";;
    pasarguard-node) echo "PasarGuard Node";; marzban-node) echo "Marzban Node";;
    marzneshin-node) echo "Marzneshin Node";; eris-tunnel-2) echo "Eris Tunnel 2";;
    spoof-tunnel) echo "Spoof Tunnel";; *) echo "$1";;
  esac
}

# ==============================================================================
#  Banner & dashboards
# ==============================================================================
banner() {
  clear 2>/dev/null || true
  printf '\n'
  printf '   %s%s███████╗██████╗ ██╗███████╗%s   %s%sPANEL MANAGER%s\n'   "$BOLD" "$C" "$N" "$DIM" "$W" "$N"
  printf '   %s%s██╔════╝██╔══██╗██║██╔════╝%s   %spanels · nodes · certs%s\n' "$BOLD" "$C" "$N" "$D" "$N"
  printf '   %s%s█████╗  ██████╔╝██║███████╗%s   %sbackup · migrate · tunnels%s\n' "$BOLD" "$C" "$N" "$D" "$N"
  printf '   %s%s██╔══╝  ██╔══██╗██║╚════██║%s\n'   "$BOLD" "$C" "$N"
  printf '   %s%s███████╗██║  ██║██║███████║%s   %sv%s%s\n'   "$BOLD" "$C" "$N" "$P" "$SCRIPT_VER" "$N"
  printf '   %s%s╚══════╝╚═╝  ╚═╝╚═╝╚══════╝%s   %s%s%s\n'   "$BOLD" "$C" "$N" "$D" "github.com/eris4444/eris-panel-manager" "$N"
  printf '\n'
}

status_line() { # status_line key
  local k="$1" dot name det=""
  name="$(pretty_name "$k")"
  if is_installed "$k"; then
    if is_running "$k"; then dot="${G}●${N}"; det="${G}running${N}"
    else                     dot="${Y}◐${N}"; det="${Y}installed · stopped${N}"; fi
  else
    dot="${D}○${N}"; det="${D}not installed${N}"
  fi
  printf '   %s  %-22s %s\n' "$dot" "$name" "$det"
}

dashboard() {
  printf '  %s%sInstalled on this server%s\n' "$BOLD" "$W" "$N"; hr 44
  local k
  for k in $PANEL_KEYS; do status_line "$k"; done
  printf '   %s· nodes ·%s\n' "$D" "$N"
  for k in $NODE_KEYS; do status_line "$k"; done
  printf '   %s· tunnels ·%s\n' "$D" "$N"
  for k in spoof-tunnel eris-tunnel-2; do status_line "$k"; done
  hr 44
}

# ==============================================================================
#  Run an upstream installer (wrapped)
# ==============================================================================
# The upstream panel installers end with `docker compose logs -f`, which never
# returns. When nobody can press Ctrl-C (no terminal) or the run was started from a
# web-panel form, a tiny `docker` shim placed first on PATH drops -f/--follow that
# come AFTER the word `logs` (so `compose -f file` is untouched) and shows the
# last lines instead.
_make_logs_shim() { # -> echoes shim dir (empty if docker is absent)
  local real; real="$(command -v docker 2>/dev/null)"; [ -n "$real" ] || return 0
  local d; d="$(mktemp -d)" || return 0
  cat >"$d/docker" <<SHIM
#!/bin/sh
n=\$#; seen=0; dropped=0
for a do
  if [ \$seen -eq 1 ] && { [ "\$a" = "-f" ] || [ "\$a" = "--follow" ]; }; then
    dropped=1; set -- "\$@" "--tail=60"
  else
    set -- "\$@" "\$a"
  fi
  [ "\$a" = "logs" ] && seen=1
done
shift \$n
exec "$real" "\$@"
SHIM
  chmod 755 "$d/docker"
  printf '%s' "$d"
}

run_upstream() { # run_upstream URL [args...]
  local url="$1"; shift
  local tmp; tmp="$(mktemp)" || die "mktemp failed"
  info "fetching $(basename "$url")"
  curl -fsSL --retry 3 --max-time 120 -o "$tmp" "$url" || { rm -f "$tmp"; die "download failed: $url"; }
  sed -i 's/\r$//' "$tmp" 2>/dev/null || true
  local shim="" rc
  if [ -t 0 ]; then
    # A terminal is attached (SSH, or the web panel's interactive terminal), so
    # the official installer may ask its questions and the user answers them.
    # Form-driven web runs still drop the final `logs -f` so the task can end.
    [ "$NONINT" = "1" ] && shim="$(_make_logs_shim)"
    PATH="${shim:+$shim:}$PATH" bash "$tmp" "$@"
  else
    # no terminal at all (cron, pipes): nothing could answer a prompt
    shim="$(_make_logs_shim)"
    PATH="${shim:+$shim:}$PATH" bash "$tmp" "$@" </dev/null
  fi
  rc=$?
  rm -f "$tmp"; [ -n "$shim" ] && rm -rf "$shim"
  return $rc
}

# ==============================================================================
#  PANEL / NODE INSTALL
# ==============================================================================
# Do not blindly re-run an installer over something that is already there
# (installed by erispm or by hand). 0 = go ahead, 1 = skip.
_install_guard() { # key
  local key="$1" st
  is_installed "$key" || return 0
  if is_running "$key"; then st="installed and RUNNING"; else st="installed (stopped)"; fi
  warn "$(pretty_name "$key") is already $st on this server"
  if [ "${ERISPM_FORCE:-0}" = "1" ]; then info "--force given - running the official installer anyway"; return 0; fi
  if [ "$NONINT" = "1" ]; then
    info "skipped - nothing to do (add --force to reinstall/update through the official installer)"
    return 1
  fi
  confirm "Run the official installer anyway (reinstall / update)?" n && return 0
  info "kept the existing installation"
  return 1
}

install_panel() { # install_panel <key>
  local key="$1"
  need_root
  ensure_pkg curl
  _install_guard "$key" || return 0
  case "$key" in
    pasarguard)
      step "Installing PasarGuard panel"
      ensure_docker
      run_upstream "$URL_PASARGUARD" @ install ;;
    marzban)
      step "Installing Marzban panel"
      ensure_docker
      run_upstream "$URL_MARZBAN" @ install ;;
    marzneshin)
      step "Installing Marzneshin panel"
      ensure_docker
      run_upstream "$URL_MARZNESHIN" @ install ;;
    3x-ui)
      step "Installing 3x-ui (Sanaei) panel"
      run_upstream "$URL_3XUI" ;;
    *) die "unknown panel: $key" ;;
  esac
  local rc=$?
  if [ $rc -eq 0 ]; then
    conf_set "installed_$key" "$(date '+%F %T')"
    ok "$(pretty_name "$key") install finished"
    if [ "$key" != "3x-ui" ] && [ "$NONINT" != "1" ]; then
      confirm "Issue an SSL certificate for this panel's domain now?" y && cert_menu
    fi
  else
    bad "$(pretty_name "$key") installer returned $rc"
  fi
  return $rc
}

install_node() { # install_node <key>
  local key="$1"
  need_root
  ensure_pkg curl
  _install_guard "$key" || return 0
  ensure_docker
  case "$key" in
    pasarguard-node)
      step "Installing PasarGuard node"
      run_upstream "$URL_PG_NODE" @ install ;;
    marzban-node)
      step "Installing Marzban node"
      run_upstream "$URL_MARZBAN_NODE" @ install ;;
    marzneshin-node)
      step "Installing Marzneshin node"
      # Marzneshin ships node support through its main script. stderr stays
      # visible: `read -p` prompts are printed there.
      run_upstream "$URL_MARZNESHIN" @ install-node \
        || run_upstream "$URL_MARZNESHIN" @ node ;;
    *) die "unknown node: $key" ;;
  esac
  local rc=$?
  [ $rc -eq 0 ] && { conf_set "installed_$key" "$(date '+%F %T')"; ok "$(pretty_name "$key") node install finished"; } \
                || bad "$(pretty_name "$key") node installer returned $rc"
  return $rc
}

# ==============================================================================
#  CERTIFICATES  (acme.sh wrapper - Let's Encrypt / ZeroSSL)
# ==============================================================================
ACME="${HOME:-/root}/.acme.sh/acme.sh"
ensure_acme() {
  [ -x "$ACME" ] && return 0
  step "Installing acme.sh"
  ensure_pkg curl socat
  local email="$1"
  curl -fsSL https://get.acme.sh | sh -s email="${email:-admin@example.com}" >/dev/null 2>&1 \
    || die "acme.sh install failed"
  ACME="${HOME:-/root}/.acme.sh/acme.sh"
  "$ACME" --set-default-ca --server letsencrypt >/dev/null 2>&1 || true
  ok "acme.sh installed"
}

# Set KEY="value" in a panel .env, replacing any existing (even commented) line.
# spaced=1 -> `KEY = "value"` (Marzban/PasarGuard style); spaced=0 -> `KEY="value"`.
_env_set() {
  local f="$1" k="$2" v="$3" spaced="${4:-1}" tmp line
  [ -f "$f" ] || { warn "env file not found: $f"; return 1; }
  tmp="$(mktemp)"
  grep -vE "^[#[:space:]]*${k}[[:space:]]*=" "$f" >"$tmp" 2>/dev/null || true
  if [ "$spaced" = "1" ]; then line="${k} = \"${v}\""; else line="${k}=\"${v}\""; fi
  printf '%s\n' "$line" >>"$tmp"
  mv "$tmp" "$f"; chmod 600 "$f" 2>/dev/null || true
}

# Install a cert+key INTO a panel so its container/process can read it, set the
# panel's config to point at it, and restart the panel.
cert_apply_panel() { # key domain fullchain-src key-src
  local key="$1" domain="$2" fc="$3" kf="$4"
  is_installed "$key" || { warn "$(pretty_name "$key") is not installed - skipping"; return 1; }
  local mnt hostd contd
  mnt="$(panel_mount "$key")"; hostd="${mnt%%|*}"; contd="${mnt##*|}"
  [ -n "$hostd" ] || { warn "unknown data dir for $key"; return 1; }
  local hdir="$hostd/certs/$domain"   # where we write (host)
  local cdir="$contd/certs/$domain"   # what the panel sees (inside its container)
  mkdir -p "$hdir"
  install -m 0644 "$fc" "$hdir/fullchain.pem" || { bad "copy failed"; return 1; }
  install -m 0600 "$kf" "$hdir/privkey.pem"   || { bad "copy failed"; return 1; }
  if [ "$hdir" = "$cdir" ]; then
    ok "certificate placed in $hdir  (mounted into the panel at the same path)"
  else
    ok "certificate placed in $hdir  (seen inside the container as $cdir)"
  fi
  local envf="" envbak=""
  if panel_dockerized "$key"; then
    envf="$(panel_appdir "$key")/.env"
    [ -f "$envf" ] || { bad "$envf not found - cannot point the panel at the certificate"; return 1; }
    envbak="$envf.erispm-$(ts).bak"; cp -a "$envf" "$envbak"
  fi
  case "$key" in
    marzban|pasarguard)
      _env_set "$envf" UVICORN_SSL_CERTFILE "$cdir/fullchain.pem" 1
      _env_set "$envf" UVICORN_SSL_KEYFILE  "$cdir/privkey.pem"  1
      ok "pointed $(pretty_name "$key") at the new certificate in $envf" ;;
    marzneshin)
      _env_set "$envf" UVICORN_SSL_CERTFILE "$cdir/fullchain.pem" 0
      _env_set "$envf" UVICORN_SSL_KEYFILE  "$cdir/privkey.pem"  0
      ok "pointed Marzneshin at the new certificate in $envf" ;;
    3x-ui)
      if [ -x "$XUI_BIN" ] && "$XUI_BIN" cert -webCert "$cdir/fullchain.pem" -webCertKey "$cdir/privkey.pem" >/dev/null 2>&1; then
        ok "applied via '$XUI_BIN cert'"
      else
        warn "set it in the x-ui panel → Security:  public=$cdir/fullchain.pem  key=$cdir/privkey.pem"
      fi ;;
  esac
  info "restarting $(pretty_name "$key") to load the certificate"
  panel_restart "$key" || warn "the restart command reported an error"
  local healthy=1
  if panel_dockerized "$key"; then
    sleep 12; _panel_healthy "$key" || healthy=0
  else
    sleep 3; svc_active x-ui || healthy=0
  fi
  if [ $healthy -eq 1 ]; then
    ok "$(pretty_name "$key") is up with the new certificate"
  elif [ -n "$envbak" ]; then
    bad "$(pretty_name "$key") did not come up cleanly - rolling back $envf"
    cp -a "$envbak" "$envf"; panel_restart "$key"
    warn "rolled back; check the certificate/key and the panel logs"
    return 1
  else
    warn "$(pretty_name "$key") is not running - check it (systemctl status x-ui)"
    return 1
  fi
}

# App container of a compose panel is running and has not restarted since it
# was (re)created - i.e. it is not crash-looping on a bad certificate.
_panel_healthy() { # key
  local cid st
  cid="$(panel_compose "$1" ps -q "$1" 2>/dev/null | head -n1)"
  [ -n "$cid" ] || return 1
  st="$(docker inspect -f '{{.State.Status}} {{.RestartCount}}' "$cid" 2>/dev/null)"
  [ "${st%% *}" = "running" ] && [ "${st##* }" = "0" ]
}

# Apply the master copy of <domain>'s cert to one/many/all installed panels.
cert_apply_to() { # domain fullchain key apply("all"|"k1,k2"|key)
  local domain="$1" fc="$2" kf="$3" apply="$4" keys="" k applied=""
  if [ "$apply" = "all" ]; then
    for k in $PANEL_KEYS; do is_installed "$k" && keys="$keys $k"; done
  else
    keys="$(printf '%s' "$apply" | tr ',' ' ')"
  fi
  for k in $keys; do
    cert_apply_panel "$k" "$domain" "$fc" "$kf" && applied="$applied,$k"
  done
  applied="${applied#,}"
  if [ -n "$applied" ]; then
    conf_set "certbind_$domain" "$applied"
    ok "bound $domain → $applied (renewals re-apply automatically)"
  fi
}

# Re-apply after a renewal (called by acme.sh reloadcmd).
cert_sync() { # domain
  local domain="$1" keys k
  keys="$(conf_get "certbind_$domain" | tr ',' ' ')"
  [ -n "$keys" ] || { info "no panels bound to $domain"; return 0; }
  for k in $keys; do
    cert_apply_panel "$k" "$domain" "$CERT_DIR/$domain/fullchain.pem" "$CERT_DIR/$domain/privkey.pem"
  done
}

cert_issue() { # domain email method(standalone|nginx|webroot) [webroot] [apply]
  local domain="$1" email="$2" method="${3:-standalone}" webroot="${4:-/var/www/html}" apply="${5:-}"
  need_root
  [ -n "$domain" ] || die "domain required"
  ensure_acme "$email"
  local out="$CERT_DIR/$domain"; mkdir -p "$out"
  step "Issuing certificate for $domain  (method: $method)"
  case "$method" in
    standalone)
      if ss -lntp 2>/dev/null | grep -q ':80 '; then
        warn "port 80 is in use - the standalone method needs it free"
        confirm "Stop nginx temporarily and continue?" && { systemctl stop nginx 2>/dev/null || true; }
      fi
      "$ACME" --issue -d "$domain" --standalone --keylength ec-256 ${email:+--accountemail "$email"} ;;
    nginx)   "$ACME" --issue -d "$domain" --nginx --keylength ec-256 ${email:+--accountemail "$email"} ;;
    webroot) "$ACME" --issue -d "$domain" -w "$webroot" --keylength ec-256 ${email:+--accountemail "$email"} ;;
    *) die "unknown cert method: $method" ;;
  esac || { bad "issue failed - check DNS A/AAAA record points here ($(pub_ip)) and port 80 is reachable"; return 1; }
  "$ACME" --install-cert -d "$domain" --ecc \
    --key-file       "$out/privkey.pem" \
    --fullchain-file "$out/fullchain.pem" \
    --reloadcmd      "$SELF cert sync $domain >/dev/null 2>&1; systemctl reload nginx 2>/dev/null || true"
  ok "certificate saved:"
  printf '      %sfullchain:%s %s\n' "$D" "$N" "$out/fullchain.pem"
  printf '      %sprivate  :%s %s\n' "$D" "$N" "$out/privkey.pem"
  conf_set "cert_$domain" "$(date '+%F %T')"
  if [ -n "$apply" ] && [ "$apply" != "none" ]; then
    cert_apply_to "$domain" "$out/fullchain.pem" "$out/privkey.pem" "$apply"
  else
    info "auto-renewal is handled by acme.sh cron; apply it to a panel with:  erispm cert apply --domain $domain --panel <key>"
  fi
}

# Import an EXISTING cert+key (manual), validate it, store it, optionally apply.
cert_import() { # domain fullchain-file key-file [apply]
  local domain="$1" fc="$2" kf="$3" apply="${4:-}"
  need_root
  [ -n "$domain" ] && [ -f "$fc" ] && [ -f "$kf" ] || die "need: domain + existing cert file + key file"
  ensure_pkg openssl
  step "Importing certificate for $domain"
  openssl x509 -in "$fc" -noout >/dev/null 2>&1 || die "the certificate file is not valid PEM"
  local cpk kpk
  cpk="$(openssl x509 -in "$fc" -noout -pubkey 2>/dev/null)"
  kpk="$(openssl pkey -in "$kf" -pubout 2>/dev/null)"
  [ -n "$cpk" ] && [ "$cpk" = "$kpk" ] || die "the private key does not match the certificate"
  ok "certificate and key match"
  local out="$CERT_DIR/$domain"; mkdir -p "$out"
  install -m 0644 "$fc" "$out/fullchain.pem"
  install -m 0600 "$kf" "$out/privkey.pem"
  ok "stored master copy in $out"
  conf_set "cert_$domain" "$(date '+%F %T') (manual import)"
  if [ -n "$apply" ] && [ "$apply" != "none" ]; then
    cert_apply_to "$domain" "$out/fullchain.pem" "$out/privkey.pem" "$apply"
  fi
}

cert_list() {
  step "Certificates"
  if [ -x "$ACME" ]; then "$ACME" --list 2>/dev/null; fi
  local d dom bind
  for d in "$CERT_DIR"/*/; do
    [ -d "$d" ] || continue
    dom="$(basename "$d")"
    bind="$(conf_get "certbind_$dom")"
    printf '  %s·%s %-28s %s\n' "$C" "$N" "$dom" "${bind:+${D}→ $bind${N}}"
  done
}

# ==============================================================================
#  BACKUP  &  RESTORE
# ==============================================================================
# Each panel: tar its config dir + data dir; dump the DB if it runs in its own
# container (MySQL / MariaDB / PostgreSQL / TimescaleDB).
ts() { date '+%Y%m%d-%H%M%S'; }

# "name|mysql" or "name|postgres" for the DB container of a compose project.
_db_container() { # appdir
  local proj; proj="$(basename "$1")"
  have docker || return 0
  docker ps --filter "label=com.docker.compose.project=$proj" --format '{{.Names}}|{{.Image}}' 2>/dev/null \
    | while IFS='|' read -r n img; do
        case "$img" in
          *mariadb*|*mysql*)       printf '%s|mysql\n' "$n"; break ;;
          *timescale*|*postgres*)  printf '%s|postgres\n' "$n"; break ;;
        esac
      done
}

# Credentials are read from the DB container's OWN environment, so they are
# right whatever the panel's .env calls them (and never land on a command line).
_dump_sql_if_any() { # appdir stagedir
  local work="$1" stage="$2" hit name kind
  hit="$(_db_container "$work")"; [ -n "$hit" ] || return 0
  name="${hit%%|*}"; kind="${hit##*|}"
  info "dumping the $kind database from container $name"
  if [ "$kind" = "mysql" ]; then
    local pw; pw="$(docker exec "$name" sh -c 'printf %s "${MYSQL_ROOT_PASSWORD:-${MARIADB_ROOT_PASSWORD:-}}"' 2>/dev/null)"
    if docker exec -e MYSQL_PWD="$pw" "$name" sh -c \
         'if command -v mariadb-dump >/dev/null 2>&1; then D=mariadb-dump; else D=mysqldump; fi; $D -uroot --all-databases --single-transaction --routines --events' \
         >"$stage/all-databases.sql" 2>/dev/null && [ -s "$stage/all-databases.sql" ]; then
      echo mysql >"$stage/db-type"; ok "SQL dump captured"
    else
      rm -f "$stage/all-databases.sql"; warn "SQL dump failed (continuing with files only)"
    fi
  else
    local u; u="$(docker exec "$name" sh -c 'printf %s "${POSTGRES_USER:-postgres}"' 2>/dev/null)"
    if docker exec "$name" pg_dumpall -U "${u:-postgres}" >"$stage/all-databases.sql" 2>/dev/null \
         && [ -s "$stage/all-databases.sql" ]; then
      echo postgres >"$stage/db-type"; ok "PostgreSQL dump captured"
    else
      rm -f "$stage/all-databases.sql"; warn "PostgreSQL dump failed (continuing with files only)"
    fi
  fi
}
_stage_args() { [ -s "$1/all-databases.sql" ] && printf -- '-C %s all-databases.sql db-type' "$1"; }

backup_panel() { # backup_panel <key> [outdir] -> prints archive path
  local key="$1" outdir="${2:-$BACKUP_DIR}"
  need_root
  mkdir -p "$outdir"
  local stamp; stamp="$(ts)"
  local stage; stage="$(mktemp -d)"; local arch="$outdir/${key}-${stamp}.tar.gz"
  step "Backing up $(pretty_name "$key")"
  case "$key" in
    marzban)
      [ -d /var/lib/marzban ] && { sqlite3 /var/lib/marzban/db.sqlite3 'PRAGMA wal_checkpoint(TRUNCATE);' 2>/dev/null || true; }
      _dump_sql_if_any /opt/marzban "$stage"
      tar -C / -czf "$arch" --ignore-failed-read \
          $( [ -d /opt/marzban ]     && echo opt/marzban ) \
          $( [ -d /var/lib/marzban ] && echo var/lib/marzban ) \
          $(_stage_args "$stage") 2>/dev/null ;;
    marzneshin)
      [ -d /var/lib/marzneshin ] && { sqlite3 /var/lib/marzneshin/db.sqlite3 'PRAGMA wal_checkpoint(TRUNCATE);' 2>/dev/null || true; }
      _dump_sql_if_any /etc/opt/marzneshin "$stage"
      tar -C / -czf "$arch" --ignore-failed-read \
          $( [ -d /etc/opt/marzneshin ] && echo etc/opt/marzneshin ) \
          $( [ -d /var/lib/marzneshin ] && echo var/lib/marzneshin ) \
          $( [ -d /var/lib/marznode ]   && echo var/lib/marznode ) \
          $(_stage_args "$stage") 2>/dev/null ;;
    pasarguard)
      [ -d /var/lib/pasarguard ] && { sqlite3 /var/lib/pasarguard/db.sqlite3 'PRAGMA wal_checkpoint(TRUNCATE);' 2>/dev/null || true; }
      _dump_sql_if_any /opt/pasarguard "$stage"
      tar -C / -czf "$arch" --ignore-failed-read \
          $( [ -d /opt/pasarguard ]     && echo opt/pasarguard ) \
          $( [ -d /var/lib/pasarguard ] && echo var/lib/pasarguard ) \
          $(_stage_args "$stage") 2>/dev/null ;;
    3x-ui)
      tar -C / -czf "$arch" --ignore-failed-read \
          $( [ -d /etc/x-ui ]       && echo etc/x-ui ) \
          $( [ -d /usr/local/x-ui ] && echo usr/local/x-ui ) 2>/dev/null ;;
    *) rm -rf "$stage"; die "unknown panel: $key" ;;
  esac
  rm -rf "$stage"
  if [ -s "$arch" ]; then
    local sz; sz="$(du -h "$arch" | cut -f1)"
    sha256sum "$arch" | cut -d' ' -f1 >"$arch.sha256"
    ok "archive: $arch  (${sz})"
    printf '%s\n' "$arch"
  else
    bad "nothing captured - is $(pretty_name "$key") installed?"; return 1
  fi
}

restore_panel() { # restore_panel <key> <archive>
  local key="$1" arch="$2"
  need_root
  [ -f "$arch" ] || die "archive not found: $arch"
  step "Restoring $(pretty_name "$key") from $(basename "$arch")"
  if [ -f "$arch.sha256" ]; then
    (cd "$(dirname "$arch")" && sha256sum -c "$(basename "$arch").sha256" >/dev/null 2>&1) \
      && ok "checksum verified" || warn "checksum missing/failed - continuing"
  fi
  # stop the stack so files are not held open
  panel_stop "$key" || true
  local tmp; tmp="$(mktemp -d)"
  tar -xzf "$arch" -C "$tmp" || { rm -rf "$tmp"; die "extract failed"; }
  # copy directories back into place
  ( cd "$tmp" && for d in opt/* var/lib/* etc/* usr/local/*; do
      [ -e "$d" ] || continue
      mkdir -p "/$(dirname "$d")"
      cp -a "$d" "/$(dirname "$d")/"
    done ) 2>/dev/null
  # if a database dump is present, start the stack and load it into the DB container
  if [ -s "$tmp/all-databases.sql" ]; then
    info "database dump present - starting the stack, then importing"
    panel_start "$key" || true
    sleep 10
    local hit name kind
    hit="$(_db_container "$(panel_appdir "$key")")"
    name="${hit%%|*}"; kind="${hit##*|}"
    if [ -z "$hit" ]; then
      warn "no database container is running for $(pretty_name "$key") - dump left unimported"
    elif [ "$kind" = "mysql" ]; then
      local pw; pw="$(docker exec "$name" sh -c 'printf %s "${MYSQL_ROOT_PASSWORD:-${MARIADB_ROOT_PASSWORD:-}}"' 2>/dev/null)"
      docker exec -i -e MYSQL_PWD="$pw" "$name" sh -c \
        'if command -v mariadb >/dev/null 2>&1; then mariadb -uroot; else mysql -uroot; fi' <"$tmp/all-databases.sql" \
        && ok "SQL imported" || warn "SQL import failed - check the database container"
    else
      local u; u="$(docker exec "$name" sh -c 'printf %s "${POSTGRES_USER:-postgres}"' 2>/dev/null)"
      docker exec -i "$name" psql -q -U "${u:-postgres}" -d postgres <"$tmp/all-databases.sql" >/dev/null 2>&1 \
        && ok "PostgreSQL imported" || warn "PostgreSQL import reported errors (existing roles/objects are expected)"
    fi
  fi
  rm -rf "$tmp"
  panel_restart "$key" || panel_start "$key" || true
  ok "$(pretty_name "$key") restore finished"
}

# ==============================================================================
#  DELETE  /  UNINSTALL
# ==============================================================================
delete_panel() { # delete_panel <key> [--purge]
  local key="$1" purge="${2:-}"
  need_root
  if [ "$ASSUME_YES" != "1" ]; then
    confirm "A fresh backup will be taken first. Remove $(pretty_name "$key")?" || { info "cancelled"; return 1; }
  fi
  backup_panel "$key" >/dev/null 2>&1 && ok "safety backup saved to $BACKUP_DIR" || warn "safety backup skipped"
  step "Removing $(pretty_name "$key")"
  case "$key" in
    pasarguard) run_upstream "$URL_PASARGUARD" @ uninstall ;;
    marzban)    run_upstream "$URL_MARZBAN"    @ uninstall ;;
    marzneshin) run_upstream "$URL_MARZNESHIN" @ uninstall ;;
    3x-ui)
      if have x-ui; then echo y | x-ui uninstall 2>/dev/null || warn "run 'x-ui' → uninstall manually"; fi ;;
    pasarguard-node) run_upstream "$URL_PG_NODE"      @ uninstall ;;
    marzban-node)    run_upstream "$URL_MARZBAN_NODE" @ uninstall ;;
    marzneshin-node) run_upstream "$URL_MARZNESHIN"   @ uninstall-node || true ;;
    *) die "unknown target: $key" ;;
  esac
  if [ "$purge" = "--purge" ]; then
    warn "purging data directories"
    case "$key" in
      pasarguard) rm -rf /opt/pasarguard /var/lib/pasarguard ;;
      marzban)    rm -rf /opt/marzban /var/lib/marzban ;;
      marzneshin) rm -rf /etc/opt/marzneshin /var/lib/marzneshin ;;
      3x-ui)      rm -rf /etc/x-ui /usr/local/x-ui ;;
    esac
  fi
  conf_set "installed_$key" ""
  ok "$(pretty_name "$key") removed (backup kept in $BACKUP_DIR)"
}

# ==============================================================================
#  MIGRATION  (this server = SOURCE, push to a new DESTINATION over SSH)
# ==============================================================================
# Strategy: backup locally -> scp archive to dest -> on dest install erispm +
# the same panel, then restore. Works per-panel or for everything at once.
SSH_OPTS="-o StrictHostKeyChecking=accept-new -o ConnectTimeout=12"

_ssh() { # _ssh host port user [pass] -- cmd...
  local host="$1" port="$2" user="$3" pass="$4"; shift 4
  if [ -n "$pass" ]; then
    ensure_pkg sshpass
    sshpass -p "$pass" ssh $SSH_OPTS -p "$port" "$user@$host" "$@"
  else
    ssh $SSH_OPTS -p "$port" "$user@$host" "$@"
  fi
}
_scp() { # _scp host port user pass localfile remotepath
  local host="$1" port="$2" user="$3" pass="$4" lf="$5" rp="$6"
  if [ -n "$pass" ]; then
    ensure_pkg sshpass
    sshpass -p "$pass" scp $SSH_OPTS -P "$port" "$lf" "$user@$host:$rp"
  else
    scp $SSH_OPTS -P "$port" "$lf" "$user@$host:$rp"
  fi
}

migrate_panels() { # migrate_panels "host" "port" "user" "pass" "key1 key2 ..." [--dry-run]
  local host="$1" port="$2" user="$3" pass="$4" keys="$5" dry="${6:-}"
  need_root
  [ -n "$host" ] || die "destination host required"
  step "Pre-flight: checking SSH to $user@$host:$port"
  _ssh "$host" "$port" "$user" "$pass" "echo ok" 2>/dev/null | grep -q ok \
    || die "cannot SSH to destination - check host/port/credentials"
  ok "SSH reachable"

  info "ensuring erispm is installed on the destination"
  if [ "$dry" != "--dry-run" ]; then
    _ssh "$host" "$port" "$user" "$pass" \
      "command -v erispm >/dev/null 2>&1 || curl -fsSL $RAW_SELF -o /usr/local/bin/erispm && chmod +x /usr/local/bin/erispm" \
      2>/dev/null || warn "could not pre-install erispm on dest (will still try restore)"
  fi

  local key arch rpath
  for key in $keys; do
    is_installed "$key" || { warn "$(pretty_name "$key") not installed here - skipping"; continue; }
    hr 56
    step "Migrating $(pretty_name "$key") → $host"
    if [ "$dry" = "--dry-run" ]; then
      info "[dry-run] would backup, scp, install $(pretty_name "$key") on dest, and restore"
      continue
    fi
    arch="$(backup_panel "$key" | tail -n1)"
    [ -f "$arch" ] || { bad "backup failed for $key"; continue; }
    rpath="/tmp/$(basename "$arch")"
    info "copying archive to destination"
    _scp "$host" "$port" "$user" "$pass" "$arch" "$rpath" || { bad "scp failed for $key"; continue; }
    _scp "$host" "$port" "$user" "$pass" "$arch.sha256" "$rpath.sha256" 2>/dev/null || true
    info "installing $(pretty_name "$key") on destination"
    _ssh "$host" "$port" "$user" "$pass" "ERISPM_YES=1 erispm install-panel $key" 2>/dev/null \
      || warn "remote install reported an issue - trying restore anyway"
    info "restoring on destination"
    _ssh "$host" "$port" "$user" "$pass" "ERISPM_YES=1 erispm restore $key $rpath" \
      && ok "$(pretty_name "$key") migrated" || bad "restore failed on destination for $key"
  done
  hr 56
  ok "migration run complete"
  warn "remember: point your domain's DNS to the new server, then re-issue certificates there (erispm → Certificates)"
}

# ==============================================================================
#  TUNNELS
# ==============================================================================
tunnel_install() { # tunnel_install <spoof|spoof-tester|eris-tunnel-2>
  local what="$1"
  need_root
  ensure_pkg curl
  case "$what" in
    spoof|spoof-tunnel|spoof-tester)
      step "Installing Spoof Tunnel  (core + built-in Spoof Tester + web GUI)"
      if [ -x /usr/local/bin/spoof-panel ] || [ -f "$SPOOF_UNIT" ]; then
        # The official installer picks a NEW random port and adds another login on
        # every run, so an existing Spoof panel is left exactly as it is.
        ok "the Spoof panel is already installed - its port, login and tunnels stay as they are"
        info "open it inside the erispm web panel: Spoof panel tab (or Tunnels → Open Spoof panel)"
        if [ "${ERISPM_FORCE:-0}" != "1" ]; then
          # only an explicit --force or a person at the prompt replaces it (-y does not)
          if [ "$NONINT" = "1" ] || [ "$ASSUME_YES" = "1" ] \
             || ! confirm "Run the official installer again anyway (new port + new login)?" n; then
            info "to reinstall it anyway: erispm tunnel install spoof --force"
            return 0
          fi
        fi
        warn "running the official installer again - the panel will get a new port and login"
      fi
      info "the Spoof Tester is bundled inside the Spoof Tunnel core and panel"
      run_upstream "$URL_SPOOF" || return $?
      info "its original panel also opens inside the erispm web panel: Spoof panel tab" ;;
    eris-tunnel-2|eristun2)
      step "Installing Eris Tunnel 2"
      if [ "$NONINT" = "1" ]; then
        # Its installer finishes by opening the menu on /dev/tty, which does not
        # exist under the web panel's systemd service - install the same way
        # without launching the TUI.
        _install_eristun2_headless
      else
        run_upstream "$URL_ERISTUN2"
      fi ;;
    *) die "unknown tunnel: $what" ;;
  esac
}

_install_eristun2_headless() {
  local raw="https://raw.githubusercontent.com/eris4444/eris-tunnel-2/main/eris-tunnel-2.sh"
  local dest="/usr/local/bin/eristun2" base="/etc/eris-tunnel-2" tmp ver
  tmp="$(mktemp)" || die "mktemp failed"
  info "downloading Eris Tunnel 2 manager"
  curl -fsSL --retry 3 --max-time 90 -o "$tmp" "$raw" || { rm -f "$tmp"; bad "download failed"; return 1; }
  sed -i 's/\r$//' "$tmp" 2>/dev/null || true
  grep -q 'ERIS-TUNNEL-2-SCRIPT' "$tmp" || { rm -f "$tmp"; bad "downloaded file is not Eris Tunnel 2"; return 1; }
  bash -n "$tmp" 2>/dev/null       || { rm -f "$tmp"; bad "downloaded file has syntax errors"; return 1; }
  ver="$(grep -m1 '^SCRIPT_VER=' "$tmp" | cut -d'"' -f2)"
  mkdir -p "$base" && chmod 700 "$base"
  [ -f "$dest" ] && cp -f "$dest" "$dest.bak" 2>/dev/null
  install -m 0755 "$tmp" "$dest" || { rm -f "$tmp"; bad "could not write $dest"; return 1; }
  echo "$raw" >"$base/update.url"
  rm -f "$tmp"
  ok "Eris Tunnel 2 v${ver:-?} installed to $dest"
  info "it is an interactive manager - open it from an SSH terminal with:  eristun2"
}

# Quick check: can this host emit spoofed-source packets to your other server?
# Safe and temporary (one SNAT rule + a short ICMP burst, both removed right away).
# With SSH to the target it runs tcpdump THERE and reports PASS/FAIL automatically;
# without SSH it falls back to the manual "watch tcpdump yourself" hint.
_spoof_send_burst() { # _spoof_send_burst target spoof_ip count
  iptables -t nat -A POSTROUTING -d "$1" -j SNAT --to-source "$2"
  ping -c"${3:-6}" -i 0.5 -W2 "$1" >/dev/null 2>&1 || true
  iptables -t nat -D POSTROUTING -d "$1" -j SNAT --to-source "$2" 2>/dev/null || true
}

spoof_quickcheck() {
  need_root
  ensure_pkg iptables
  step "Spoof capability quick check"
  info "for a full, accurate test use: erispm tunnel install spoof  (then the built-in Spoof Tester)"
  local tgt spf
  tgt="$(ask 'target IP / host (your other server)')"
  spf="$(ask 'spoof source IP to try' '1.1.1.1')"
  [ -n "$tgt" ] && [ -n "$spf" ] || { warn "need both the target and a spoof source IP"; return 1; }

  local auto="" host port user pass
  if confirm "Auto-check the result over SSH on the target (runs tcpdump there)?" y; then
    host="$(ask 'SSH host of the target' "$tgt")"
    user="$(ask 'SSH user' 'root')"
    port="$(ask 'SSH port' '22')"
    pass="$(ask_secret 'SSH password (blank = use your key)')"
    info "checking SSH to $user@$host:$port"
    if _ssh "$host" "$port" "$user" "$pass" "echo ok" 2>/dev/null | grep -q ok; then
      auto=1
    else
      warn "could not SSH to $host - falling back to the manual check"
    fi
  fi

  if [ -n "$auto" ]; then
    local capout cappid out
    capout="$(mktemp)"
    info "capturing on $host and sending a spoofed ICMP burst from here (source $spf -> $tgt)"
    # count ICMP packets arriving at the target with our spoofed source (bounded)
    _ssh "$host" "$port" "$user" "$pass" \
      "if command -v tcpdump >/dev/null 2>&1; then timeout 12 tcpdump -ni any -c 10 'icmp and src host $spf' 2>/dev/null | wc -l; else echo NO_TCPDUMP; fi" \
      >"$capout" 2>/dev/null &
    cappid=$!
    sleep 4                                   # let the SSH connect and tcpdump start first
    _spoof_send_burst "$tgt" "$spf" 6
    wait "$cappid" 2>/dev/null || true
    # keep only digits / A-Z / underscore -> a bare number, or NO_TCPDUMP, or empty
    out="$(tail -n1 "$capout" 2>/dev/null | tr -cd '0-9A-Z_')"; rm -f "$capout"
    if [ "$out" = "NO_TCPDUMP" ]; then
      warn "tcpdump is not installed on $host - install it there (apt/dnf/apk install tcpdump) and retry"
    elif [ -n "$out" ] && [ "$out" -gt 0 ] 2>/dev/null; then
      ok "PASS - $host received $out packet(s) from $spf"
      info "this server CAN spoof $spf toward $tgt - put $spf in this side Spoof IP list (direction: here -> $tgt)"
    elif [ -n "$out" ]; then
      bad "FAIL - $host received no packets from $spf"
      info "your provider likely blocks spoofed sources (egress filtering), or $spf is filtered on the path"
      info "try other source IPs; when none arrive, this server cannot spoof"
    else
      warn "could not read the capture result from $host (SSH or tcpdump issue) - try the manual check"
    fi
  else
    ensure_pkg tcpdump
    info "on $tgt run:   tcpdump -ni any icmp and src host $spf"
    info "then come back here and press Enter to send the spoofed burst"
    [ "$NONINT" = "1" ] || { printf '  %s»%s ready? press Enter ' "$C" "$N"; read -r _ </dev/tty || true; }
    info "sending a temporary spoofed ICMP burst (source $spf -> $tgt)"
    _spoof_send_burst "$tgt" "$spf" 5
    ok "done - when tcpdump on $tgt showed packets from $spf, this side can spoof"
    info "note: the local ping shows ~100% loss - that is normal (replies go to $spf, not here)"
  fi
  info "this tests ONE direction and ONE IP; the Spoof Tester checks many IPs per direction"
}

# ==============================================================================
#  WEB PANEL  (Python 3 standard library - no pip)
# ==============================================================================
WEB_PORT_DEFAULT="8787"
web_fetch_assets() { # [force] - force re-downloads every file (used by updates)
  local force="${1:-}" f tmp fail=0
  mkdir -p "$WEB_DIR/static"
  for f in server.py static/index.html static/login.html static/app.css static/app.js static/term.js static/spoof.js; do
    [ -z "$force" ] && [ -f "$WEB_DIR/$f" ] && continue
    tmp="$(mktemp)"
    # download to a temp file first so a failed fetch never wipes a working file
    if curl -fsSL --retry 3 --max-time 60 "$RAW_WEB_BASE/$f" -o "$tmp" 2>/dev/null && [ -s "$tmp" ]; then
      install -m 0644 "$tmp" "$WEB_DIR/$f"
    else
      fail=1
    fi
    rm -f "$tmp"
  done
  return $fail
}

web_write_unit() {
  cat >/etc/systemd/system/eris-panel-web.service <<UNIT
[Unit]
Description=Eris Panel Manager - Web Panel
After=network.target

[Service]
Type=simple
Environment=ERISPM_CONF=$CONF
Environment=HOME=/root
ExecStart=/usr/bin/python3 $WEB_DIR/server.py
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
}

# Refresh the web panel in place (new assets + unit), keeping port/user/password.
web_update() {
  need_root
  step "Updating the web panel"
  web_fetch_assets force && ok "web assets refreshed" || warn "some web files could not be downloaded (kept the old ones)"
  if [ -f /etc/systemd/system/eris-panel-web.service ]; then
    web_write_unit
    # --no-block: if this runs FROM the web panel, the restart must not cut our own output first
    systemctl --no-block restart eris-panel-web.service >/dev/null 2>&1 && ok "web panel restarting with the new version"
  else
    info "web panel not installed yet - run: erispm web install"
  fi
}

web_install() {
  need_root
  ensure_pkg python3 openssl
  conf_init
  web_fetch_assets
  [ -f "$WEB_DIR/server.py" ] || die "web assets missing - re-run the installer"

  local port user pass
  port="$(conf_get web_port)"; [ -n "$port" ] || port="$WEB_PORT_DEFAULT"
  port="$(ask 'web panel port' "$port")"
  user="$(ask 'admin username' "$(conf_get web_user)")"; user="${user:-admin}"
  if [ "$NONINT" = "1" ]; then
    pass="${ERISPM_WEB_PASS:-$(conf_get web_pass_plain)}"
  else
    pass="$(ask_secret 'admin password (blank = generate a strong one)')"
  fi
  [ -n "$pass" ] || pass="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 16)"

  # TLS (self-signed) - optional
  local use_tls="n"
  confirm "Serve over HTTPS with a self-signed certificate?" y && use_tls="y"
  if [ "$use_tls" = "y" ]; then
    mkdir -p "$WEB_DIR/tls"
    [ -f "$WEB_DIR/tls/key.pem" ] || openssl req -x509 -newkey rsa:2048 -nodes \
      -keyout "$WEB_DIR/tls/key.pem" -out "$WEB_DIR/tls/cert.pem" -days 825 \
      -subj "/CN=eris-panel-manager" >/dev/null 2>&1
  fi

  # store config (password hashed with a random salt)
  local salt hash
  salt="$(head -c 12 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 16)"
  hash="$(printf '%s%s' "$salt" "$pass" | sha256sum | cut -d' ' -f1)"
  conf_set web_port "$port"
  conf_set web_user "$user"
  conf_set web_salt "$salt"
  conf_set web_hash "$hash"
  conf_set web_tls  "$use_tls"
  local secret; secret="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)"
  conf_set web_secret "$secret"

  # systemd unit
  web_write_unit
  systemctl enable --now eris-panel-web.service >/dev/null 2>&1
  systemctl restart eris-panel-web.service >/dev/null 2>&1 || true
  sleep 1
  local scheme="http"; [ "$use_tls" = "y" ] && scheme="https"
  hr 56
  ok "Web panel is live"
  printf '      %sURL     %s %s://%s:%s\n' "$D" "$N" "$scheme" "$(pub_ip)" "$port"
  printf '      %suser    %s %s\n' "$D" "$N" "$user"
  printf '      %spass    %s %s%s%s\n' "$D" "$N" "$Y" "$pass" "$N"
  hr 56
  warn "open the firewall for port $port if needed (ufw allow $port)"
}

web_ctl() { # web_ctl start|stop|restart|status
  need_root
  case "$1" in
    start)   systemctl start  eris-panel-web && ok "web panel started" ;;
    stop)    systemctl stop   eris-panel-web && ok "web panel stopped" ;;
    restart) systemctl restart eris-panel-web && ok "web panel restarted" ;;
    status)  systemctl status eris-panel-web --no-pager -l 2>/dev/null || warn "not installed" ;;
    url)
      local scheme="http"; [ "$(conf_get web_tls)" = "y" ] && scheme="https"
      printf '%s://%s:%s\n' "$scheme" "$(pub_ip)" "$(conf_get web_port)" ;;
    *) die "web: start|stop|restart|status|url|install" ;;
  esac
}

web_passwd() {
  need_root; conf_init
  local pass salt hash
  pass="$(ask_secret 'new admin password')"
  [ -n "$pass" ] || die "empty password"
  salt="$(head -c 12 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 16)"
  hash="$(printf '%s%s' "$salt" "$pass" | sha256sum | cut -d' ' -f1)"
  conf_set web_salt "$salt"; conf_set web_hash "$hash"
  systemctl restart eris-panel-web 2>/dev/null || true
  ok "password updated"
}

# ==============================================================================
#  SELF UPDATE
# ==============================================================================
self_update() {
  need_root
  step "Updating erispm"
  local tmp; tmp="$(mktemp)"
  curl -fsSL --retry 3 -o "$tmp" "$RAW_SELF" || { rm -f "$tmp"; die "download failed"; }
  sed -i 's/\r$//' "$tmp" 2>/dev/null || true
  grep -q "$MARKER" "$tmp" || { rm -f "$tmp"; die "downloaded file is not erispm"; }
  bash -n "$tmp" || { rm -f "$tmp"; die "downloaded file has syntax errors"; }
  # bash reads a running script lazily, so never rewrite it in place: put the
  # new copy next to it and rename (the running process keeps the old inode).
  install -m 0755 "$tmp" "$SELF.new" && mv -f "$SELF.new" "$SELF"; rm -f "$tmp"
  ok "erispm updated to v$(grep -m1 '^SCRIPT_VER=' "$SELF" | cut -d'"' -f2)"
  # this process still holds the OLD functions - let the new copy do the web part
  "$SELF" web update
}

# ==============================================================================
#  JSON API  (used by the web panel - no interaction)
# ==============================================================================
json_status() {
  local first=1 k
  printf '{"server":"%s","version":"%s","panels":[' "$(pub_ip)" "$SCRIPT_VER"
  for k in $PANEL_KEYS $NODE_KEYS spoof-tunnel eris-tunnel-2; do
    [ $first -eq 1 ] || printf ','; first=0
    local inst=false run=false
    is_installed "$k" && inst=true
    is_running   "$k" && run=true
    printf '{"key":"%s","name":"%s","installed":%s,"running":%s}' \
      "$k" "$(pretty_name "$k")" "$inst" "$run"
  done
  printf ']}\n'
}

# ==============================================================================
#  INTERACTIVE MENUS
# ==============================================================================
_pick() { # _pick title "a:Label" "b:Label" ... ; echoes chosen key
  local title="$1"; shift
  local -a keys labels; local i=1 entry
  for entry in "$@"; do keys+=("${entry%%:*}"); labels+=("${entry#*:}"); done
  printf '\n  %s%s%s\n' "$BOLD" "$title" "$N" >&2
  for i in "${!keys[@]}"; do
    printf '    %s%2d%s) %s\n' "$C" "$((i+1))" "$N" "${labels[$i]}" >&2
  done
  printf '    %s 0%s) back\n' "$D" "$N" >&2
  local sel; sel="$(ask 'choose')"
  [ "$sel" = "0" ] && { printf ''; return; }
  case "$sel" in ''|*[!0-9]*) printf ''; return;; esac
  [ "$sel" -ge 1 ] && [ "$sel" -le "${#keys[@]}" ] && printf '%s' "${keys[$((sel-1))]}"
}

menu_install() {
  while :; do
    banner; dashboard
    local k; k="$(_pick 'Install a panel / node' \
      "pasarguard:PasarGuard panel" "marzban:Marzban panel" \
      "marzneshin:Marzneshin panel" "3x-ui:3x-ui (Sanaei) panel" \
      "pasarguard-node:PasarGuard node" "marzban-node:Marzban node" \
      "marzneshin-node:Marzneshin node")"
    [ -z "$k" ] && return
    case "$k" in
      *-node) install_node "$k" ;;
      *)      install_panel "$k" ;;
    esac
    pause
  done
}

menu_delete() {
  while :; do
    banner; dashboard
    local k; k="$(_pick 'Remove a panel / node' \
      "pasarguard:PasarGuard" "marzban:Marzban" "marzneshin:Marzneshin" "3x-ui:3x-ui" \
      "pasarguard-node:PasarGuard node" "marzban-node:Marzban node" "marzneshin-node:Marzneshin node")"
    [ -z "$k" ] && return
    local purge=""
    confirm "Also purge its data directory (irreversible)?" && purge="--purge"
    delete_panel "$k" "$purge"
    pause
  done
}

menu_backup() {
  while :; do
    banner
    local k; k="$(_pick 'Backup a panel database' \
      "pasarguard:PasarGuard" "marzban:Marzban" "marzneshin:Marzneshin" "3x-ui:3x-ui" \
      "ALL:Backup everything installed")"
    [ -z "$k" ] && return
    if [ "$k" = "ALL" ]; then
      local p; for p in $PANEL_KEYS; do is_installed "$p" && backup_panel "$p" >/dev/null; done
      ok "all installed panels backed up to $BACKUP_DIR"
    else
      backup_panel "$k" >/dev/null
    fi
    pause
  done
}

menu_restore() {
  banner
  step "Restore"
  ls -1 "$BACKUP_DIR"/*.tar.gz 2>/dev/null | nl -w2 -s') ' || { warn "no backups in $BACKUP_DIR"; pause; return; }
  local f; f="$(ask 'full path of archive to restore')"
  [ -f "$f" ] || { bad "not found"; pause; return; }
  local key; key="$(basename "$f" | cut -d- -f1)"
  key="$(ask 'panel key for this archive' "$key")"
  restore_panel "$key" "$f"
  pause
}

menu_cert() { cert_menu; }

_read_until_end() { local line; while IFS= read -r line </dev/tty; do [ "$line" = "END" ] && break; printf '%s\n' "$line"; done; }

_pick_cert_target() { # echoes apply spec: none | all | <key>
  local sel; sel="$(_pick 'Apply the certificate to which panel?' \
    "none:Just save it, do not apply to a panel" \
    "all:All installed panels" \
    "marzban:Marzban" "pasarguard:PasarGuard" "marzneshin:Marzneshin" "3x-ui:3x-ui (Sanaei)")"
  printf '%s' "${sel:-none}"
}

cert_menu() {
  while :; do
    banner
    local a; a="$(_pick 'SSL certificates' \
      "issue:Get a NEW certificate (Let's Encrypt / ZeroSSL) + auto-apply" \
      "import:Import an EXISTING certificate (paste or files) + apply" \
      "apply:Apply a stored certificate to a panel" \
      "list:List certificates & what they are applied to" \
      "sync:Re-apply a certificate now (after a manual renew)")"
    [ -z "$a" ] && return
    case "$a" in
      issue)  cert_menu_issue ;;
      import) cert_menu_import ;;
      apply)  cert_menu_apply ;;
      list)   cert_list; pause ;;
      sync)   local d; d="$(ask 'domain to re-apply')"; [ -n "$d" ] && cert_sync "$d"; pause ;;
    esac
  done
}

cert_menu_issue() {
  banner; step "Get a new certificate"
  local domain email method wr tgt
  domain="$(ask 'domain (e.g. panel.example.com)')"; [ -n "$domain" ] || return
  email="$(ask 'email for the ACME account' "$(conf_get acme_email)")"
  [ -n "$email" ] && conf_set acme_email "$email"
  local m; m="$(_pick 'validation method' \
    "standalone:standalone (needs port 80 free)" \
    "nginx:nginx (auto-edits your nginx)" \
    "webroot:webroot (serve from a folder)")"
  method="${m:-standalone}"; wr="/var/www/html"
  [ "$method" = "webroot" ] && wr="$(ask 'webroot path' "$wr")"
  tgt="$(_pick_cert_target)"
  cert_issue "$domain" "$email" "$method" "$wr" "$tgt"
  pause
}

cert_menu_import() {
  banner; step "Import an existing certificate"
  local domain src tgt fc kf
  domain="$(ask 'domain this certificate is for')"; [ -n "$domain" ] || return
  src="$(_pick 'how will you provide it?' \
    "file:I have the .pem files on disk" \
    "paste:Paste the certificate and the key")"
  [ -z "$src" ] && return
  if [ "$src" = "file" ]; then
    fc="$(ask 'path to fullchain/cert .pem')"
    kf="$(ask 'path to private key .pem')"
  else
    local tmpd; tmpd="$(mktemp -d)"; fc="$tmpd/fullchain.pem"; kf="$tmpd/privkey.pem"
    printf '  %s·%s paste the CERTIFICATE (with chain), then a line containing only  %sEND%s\n' "$C" "$N" "$Y" "$N"
    _read_until_end >"$fc"
    printf '  %s·%s paste the PRIVATE KEY, then a line containing only  %sEND%s\n' "$C" "$N" "$Y" "$N"
    _read_until_end >"$kf"
  fi
  tgt="$(_pick_cert_target)"
  cert_import "$domain" "$fc" "$kf" "$tgt"
  pause
}

cert_menu_apply() {
  banner; step "Apply a stored certificate"
  local domain tgt
  domain="$(ask 'domain of a stored certificate')"; [ -n "$domain" ] || return
  [ -f "$CERT_DIR/$domain/fullchain.pem" ] || { bad "no stored certificate for $domain - issue or import it first"; pause; return; }
  tgt="$(_pick_cert_target)"
  [ "$tgt" = "none" ] && { warn "nothing to apply"; pause; return; }
  cert_apply_to "$domain" "$CERT_DIR/$domain/fullchain.pem" "$CERT_DIR/$domain/privkey.pem" "$tgt"
  pause
}

menu_migrate() {
  banner
  step "Migrate this server → a new server"
  info "this machine is the SOURCE; the panels are copied to the destination you enter"
  local host port user pass sel keys
  host="$(ask 'destination host / IP')"
  [ -n "$host" ] || { warn "cancelled"; return; }
  port="$(ask 'SSH port' '22')"
  user="$(ask 'SSH user' 'root')"
  pass=""
  confirm "Use password auth (otherwise your SSH key is used)?" && pass="$(ask_secret 'SSH password')"
  local m; m="$(_pick 'what to migrate' \
    "ALL:Everything installed here (all-at-once)" \
    "pasarguard:PasarGuard only" "marzban:Marzban only" \
    "marzneshin:Marzneshin only" "3x-ui:3x-ui only")"
  [ -z "$m" ] && return
  if [ "$m" = "ALL" ]; then keys="$PANEL_KEYS"; else keys="$m"; fi
  local dry=""
  confirm "Do a dry-run first (no changes)?" y && dry="--dry-run"
  migrate_panels "$host" "$port" "$user" "$pass" "$keys" "$dry"
  if [ "$dry" = "--dry-run" ] && confirm "Dry-run done. Run the real migration now?"; then
    migrate_panels "$host" "$port" "$user" "$pass" "$keys" ""
  fi
  pause
}

menu_tunnels() {
  while :; do
    banner; dashboard
    local k; k="$(_pick 'Tunnels' \
      "spoof:Spoof Tunnel  (+ Spoof Tester + web GUI)" \
      "eris-tunnel-2:Eris Tunnel 2  (Backhaul manager)" \
      "quickcheck:Quick spoof-capability check (auto tcpdump over SSH)")"
    [ -z "$k" ] && return
    case "$k" in
      spoof)         tunnel_install spoof ;;
      eris-tunnel-2) tunnel_install eris-tunnel-2 ;;
      quickcheck)    spoof_quickcheck ;;
    esac
    pause
  done
}

menu_web() {
  while :; do
    banner
    printf '  %sWeb panel%s   %s\n' "$BOLD" "$N" "$(web_ctl url 2>/dev/null)"
    local k; k="$(_pick 'Web panel' \
      "install:Install / reconfigure the web panel" \
      "update:Update the web panel (keeps port & password)" \
      "start:Start" "stop:Stop" "restart:Restart" "status:Status" \
      "passwd:Change admin password")"
    [ -z "$k" ] && return
    case "$k" in
      install) web_install ;;
      update)  web_update ;;
      passwd)  web_passwd ;;
      *)       web_ctl "$k" ;;
    esac
    pause
  done
}

main_menu() {
  while :; do
    banner; dashboard
    local k; k="$(_pick 'Main menu' \
      "status:Detect / refresh what is installed & running" \
      "install:Install panels & nodes" \
      "cert:SSL certificates (issue · import · apply)" \
      "backup:Backup databases" \
      "restore:Restore from backup" \
      "delete:Remove panels & nodes" \
      "migrate:Migrate to a new server" \
      "tunnels:Tunnels (Spoof / Eris Tunnel 2)" \
      "web:Web panel" \
      "update:Update erispm")"
    case "$k" in
      status)  banner; dashboard; pause ;;
      install) menu_install ;;
      cert)    menu_cert ;;
      backup)  menu_backup ;;
      restore) menu_restore ;;
      delete)  menu_delete ;;
      migrate) menu_migrate ;;
      tunnels) menu_tunnels ;;
      web)     menu_web ;;
      update)  self_update; pause ;;
      "")      clear 2>/dev/null || true; printf '  %sbye%s\n' "$C" "$N"; exit 0 ;;
    esac
  done
}

# ==============================================================================
#  CLI dispatch  (non-interactive surface used by scripts & the web panel)
# ==============================================================================
usage() {
  cat <<USAGE
${BOLD}Eris Panel Manager${N}  v$SCRIPT_VER

  ${C}erispm${N}                          open the interactive menu
  ${C}erispm menu${N}                     same as above

  ${C}erispm install-panel${N} <key>      key: pasarguard|marzban|marzneshin|3x-ui
  ${C}erispm install-node${N}  <key>      key: pasarguard-node|marzban-node|marzneshin-node
  ${C}erispm delete-panel${N}  <key> [--purge]
  ${C}erispm backup${N} <key> [outdir]    key: pasarguard|marzban|marzneshin|3x-ui
  ${C}erispm restore${N} <key> <archive>
  ${C}erispm cert${N} issue  --domain D [--email E] [--method standalone|nginx|webroot] [--apply all|<key>]
  ${C}erispm cert${N} import --domain D --cert-file F --key-file K [--apply all|<key>]
  ${C}erispm cert${N} apply  --domain D --panel all|<key>
  ${C}erispm cert${N} sync <domain>      (re-apply after a renewal)   ${C}erispm cert list${N}
  ${C}erispm migrate${N} --to user@host [--port 22] [--password-env VAR] --panels a,b,c|ALL [--dry-run]
  ${C}erispm tunnel install${N} <spoof|eris-tunnel-2>
  ${C}erispm web${N} <install|update|start|stop|restart|status|url|passwd>
  ${C}erispm status${N}                   human status    ${C}erispm status --json${N}   machine status
  ${C}erispm update${N}                   self-update
  ${C}erispm version${N}

  Flags: ${D}-y/--yes${N} assume yes   ${D}--force${N} reinstall even if already installed
         ${D}NO_COLOR=1${N} disable colour   ${D}ERISPM_YES=1${N} non-interactive
USAGE
}

# parse global -y / --yes / --force anywhere
ARGS=()
for a in "$@"; do
  case "$a" in
    -y|--yes) ASSUME_YES=1 ;;
    --force)  ERISPM_FORCE=1 ;;
    *) ARGS+=("$a") ;;
  esac
done
set -- "${ARGS[@]:-}"

getflag() { # getflag --name "$@" -> echoes value after --name
  local want="$1"; shift
  while [ $# -gt 0 ]; do [ "$1" = "$want" ] && { printf '%s' "${2:-}"; return; }; shift; done
}
hasflag() { local want="$1"; shift; for a in "$@"; do [ "$a" = "$want" ] && return 0; done; return 1; }

cmd="${1:-menu}"; [ $# -gt 0 ] && shift || true

case "$cmd" in
  ""|menu)        need_root; conf_init; main_menu ;;
  install-panel)  install_panel "${1:?panel key}" ;;
  install-node)   install_node  "${1:?node key}" ;;
  delete-panel)   delete_panel  "${1:?panel key}" "${2:-}" ;;
  backup)         backup_panel  "${1:?panel key}" "${2:-$BACKUP_DIR}" ;;
  restore)        restore_panel "${1:?panel key}" "${2:?archive}" ;;
  cert)
    sub="${1:-}"; shift || true
    case "$sub" in
      issue)
        dom="$(getflag --domain "$@")"; em="$(getflag --email "$@")"
        meth="$(getflag --method "$@")"; wr="$(getflag --webroot "$@")"
        appl="$(getflag --apply "$@")"; pnl="$(getflag --panel "$@")"
        [ -z "$appl" ] && appl="$pnl"
        cert_issue "$dom" "$em" "${meth:-standalone}" "${wr:-/var/www/html}" "$appl" ;;
      import)
        dom="$(getflag --domain "$@")"; fcf="$(getflag --cert-file "$@")"
        kff="$(getflag --key-file "$@")"; appl="$(getflag --apply "$@")"
        pnl="$(getflag --panel "$@")"; [ -z "$appl" ] && appl="$pnl"
        cert_import "$dom" "$fcf" "$kff" "$appl" ;;
      apply)
        dom="$(getflag --domain "$@")"; appl="$(getflag --panel "$@")"
        [ -z "$appl" ] && appl="$(getflag --apply "$@")"
        [ -n "$dom" ] && [ -n "$appl" ] || die "need --domain and --panel"
        cert_apply_to "$dom" "$CERT_DIR/$dom/fullchain.pem" "$CERT_DIR/$dom/privkey.pem" "$appl" ;;
      sync)  cert_sync "${1:-$(getflag --domain "$@")}" ;;
      list)  cert_list ;;
      *) usage ;;
    esac ;;
  migrate)
    to="$(getflag --to "$@")"; port="$(getflag --port "$@")"
    penv="$(getflag --password-env "$@")"; panels="$(getflag --panels "$@")"
    dry=""; hasflag --dry-run "$@" && dry="--dry-run"
    user="${to%@*}"; host="${to#*@}"; [ "$to" = "$host" ] && user="root"
    pass=""; [ -n "$penv" ] && pass="$(printenv "$penv" 2>/dev/null)"
    keys="$panels"; [ "$panels" = "ALL" ] && keys="$PANEL_KEYS"
    migrate_panels "$host" "${port:-22}" "$user" "$pass" "$keys" "$dry" ;;
  tunnel)
    sub="${1:-}"; shift || true
    case "$sub" in install) tunnel_install "${1:?spoof|eris-tunnel-2}" ;; *) usage ;; esac ;;
  web)
    sub="${1:-status}"; shift || true
    case "$sub" in
      install) web_install ;;
      update)  web_update ;;
      passwd)  web_passwd ;;
      start|stop|restart|status|url) web_ctl "$sub" ;;
      *) usage ;;
    esac ;;
  status)
    if hasflag --json "$@"; then json_status; else banner; dashboard; fi ;;
  update)   self_update ;;
  version|-v|--version) printf 'erispm %s\n' "$SCRIPT_VER" ;;
  help|-h|--help) usage ;;
  *) usage; exit 1 ;;
esac
