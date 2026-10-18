#!/usr/bin/env python3
# ==============================================================================
#  Eris Panel Manager - Web Panel  (Python 3 standard library only, no pip)
#
#  Reads its configuration from the erispm config file (default
#  /etc/eris-panel-manager/config.env) and drives the SAME `erispm` CLI that
#  the terminal menu uses, so the web panel and the TUI share one backend.
#
#  Auth: username + salted-SHA256 password, HMAC-signed expiring cookie.
#  Every action runs `erispm <subcommand>` with a strict allow-list - no shell.
#  License: MIT  (c) 2026 eris4444
# ==============================================================================
import os, sys, re, json, time, hmac, base64, hashlib, secrets, subprocess, ssl
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

CONF_PATH = os.environ.get("ERISPM_CONF", "/etc/eris-panel-manager/config.env")
HERE      = os.path.dirname(os.path.abspath(__file__))
STATIC    = os.path.join(HERE, "static")
ERISPM    = "/usr/local/bin/erispm"
BACKUP_DIR = "/etc/eris-panel-manager/backups"

PANELS = {"pasarguard", "marzban", "marzneshin", "3x-ui"}
NODES  = {"pasarguard-node", "marzban-node", "marzneshin-node"}
TUNNELS = {"spoof", "eris-tunnel-2"}
CERT_METHODS = {"standalone", "nginx", "webroot"}
COOKIE = "erispm_session"
SESSION_TTL = 8 * 3600


# ------------------------------------------------------------------ config ----
def load_conf():
    cfg = {}
    try:
        with open(CONF_PATH, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                cfg[k.strip()] = v.strip()
    except FileNotFoundError:
        pass
    return cfg


# ----------------------------------------------------------------- cookies ----
def sign(payload_b64, secret):
    return hmac.new(secret.encode(), payload_b64.encode(), hashlib.sha256).hexdigest()


def make_token(user, secret):
    payload = {"u": user, "exp": int(time.time()) + SESSION_TTL}
    b = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()
    return f"{b}.{sign(b, secret)}"


def check_token(token, secret):
    try:
        b, mac = token.split(".", 1)
        if not hmac.compare_digest(mac, sign(b, secret)):
            return None
        payload = json.loads(base64.urlsafe_b64decode(b.encode()).decode())
        if payload.get("exp", 0) < time.time():
            return None
        return payload.get("u")
    except Exception:
        return None


# ------------------------------------------------------------------ server ----
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "ErisPanel"
    sys_version = ""

    # --- small helpers --------------------------------------------------------
    def _conf(self):
        return load_conf()

    def _authed(self):
        cfg = self._conf()
        secret = cfg.get("web_secret", "")
        if not secret:
            return None
        cookies = self.headers.get("Cookie", "")
        for part in cookies.split(";"):
            part = part.strip()
            if part.startswith(COOKIE + "="):
                return check_token(part[len(COOKIE) + 1:], secret)
        return None

    def _send(self, code, body=b"", ctype="text/plain; charset=utf-8", extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        if extra:
            for k, v in extra:
                self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code, obj, cookie=None):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _read_body(self):
        try:
            n = int(self.headers.get("Content-Length", 0))
        except ValueError:
            n = 0
        raw = self.rfile.read(n) if n else b""
        try:
            return json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            return {}

    def _static(self, name):
        name = os.path.normpath(name).lstrip("/\\")
        path = os.path.join(STATIC, name)
        if not path.startswith(STATIC) or not os.path.isfile(path):
            return self._send(404, "not found")
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".svg": "image/svg+xml",
        }.get(os.path.splitext(path)[1], "application/octet-stream")
        with open(path, "rb") as f:
            self._send(200, f.read(), ctype)

    # --- routing --------------------------------------------------------------
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        u = urlparse(self.path)
        p = u.path
        if p in ("/", "/index.html"):
            if not self._authed():
                return self._send(302, "", extra=[("Location", "/login")])
            return self._static("index.html")
        if p in ("/login", "/login.html"):
            return self._static("login.html")
        if p.startswith("/static/"):
            return self._static(p[len("/static/"):])
        if p == "/api/status":
            if not self._authed():
                return self._json(401, {"error": "auth"})
            return self._run_json(["status", "--json"])
        if p == "/api/backups":
            if not self._authed():
                return self._json(401, {"error": "auth"})
            return self._json(200, {"backups": self._list_backups()})
        if p == "/api/logout":
            return self._send(302, "", extra=[
                ("Location", "/login"),
                ("Set-Cookie", f"{COOKIE}=; Path=/; Max-Age=0"),
            ])
        return self._send(404, "not found")

    def do_POST(self):
        u = urlparse(self.path)
        p = u.path
        if p == "/api/login":
            return self._login()
        if not self._authed():
            return self._json(401, {"error": "auth"})
        if p == "/api/run":
            return self._run_stream()
        return self._send(404, "not found")

    # --- auth -----------------------------------------------------------------
    def _login(self):
        body = self._read_body()
        cfg = self._conf()
        user = body.get("user", "")
        pw = body.get("pass", "")
        salt = cfg.get("web_salt", "")
        want = cfg.get("web_hash", "")
        secret = cfg.get("web_secret", "")
        calc = hashlib.sha256((salt + pw).encode()).hexdigest()
        time.sleep(0.4)  # mild brute-force damper
        if user == cfg.get("web_user", "admin") and want and hmac.compare_digest(calc, want):
            tok = make_token(user, secret)
            secure = "; Secure" if cfg.get("web_tls", "n") == "y" else ""
            cookie = f"{COOKIE}={tok}; Path=/; HttpOnly; SameSite=Strict; Max-Age={SESSION_TTL}{secure}"
            return self._json(200, {"ok": True}, cookie=cookie)
        return self._json(401, {"ok": False, "error": "invalid credentials"})

    # --- command building (strict allow-list) ---------------------------------
    def _build_cmd(self, action, args):
        a = args or {}
        if action == "install-panel":
            k = a.get("key")
            if k in PANELS:
                return [ERISPM, "install-panel", k], {}
        if action == "install-node":
            k = a.get("key")
            if k in NODES:
                return [ERISPM, "install-node", k], {}
        if action == "delete-panel":
            k = a.get("key")
            if k in (PANELS | NODES):
                cmd = [ERISPM, "delete-panel", k]
                if a.get("purge"):
                    cmd.append("--purge")
                return cmd, {}
        if action == "backup":
            k = a.get("key")
            if k in PANELS:
                return [ERISPM, "backup", k], {}
            if k == "ALL":
                return [ERISPM, "backup", "pasarguard"], {}  # UI loops ALL itself
        if action == "restore":
            k = a.get("key")
            f = os.path.normpath(a.get("archive", ""))
            if k in PANELS and f.startswith(BACKUP_DIR) and os.path.isfile(f):
                return [ERISPM, "restore", k, f], {}
        if action == "cert-issue":
            d = a.get("domain", "")
            m = a.get("method", "standalone")
            if re.match(r"^[A-Za-z0-9._-]+$", d) and m in CERT_METHODS:
                cmd = [ERISPM, "cert", "issue", "--domain", d, "--method", m]
                e = a.get("email", "")
                if re.match(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$", e or ""):
                    cmd += ["--email", e]
                return cmd, {}
        if action == "cert-list":
            return [ERISPM, "cert", "list"], {}
        if action == "tunnel-install":
            w = a.get("what")
            if w in TUNNELS:
                return [ERISPM, "tunnel", "install", w], {}
        if action == "migrate":
            to = a.get("to", "")
            port = str(a.get("port", "22"))
            panels = a.get("panels", "")
            if not re.match(r"^[A-Za-z0-9._@-]+$", to) or not port.isdigit():
                return None, {}
            ok_panels = panels == "ALL" or all(x in PANELS for x in panels.split(","))
            if not ok_panels:
                return None, {}
            cmd = [ERISPM, "migrate", "--to", to, "--port", port, "--panels", panels]
            env = {}
            pw = a.get("password", "")
            if pw:
                env["ERISPM_SSH_PASS"] = pw
                cmd += ["--password-env", "ERISPM_SSH_PASS"]
            if a.get("dry_run"):
                cmd.append("--dry-run")
            return cmd, env
        return None, {}

    # --- run & stream ---------------------------------------------------------
    def _base_env(self, extra):
        env = dict(os.environ)
        env["ERISPM_YES"] = "1"
        env["ERISPM_NONINTERACTIVE"] = "1"
        env["NO_COLOR"] = "1"
        env["ERISPM_CONF"] = CONF_PATH
        env.update(extra or {})
        return env

    def _run_json(self, argv):
        try:
            out = subprocess.run(
                [ERISPM] + argv, capture_output=True, text=True,
                env=self._base_env({}), timeout=30
            ).stdout
            return self._send(200, out, "application/json; charset=utf-8")
        except Exception as e:
            return self._json(500, {"error": str(e)})

    def _run_stream(self):
        body = self._read_body()
        cmd, extra_env = self._build_cmd(body.get("action", ""), body.get("args", {}))
        if not cmd:
            return self._json(400, {"error": "unknown or invalid action"})
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()

        def chunk(data):
            if isinstance(data, str):
                data = data.encode("utf-8", "replace")
            try:
                self.wfile.write(("%X\r\n" % len(data)).encode())
                self.wfile.write(data)
                self.wfile.write(b"\r\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                raise

        try:
            chunk("$ erispm " + " ".join(cmd[1:]) + "\n")
            proc = subprocess.Popen(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                env=self._base_env(extra_env), bufsize=1, text=True
            )
            for line in iter(proc.stdout.readline, ""):
                chunk(line)
            proc.stdout.close()
            rc = proc.wait()
            chunk(f"\n[exit {rc}]\n")
        except Exception as e:
            try:
                chunk(f"\n[error] {e}\n")
            except Exception:
                pass
        finally:
            try:
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except Exception:
                pass

    # --- misc -----------------------------------------------------------------
    def _list_backups(self):
        out = []
        try:
            for fn in sorted(os.listdir(BACKUP_DIR), reverse=True):
                if fn.endswith(".tar.gz"):
                    full = os.path.join(BACKUP_DIR, fn)
                    out.append({
                        "name": fn,
                        "path": full,
                        "size": os.path.getsize(full),
                        "mtime": int(os.path.getmtime(full)),
                    })
        except FileNotFoundError:
            pass
        return out

    def log_message(self, fmt, *args):
        pass  # keep the journal quiet; erispm has its own log


def main():
    cfg = load_conf()
    port = int(cfg.get("web_port", "8787"))
    httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    if cfg.get("web_tls", "n") == "y":
        cert = os.path.join(HERE, "tls", "cert.pem")
        key = os.path.join(HERE, "tls", "key.pem")
        if os.path.isfile(cert) and os.path.isfile(key):
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(cert, key)
            httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    print(f"eris-panel-web listening on :{port}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
