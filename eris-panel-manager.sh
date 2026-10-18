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

SCRIPT_VER="1.0.0"
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

is_installed() {
  case "$1" in
    pasarguard)      [ -d /opt/pasarguard ] || have pasarguard ;;
    marzban)         [ -d /opt/marzban ]    || have marzban ;;
    marzneshin)      [ -d /opt/marzneshin ] || have marzneshin ;;
    3x-ui)           [ -d /etc/x-ui ] || [ -d /usr/local/x-ui ] || have x-ui ;;
    pasarguard-node) [ -d /opt/pasarguard-node ] || docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qi 'pasarguard.*node' ;;
    marzban-node)    [ -d /opt/marzban-node ]    || docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qi 'marzban.*node' ;;
    marzneshin-node) [ -d /opt/marzneshin-node ] || docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qi 'marzneshin.*node' ;;
    eris-tunnel-2)   [ -x /usr/local/bin/eristun2 ] ;;
    spoof-tunnel)    [ -d /opt/spoof-tunnel ] || have spoof-tunnel || systemctl list-unit-files 2>/dev/null | grep -qi spoof ;;
    *) return 1 ;;
  esac
}

svc_active() { systemctl is-active --quiet "$1" 2>/dev/null; }

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
    dot="${G}●${N}"
    case "$k" in
      pasarguard|marzban|marzneshin) svc_active "$k" && det="${D}running${N}" || det="${Y}stopped${N}" ;;
      3x-ui) svc_active x-ui && det="${D}running${N}" || det="${Y}stopped${N}" ;;
      eris-tunnel-2) det="${D}installed${N}" ;;
      *) det="${D}installed${N}" ;;
    esac
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
run_upstream() { # run_upstream URL [args...]
  local url="$1"; shift
  local tmp; tmp="$(mktemp)" || die "mktemp failed"
  info "fetching $(basename "$url")"
  curl -fsSL --retry 3 --max-time 120 -o "$tmp" "$url" || { rm -f "$tmp"; die "download failed: $url"; }
  sed -i 's/\r$//' "$tmp" 2>/dev/null || true
  bash "$tmp" "$@"
  local rc=$?
  rm -f "$tmp"
  return $rc
}

# ==============================================================================
#  PANEL / NODE INSTALL
# ==============================================================================
install_panel() { # install_panel <key>
  local key="$1"
  need_root
  ensure_pkg curl
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
      # Marzneshin ships node support through its main script.
      run_upstream "$URL_MARZNESHIN" @ install-node 2>/dev/null \
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
ACME="$HOME/.acme.sh/acme.sh"
ensure_acme() {
  [ -x "$ACME" ] && return 0
  step "Installing acme.sh"
  ensure_pkg curl socat
  local email="$1"
  curl -fsSL https://get.acme.sh | sh -s email="${email:-admin@example.com}" >/dev/null 2>&1 \
    || die "acme.sh install failed"
  ACME="$HOME/.acme.sh/acme.sh"
  "$ACME" --set-default-ca --server letsencrypt >/dev/null 2>&1 || true
  ok "acme.sh installed"
}

cert_issue() { # cert_issue domain email method(standalone|nginx|webroot) [webroot]
  local domain="$1" email="$2" method="${3:-standalone}" webroot="${4:-/var/www/html}"
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
    --reloadcmd      "systemctl reload nginx 2>/dev/null || true"
  ok "certificate saved:"
  printf '      %sfullchain:%s %s\n' "$D" "$N" "$out/fullchain.pem"
  printf '      %sprivate  :%s %s\n' "$D" "$N" "$out/privkey.pem"
  conf_set "cert_$domain" "$(date '+%F %T')"
  info "paste these two paths into your panel's SSL settings; auto-renewal is handled by acme.sh cron"
}

cert_list() {
  step "Issued certificates"
  if [ -x "$ACME" ]; then "$ACME" --list 2>/dev/null; fi
  local d
  for d in "$CERT_DIR"/*/; do
    [ -d "$d" ] || continue
    printf '  %s·%s %s\n' "$C" "$N" "$(basename "$d")"
  done
}

# ==============================================================================
#  BACKUP  &  RESTORE
# ==============================================================================
# Each panel: tar its config dir + data dir; dump SQL DB if containerised MySQL.
ts() { date '+%Y%m%d-%H%M%S'; }

_dump_sql_if_any() { # _dump_sql_if_any <workdir> <stagedir>
  local work="$1" stage="$2" dbc=""
  [ -d "$work" ] || return 0
  # find a mariadb/mysql container belonging to this compose project
  dbc="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -Ei "$(basename "$work").*(db|mysql|maria)" | head -n1)"
  [ -z "$dbc" ] && return 0
  info "dumping SQL database from container $dbc"
  local pw user
  pw="$(grep -Ei 'MYSQL_ROOT_PASSWORD|MARIADB_ROOT_PASSWORD' "$work"/.env 2>/dev/null | head -n1 | cut -d= -f2-)"
  user="root"
  if docker exec "$dbc" sh -c 'command -v mariadb-dump' >/dev/null 2>&1; then
    docker exec "$dbc" sh -c "mariadb-dump -u$user ${pw:+-p$pw} --all-databases" >"$stage/all-databases.sql" 2>/dev/null \
      && ok "SQL dump captured" || warn "SQL dump failed (continuing with files only)"
  else
    docker exec "$dbc" sh -c "mysqldump -u$user ${pw:+-p$pw} --all-databases" >"$stage/all-databases.sql" 2>/dev/null \
      && ok "SQL dump captured" || warn "SQL dump failed (continuing with files only)"
  fi
}

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
          $( [ -s "$stage/all-databases.sql" ] && echo -C "$stage" all-databases.sql ) 2>/dev/null ;;
    marzneshin)
      [ -d /var/lib/marzneshin ] && { sqlite3 /var/lib/marzneshin/db.sqlite3 'PRAGMA wal_checkpoint(TRUNCATE);' 2>/dev/null || true; }
      _dump_sql_if_any /opt/marzneshin "$stage"
      tar -C / -czf "$arch" --ignore-failed-read \
          $( [ -d /opt/marzneshin ]     && echo opt/marzneshin ) \
          $( [ -d /var/lib/marzneshin ] && echo var/lib/marzneshin ) 2>/dev/null ;;
    pasarguard)
      [ -d /var/lib/pasarguard ] && { sqlite3 /var/lib/pasarguard/db.sqlite3 'PRAGMA wal_checkpoint(TRUNCATE);' 2>/dev/null || true; }
      _dump_sql_if_any /opt/pasarguard "$stage"
      tar -C / -czf "$arch" --ignore-failed-read \
          $( [ -d /opt/pasarguard ]     && echo opt/pasarguard ) \
          $( [ -d /var/lib/pasarguard ] && echo var/lib/pasarguard ) 2>/dev/null ;;
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
  # stop services so files are not held open
  case "$key" in
    marzban)    have marzban    && marzban down    >/dev/null 2>&1 || true ;;
    marzneshin) have marzneshin && marzneshin down >/dev/null 2>&1 || true ;;
    pasarguard) have pasarguard && pasarguard down >/dev/null 2>&1 || true ;;
    3x-ui)      systemctl stop x-ui 2>/dev/null || true ;;
  esac
  local tmp; tmp="$(mktemp -d)"
  tar -xzf "$arch" -C "$tmp" || { rm -rf "$tmp"; die "extract failed"; }
  # copy directories back into place
  ( cd "$tmp" && for d in opt/* var/lib/* etc/* usr/local/*; do
      [ -e "$d" ] || continue
      mkdir -p "/$(dirname "$d")"
      cp -a "$d" "/$(dirname "$d")/"
    done ) 2>/dev/null
  # if a SQL dump is present, load it into the (freshly started) db container
  if [ -s "$tmp/all-databases.sql" ]; then
    info "SQL dump present - bringing panel up, then importing"
    case "$key" in
      marzban)    marzban up    -d >/dev/null 2>&1 || true ;;
      marzneshin) marzneshin up -d >/dev/null 2>&1 || true ;;
      pasarguard) pasarguard up -d >/dev/null 2>&1 || true ;;
    esac
    sleep 8
    local dbc pw
    dbc="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -Ei "$key.*(db|mysql|maria)" | head -n1)"
    pw="$(grep -Ei 'MYSQL_ROOT_PASSWORD|MARIADB_ROOT_PASSWORD' /opt/$key/.env 2>/dev/null | head -n1 | cut -d= -f2-)"
    if [ -n "$dbc" ]; then
      docker exec -i "$dbc" sh -c "mariadb -uroot ${pw:+-p$pw} 2>/dev/null || mysql -uroot ${pw:+-p$pw}" <"$tmp/all-databases.sql" \
        && ok "SQL imported" || warn "SQL import failed - check DB credentials"
    fi
  fi
  rm -rf "$tmp"
  # (re)start
  case "$key" in
    marzban)    have marzban    && marzban restart    >/dev/null 2>&1 || true ;;
    marzneshin) have marzneshin && marzneshin restart >/dev/null 2>&1 || true ;;
    pasarguard) have pasarguard && pasarguard restart >/dev/null 2>&1 || true ;;
    3x-ui)      systemctl restart x-ui 2>/dev/null || true ;;
  esac
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
    marzneshin-node) run_upstream "$URL_MARZNESHIN"   @ uninstall-node 2>/dev/null || true ;;
    *) die "unknown target: $key" ;;
  esac
  if [ "$purge" = "--purge" ]; then
    warn "purging data directories"
    case "$key" in
      pasarguard) rm -rf /opt/pasarguard /var/lib/pasarguard ;;
      marzban)    rm -rf /opt/marzban /var/lib/marzban ;;
      marzneshin) rm -rf /opt/marzneshin /var/lib/marzneshin ;;
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
      info "the Spoof Tester is bundled inside the Spoof Tunnel core and panel"
      run_upstream "$URL_SPOOF" ;;
    eris-tunnel-2|eristun2)
      step "Installing Eris Tunnel 2"
      run_upstream "$URL_ERISTUN2" ;;
    *) die "unknown tunnel: $what" ;;
  esac
}

# Quick local check: can this host emit spoofed source packets? (safe, temporary)
spoof_quickcheck() {
  need_root
  ensure_pkg iptables tcpdump
  step "Spoof capability quick check"
  info "for a full, accurate test use: erispm tunnel install spoof  (then the built-in Spoof Tester)"
  local tgt spf
  tgt="$(ask 'target IP (your other server)')"
  spf="$(ask 'spoof source IP to try')"
  [ -n "$tgt" ] && [ -n "$spf" ] || { warn "need both IPs"; return 1; }
  info "adding a temporary SNAT rule and sending 3 pings; watch 'tcpdump icmp' on $tgt"
  iptables -t nat -A POSTROUTING -d "$tgt" -j SNAT --to-source "$spf"
  ping -c3 -W2 "$tgt" >/dev/null 2>&1 || true
  iptables -t nat -D POSTROUTING -d "$tgt" -j SNAT --to-source "$spf" 2>/dev/null || true
  ok "done - if $tgt's tcpdump showed packets from $spf, this side can spoof"
}

# ==============================================================================
#  WEB PANEL  (Python 3 standard library - no pip)
# ==============================================================================
WEB_PORT_DEFAULT="8787"
web_fetch_assets() {
  mkdir -p "$WEB_DIR/static"
  local f
  for f in server.py static/index.html static/login.html static/app.css static/app.js; do
    if [ ! -f "$WEB_DIR/$f" ]; then
      curl -fsSL "$RAW_WEB_BASE/$f" -o "$WEB_DIR/$f" 2>/dev/null || true
    fi
  done
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
  cat >/etc/systemd/system/eris-panel-web.service <<UNIT
[Unit]
Description=Eris Panel Manager - Web Panel
After=network.target

[Service]
Type=simple
Environment=ERISPM_CONF=$CONF
ExecStart=/usr/bin/python3 $WEB_DIR/server.py
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now eris-panel-web.service >/dev/null 2>&1
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
  install -m 0755 "$tmp" "$SELF"; rm -f "$tmp"
  web_fetch_assets 2>/dev/null || true
  ok "updated to latest; web assets refreshed"
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
    case "$k" in
      pasarguard|marzban|marzneshin) svc_active "$k" && run=true ;;
      3x-ui) svc_active x-ui && run=true ;;
    esac
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
cert_menu() {
  banner
  step "SSL certificate (Let's Encrypt / ZeroSSL via acme.sh)"
  local domain email method
  domain="$(ask 'domain (e.g. panel.example.com)')"
  [ -n "$domain" ] || { warn "cancelled"; return; }
  email="$(ask 'email for the ACME account' "$(conf_get acme_email)")"
  [ -n "$email" ] && conf_set acme_email "$email"
  local m; m="$(_pick 'validation method' \
    "standalone:standalone (needs port 80 free)" \
    "nginx:nginx (auto-edits your nginx)" \
    "webroot:webroot (serve from a folder)")"
  method="${m:-standalone}"
  local wr="/var/www/html"
  [ "$method" = "webroot" ] && wr="$(ask 'webroot path' "$wr")"
  cert_issue "$domain" "$email" "$method" "$wr"
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
      "quickcheck:Quick spoof-capability check (temporary)")"
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
      "start:Start" "stop:Stop" "restart:Restart" "status:Status" \
      "passwd:Change admin password")"
    [ -z "$k" ] && return
    case "$k" in
      install) web_install ;;
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
      "install:Install panels & nodes" \
      "cert:SSL certificates" \
      "backup:Backup databases" \
      "restore:Restore from backup" \
      "delete:Remove panels & nodes" \
      "migrate:Migrate to a new server" \
      "tunnels:Tunnels (Spoof / Eris Tunnel 2)" \
      "web:Web panel" \
      "update:Update erispm")"
    case "$k" in
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
  ${C}erispm cert${N} issue --domain D [--email E] [--method standalone|nginx|webroot] [--webroot P]
  ${C}erispm cert${N} list
  ${C}erispm migrate${N} --to user@host [--port 22] [--password-env VAR] --panels a,b,c|ALL [--dry-run]
  ${C}erispm tunnel install${N} <spoof|eris-tunnel-2>
  ${C}erispm web${N} <install|start|stop|restart|status|url|passwd>
  ${C}erispm status${N}                   human status    ${C}erispm status --json${N}   machine status
  ${C}erispm update${N}                   self-update
  ${C}erispm version${N}

  Flags: ${D}-y/--yes${N} assume yes   ${D}NO_COLOR=1${N} disable colour   ${D}ERISPM_YES=1${N} non-interactive
USAGE
}

# parse global -y / --yes anywhere
ARGS=()
for a in "$@"; do
  case "$a" in
    -y|--yes) ASSUME_YES=1 ;;
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
        cert_issue "$dom" "$em" "${meth:-standalone}" "${wr:-/var/www/html}" ;;
      list) cert_list ;;
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
