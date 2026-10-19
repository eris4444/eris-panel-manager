<div align="center">

# ⚡ ERIS PANEL MANAGER

**One command to install, secure, back up, migrate and tunnel every proxy panel you run.**

PasarGuard · Marzban · Marzneshin · 3x‑ui (Sanaei) — plus their nodes, SSL certificates,
database backup/restore, server‑to‑server migration, and the Spoof Tunnel & Eris Tunnel 2 tunnels —
all from a colourful terminal menu **or** a sleek web panel.

[🇮🇷 فارسی](README.fa.md)

![version](https://img.shields.io/badge/version-1.4.0-5fd7ff?style=flat-square)
![bash](https://img.shields.io/badge/bash-5.x-114?style=flat-square&logo=gnubash&logoColor=white)
![web](https://img.shields.io/badge/web%20panel-python3%20stdlib-b48bff?style=flat-square&logo=python&logoColor=white)
![license](https://img.shields.io/badge/license-MIT-7ee0a2?style=flat-square)
![platform](https://img.shields.io/badge/linux-debian%20·%20ubuntu%20·%20rhel%20·%20alpine-215?style=flat-square&logo=linux&logoColor=white)

<img src="docs/web-install.jpg" alt="Eris Panel Manager web panel" width="85%">

</div>

---

## Why

Running proxy infrastructure means juggling several panels, their nodes, Let's Encrypt
certificates, nightly database backups, and the occasional stressful migration to a new
server — usually with a different install command and quirk for each tool.

**Eris Panel Manager** puts all of it behind one `erispm` command. The terminal menu and
the web panel share the exact same backend, so whatever you can do in one, you can do in the
other.

> It never reimplements the panels. It **wraps the official upstream installers** so you always
> get the real, up‑to‑date software — and adds the orchestration, certificates, backups,
> migration and tunnels around them.

---

## Features

| Area | What you get |
|---|---|
| **Detect** | Finds panels/nodes/tunnels even if installed **outside erispm**, and shows the real **running** state from live Docker containers / `x‑ui` |
| **Install panels** | PasarGuard · Marzban · Marzneshin · 3x‑ui (Sanaei) |
| **Install nodes** | PasarGuard node · Marzban node · Marzneshin node |
| **Certificates** | Let's Encrypt / ZeroSSL via `acme.sh`, **or import your own**; auto‑applied into the panel's own Docker‑readable folder + config + restart; auto‑renew & re‑apply |
| **Backup** | Per‑panel or all‑at‑once; SQLite checkpoint + MySQL/MariaDB dump; SHA‑256 checksummed |
| **Restore** | Verified restore, service‑aware stop/start, SQL re‑import |
| **Delete** | Official uninstall + optional data purge — always takes a safety backup first |
| **Migrate** | Source → new server, **one‑by‑one or all‑at‑once**, with a dry‑run first |
| **Tunnels** | Spoof Tunnel — install, manage tunnels, and the Spoof Tester from a **native Eris UI** · Eris Tunnel 2 |
| **Web panel** | Password login, **interactive in‑browser terminal** (answer installer prompts, open the full menu), status dashboard — Python 3 stdlib, no pip, no CDN |
| **TUI** | Full‑screen coloured menu, works under any file name |

---

## Quick install

```bash
curl -fsSL https://raw.githubusercontent.com/eris4444/eris-panel-manager/main/install.sh | bash
```

Then just run:

```bash
erispm
```

Works on Debian/Ubuntu, RHEL/Alma/Rocky, Alpine and Arch. Requires `root`.

---

## The terminal menu

```
   ███████╗██████╗ ██╗███████╗   PANEL MANAGER
   ██╔════╝██╔══██╗██║██╔════╝   panels · nodes · certs
   █████╗  ██████╔╝██║███████╗   backup · migrate · tunnels
   ██╔══╝  ██╔══██╗██║╚════██║
   ███████╗██║  ██║██║███████║   v1.4.0

  Installed on this server
  ──────────────────────────────────────────
   ●  PasarGuard            running
   ○  Marzban               not installed
   ●  3x-ui (Sanaei)        running
   ...
   1) Install panels & nodes      6) Migrate to a new server
   2) SSL certificates            7) Tunnels
   3) Backup databases            8) Web panel
   4) Restore from backup         9) Update erispm
   5) Remove panels & nodes       0) exit
```

---

## The web panel

A dependency‑free dashboard (Python 3 standard library only — nothing from `pip`, nothing from a
CDN) that drives the same `erispm` backend in a **real terminal inside your browser**.

```bash
erispm web install      # pick a port, set a password, optional self-signed HTTPS
erispm web start|stop|restart|status|url
erispm web passwd       # change the admin password
```

<div align="center">
<img src="docs/web-dashboard.jpg" alt="dashboard" width="48%">
&nbsp;
<img src="docs/web-install.jpg" alt="install" width="48%">
</div>

- **Auth** — username + salted‑SHA‑256 password, HMAC‑signed expiring session cookie, `HttpOnly` + `SameSite=Strict`.
- **Safety** — every action runs through a strict allow‑list and is executed as a real argument
  vector (never a shell string), so nothing from the browser can inject a command.
- **Interactive terminal** — every action runs on a pseudo‑terminal on the server, so when an
  official installer asks a question (node API key, certificate, port, "reinstall?") you just
  click the terminal and answer. Full colours, Ctrl+V paste, quick keys (Enter, Ctrl‑C, Ctrl‑D,
  ↑ ↓, Tab, Esc, y, n) for phones, and a **Stop** button (Ctrl‑C → SIGTERM → SIGKILL).
- **Open erispm menu** — the complete terminal menu, in the browser.
- **Re‑attach** — reload the page or lose the connection and the running task comes back,
  with its recent output.
- **Spoof panel tab** — a native Eris UI for Spoof Tunnel: tunnels, the Spoof Tester and settings (see *Tunnels*).

> The web panel runs as `root` (it has to, to manage system services). Put it behind HTTPS,
> pick a strong password, and only open its port to the addresses you trust.

---

## CLI reference

Everything the menus do is also a plain sub‑command — handy for automation and for the web panel.

```bash
erispm install-panel <pasarguard|marzban|marzneshin|3x-ui>
erispm install-node  <pasarguard-node|marzban-node|marzneshin-node>
erispm delete-panel  <key> [--purge]
erispm backup  <pasarguard|marzban|marzneshin|3x-ui> [outdir]
erispm restore <key> <archive.tar.gz>
erispm cert issue  --domain panel.example.com --email you@example.com --apply all|<key>
erispm cert import --domain panel.example.com --cert-file F --key-file K --apply all|<key>
erispm cert apply  --domain panel.example.com --panel all|<key>
erispm cert sync <domain>        # re-apply after a renewal
erispm cert list
erispm migrate --to root@NEW_IP --port 22 --panels ALL --dry-run
erispm tunnel install <spoof|eris-tunnel-2>
erispm web <install|start|stop|restart|status|url|passwd>
erispm status [--json]
erispm update
```

Global flags: `-y` / `--yes` (assume yes), `NO_COLOR=1`, `ERISPM_YES=1` (fully non‑interactive).

When a terminal is attached, the official installers may ask their own questions; with no terminal
(cron, pipes) their stdin is `/dev/null` and a trailing `docker logs -f` is cut short so the run ends.

---

## Migration

Run it **on the old server** (the source). For each panel it takes a backup, copies it to the
destination over SSH, installs the matching panel there, and restores — one panel at a time or
everything at once.

```bash
# dry-run everything first (no changes)
erispm migrate --to root@203.0.113.9 --panels ALL --dry-run

# then for real (key auth)
erispm migrate --to root@203.0.113.9 --panels ALL

# password auth, a single panel, custom port
ERISPM_SSH_PASS='…' erispm migrate --to root@203.0.113.9 --port 2222 \
  --panels marzban --password-env ERISPM_SSH_PASS
```

After migrating, point your domain's DNS to the new server and re‑issue certificates there
(`erispm` → *Certificates*).

---

## Certificates

<img src="docs/web-certs.jpg" alt="certificates tab" width="85%">

Get a certificate from [`acme.sh`](https://github.com/acmesh-official/acme.sh) (Let's Encrypt /
ZeroSSL, EC‑256, auto‑renewing) **or import one you already have** — then let erispm put it where the
panel can actually use it.

**Auto‑apply** is the point. When you apply a cert to a panel, erispm:
1. copies it into `/var/lib/<panel>/certs/<domain>/` — a folder that is mounted into the panel's
   **Docker container at the same path**, so the container can read it (3x‑ui, which runs natively,
   gets its own readable folder);
2. points the panel's SSL config at it — `UVICORN_SSL_CERTFILE` / `UVICORN_SSL_KEYFILE` in the
   `.env` of Marzban / PasarGuard / Marzneshin, or `x-ui cert` for 3x‑ui;
3. restarts the panel. Renewals re‑apply automatically.

```bash
# new cert, applied to one panel (or --apply all)
erispm cert issue  --domain panel.example.com --email you@example.com --apply marzban

# bring your own cert/key, validated then applied
erispm cert import --domain panel.example.com --cert-file fullchain.pem --key-file privkey.pem --apply all

# re-point a stored cert at a panel, or re-apply after a manual renew
erispm cert apply  --domain panel.example.com --panel pasarguard
erispm cert sync   panel.example.com
```

Or just save it (`--apply none`, the default) and the master copy stays in
`/etc/eris-panel-manager/certs/<domain>/`. Validation methods: **standalone** (needs port 80 free —
erispm offers to pause nginx), **nginx** (acme.sh edits your nginx), **webroot**.

---

## Backups & restore

Backups land in `/etc/eris-panel-manager/backups/` as `<panel>-<timestamp>.tar.gz` with a
matching `.sha256`. SQLite databases are checkpointed first; containerised MySQL/MariaDB
databases are dumped with `mariadb-dump`/`mysqldump`. Restore verifies the checksum, stops the
panel, restores files, re‑imports SQL if present, and starts the panel back up.

---

## Tunnels

| Tunnel | What it is |
|---|---|
| **Spoof Tunnel** | Installs [ParsaKSH/spoof-tunnel](https://github.com/ParsaKSH/spoof-tunnel) — core + the **built‑in Spoof Tester** (find usable spoof IPs) + its web GUI |
| **Eris Tunnel 2** | Installs [eris4444/eris-tunnel-2](https://github.com/eris4444/eris-tunnel-2) — a Backhaul‑based tunnel manager |

**The Spoof panel inside erispm.** Spoof Tunnel is installed with its official installer and keeps
its own backend (random port + secret web path + its own login). The erispm web panel then gives it
a **native Eris-designed interface** in a *Spoof panel* tab — tunnels (create / edit / start / stop /
delete, with live logs), the Spoof Tester (receiver / sender, with copy & download of passing IPs),
and settings. The UI talks to the official backend's REST API through a same‑origin reverse proxy
(erispm reads the port and web path from `spoof-panel.service` and the panel's settings), so the
tunnel core and its API stay upstream and unchanged, it is reachable on the erispm port and over
erispm's HTTPS, and only after you sign in to erispm.

You sign in once with the username/password the Spoof installer printed (kept in your browser only).
The original panel is still one click away ("Original panel ↗"), and its direct address keeps working.

Running the installer again would give the Spoof backend a **new port and another login**, so
`erispm tunnel install spoof` leaves an existing one untouched (`--force` reinstalls anyway).

There is also a quick, temporary spoof‑capability check (`iptables` SNAT + `tcpdump`) in the
Tunnels menu for a fast sanity test before you commit to a tunnel setup.

---

## Uninstall

```bash
erispm web stop 2>/dev/null; systemctl disable eris-panel-web 2>/dev/null
rm -f /usr/local/bin/erispm /etc/systemd/system/eris-panel-web.service
rm -rf /etc/eris-panel-manager        # this also removes local backups — copy them out first!
```

Removing erispm does **not** touch any panel you installed — use *Remove panels & nodes* for that.

---

## 💜 Donate

If this saved you time, a small tip keeps the project alive:

<!-- Replace the placeholders below with your real wallet addresses, then commit. -->
| Asset | Address |
|---|---|
| USDT (TRC20) | `YOUR_USDT_TRC20_ADDRESS_HERE` |
| USDT (BEP20)  | `YOUR_USDT_BEP20_ADDRESS_HERE` |
| TON | `YOUR_TON_ADDRESS_HERE` |
| BTC | `YOUR_BTC_ADDRESS_HERE` |

Support / contact: **@erisrttg**

---

## Credits

Eris Panel Manager is an orchestrator — all the heavy lifting is done by these excellent
upstream projects, installed straight from their official sources:

- [PasarGuard](https://github.com/PasarGuard) · [Marzban](https://github.com/Gozargah/Marzban) ·
  [Marzneshin](https://github.com/marzneshin/Marzneshin) · [3x‑ui](https://github.com/MHSanaei/3x-ui)
- [acme.sh](https://github.com/acmesh-official/acme.sh)
- [spoof-tunnel](https://github.com/ParsaKSH/spoof-tunnel) · [Eris Tunnel 2](https://github.com/eris4444/eris-tunnel-2)

## License

[MIT](LICENSE) © 2026 eris4444
