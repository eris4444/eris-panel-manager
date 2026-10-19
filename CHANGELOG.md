# Changelog

All notable changes to Eris Panel Manager are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [1.4.0] — 2026-10-19

### Added
- **A native, Eris-designed Spoof Tunnel UI.** The Spoof panel tab is now its own interface built
  into the erispm web panel — same dark-glass cyan/purple look as the rest — instead of embedding
  the upstream panel in a frame. It drives the official
  [ParsaKSH/spoof-tunnel](https://github.com/ParsaKSH/spoof-tunnel) backend's REST API through the
  same-origin reverse proxy, so the tunnel core and its API stay upstream and unchanged:
  - **Tunnels** — list with live status, start / stop / restart, create, edit and delete; a full
    editor (local / remote mode, transports, XDP, spoof settings) with a Spoof-IP-list tab and a
    live-logs tab (WebSocket).
  - **Spoof Tester** — receiver / sender runs with live progress and results, pass/fail table, and
    copy / download of the passing IPs.
  - **Settings** — change the Spoof panel password.
  - You sign in once with the Spoof panel's own username/password (what its installer printed); the
    token is kept in the browser only, and an expired session drops back to the Spoof sign-in.
- The original panel is still one click away ("Original panel ↗" opens it in a new tab).

### Changed
- The Spoof tab no longer uses an iframe (the embed added in 1.3.0); the reverse proxy now serves
  the backend's JSON API and WebSocket logs to the native UI.

### Upgrade
`erispm update` (or re-run `install.sh`) — it also downloads the new `web/static/spoof.js`.

## [1.3.0] — 2026-10-19

### Added
- **The original Spoof Tunnel panel inside the erispm web panel.** Once Spoof Tunnel is installed
  (the official [ParsaKSH/spoof-tunnel](https://github.com/ParsaKSH/spoof-tunnel) installer, as
  before), a **Spoof panel** tab shows its own panel — **unchanged**, same login, same pages,
  Spoof Tester and live tunnel logs included. The web panel finds its port and secret web path by
  itself (from `spoof-panel.service` and the panel's own SQLite settings) and serves it through a
  same-origin reverse proxy, so it works on the erispm port and over erispm's HTTPS, and only after
  signing in to erispm. HTTP, uploads/downloads and its WebSocket logs are passed through; the
  erispm session cookie is never forwarded to it.
- "Open Spoof panel" on the dashboard and on the Tunnels card, an "Open in new tab" link, and the
  panel's direct address.

### Changed
- `erispm tunnel install spoof` no longer re-runs the official installer over an existing Spoof
  panel: that installer picks a **new random port and adds another login** every time. The panel
  is left exactly as it is; use `--force` (or confirm at the prompt in the menu) to reinstall anyway.
- Spoof Tunnel running-state detection now checks the real `spoof-panel` service.

## [1.2.0] — 2026-10-18

### Added
- **Interactive web terminal.** The web panel's one-way console is replaced by a real terminal:
  every task runs `erispm` on a pseudo-terminal (PTY) on the server, so the official installers
  that **ask questions** — node API key or certificate paste, 3x-ui port/SSL questions,
  "reinstall?" prompts, `read` loops — can now be answered from the browser. Click the
  terminal and type, paste with Ctrl+V, or use the quick keys (Enter, Ctrl-C, Ctrl-D, ↑ ↓,
  Tab, Esc, y, n).
- **Open erispm menu** — the full interactive `erispm` menu, right in the browser.
- The terminal renderer is self-written and loads nothing from a CDN (works where CDNs are
  filtered): 16 / 256 / truecolor, bold / dim / italic / underline / inverse, cursor movement,
  erase, scroll regions, the alternate screen, DEC line drawing and a 5000-line scrollback.
  Its size follows the window (the server's PTY is resized to match).
- **Re-attach** — the server keeps the last ~2 MB of a task's output, so reloading the page or
  a dropped connection picks the running task up where it was.
- **Stop** sends Ctrl-C (SIGINT) and then SIGTERM; pressing it again sends SIGKILL. One task
  runs at a time; starting another while one is running is refused.
- Web API: `POST /api/run` → job, `GET /api/stream?job=&from=`, `POST /api/input`,
  `POST /api/signal`, `POST /api/resize`, `GET /api/job`.

### Changed
- `run_upstream`: when a terminal is attached (SSH, or the web terminal) upstream installers
  keep their stdin and may prompt. The `docker logs -f` shim and `</dev/null` are only used
  when there is no terminal; web **form** actions still use the shim so they finish on their own.
- Marzneshin node install/uninstall no longer hide stderr, where `read -p` prompts appear.
- Web panel: POST bodies must be JSON (415 otherwise) and are always read, which fixes a
  keep-alive mix-up after an early error reply; static files are sent with
  `Cache-Control: no-cache` so an update shows up right away.

### Upgrade
`erispm update` (or re-run `install.sh`) — it also downloads the new `web/static/term.js`.

## [1.1.0] — 2026-10-18

### Fixed
- **Critical:** `HOME` unbound under `set -u` (e.g. from the systemd web panel, cron or
  bare `sudo`) aborted *every* command on startup — including `tunnel install`. `HOME` now
  defaults to `/root` when unset.
- Marzneshin paths corrected: its compose/`.env` live in `/etc/opt/marzneshin` (not
  `/opt/marzneshin`). Detection, backup and purge updated accordingly; backups also keep the
  marznode data dir.
- Panel restarts no longer call the panels' own CLIs (`marzban restart`/`up` follow the logs
  forever and don't re-read `.env`); erispm recreates the compose service instead.
- PasarGuard backups never contained the SQL dump. Database dumps now read their credentials
  from the DB container itself and also support **PostgreSQL / TimescaleDB**.
- `erispm update` didn't refresh the web panel; it now updates the web files and the systemd
  unit and restarts the panel (also available as `erispm web update`).
- From the web panel, Eris Tunnel 2 installs headlessly (its installer needs `/dev/tty`), and
  upstream `docker compose logs -f` no longer hangs a non-interactive run.

### Added
- **Smarter detection** — panels/nodes/tunnels installed *outside* erispm are now detected
  (by data dir, compose dir, CLI and docker containers), and the real **running** state is
  read from live Docker containers (these panels have no systemd unit of their own) and from
  `x-ui` for 3x-ui. The dashboard shows running · installed/stopped · not-installed, and the
  installers skip something that is already there unless you pass `--force`.
- **Certificates that actually land in the panel** — issuing or importing a certificate can now
  **auto-apply** it: the cert is copied into a folder the panel *and its Docker container* can
  read (`/var/lib/<panel>/certs/<domain>/`, same path inside the container), the panel's SSL
  config is pointed at it (`UVICORN_SSL_CERTFILE`/`KEYFILE` for Marzban/PasarGuard/Marzneshin,
  `x-ui cert` for 3x-ui), and the panel is restarted and checked — if it doesn't come back
  cleanly, the previous `.env` is restored. The folder is taken from the container's real
  mounts, so non-standard installs work too. Renewals re-apply automatically.
- **Manual certificate import** — paste or point at an existing cert + key; it is validated
  (`openssl`, key-matches-cert), stored, and applied the same way.
- New sub-commands: `cert apply`, `cert import`, `cert sync`; `cert issue --apply all|<key>`.
- Web panel: Certificates tab rebuilt (issue / import / apply) with a panel-target picker.

## [1.0.0] — 2026-10-18

Initial public release.

### Added
- **Panels** — install PasarGuard, Marzban, Marzneshin and 3x-ui (Sanaei) by wrapping
  each project's official installer.
- **Nodes** — install PasarGuard, Marzban and Marzneshin nodes.
- **Certificates** — Let's Encrypt / ZeroSSL via `acme.sh` (standalone / nginx / webroot),
  installed to `/etc/eris-panel-manager/certs/<domain>/`, auto-renewing.
- **Backup & restore** — per-panel or all-at-once; SQLite checkpoint + MySQL/MariaDB dump;
  SHA-256 checksums; checksum-verified, service-aware restore.
- **Delete** — official uninstall with an optional `--purge`, always preceded by a safety backup.
- **Migration** — source → destination over SSH, one-by-one or all-at-once, with a dry-run mode.
- **Tunnels** — Spoof Tunnel (core + built-in Spoof Tester + web GUI) and Eris Tunnel 2;
  plus a quick, temporary spoof-capability check.
- **Web panel** — Python 3 standard-library server with password login, HMAC-signed sessions,
  a strict action allow-list, a live streaming console and a status dashboard.
- **Terminal menu** — full-screen coloured TUI sharing the same backend as the web panel.
- **Self-update** — `erispm update` refreshes the manager and web assets.

[1.4.0]: https://github.com/eris4444/eris-panel-manager/releases/tag/v1.4.0
[1.3.0]: https://github.com/eris4444/eris-panel-manager/releases/tag/v1.3.0
[1.2.0]: https://github.com/eris4444/eris-panel-manager/releases/tag/v1.2.0
[1.1.0]: https://github.com/eris4444/eris-panel-manager/releases/tag/v1.1.0
[1.0.0]: https://github.com/eris4444/eris-panel-manager/releases/tag/v1.0.0
