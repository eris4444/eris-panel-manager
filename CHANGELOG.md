# Changelog

All notable changes to Eris Panel Manager are documented here.
This project follows [Semantic Versioning](https://semver.org/).

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

[1.0.0]: https://github.com/eris4444/eris-panel-manager/releases/tag/v1.0.0
