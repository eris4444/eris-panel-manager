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
#  Tasks run on a real pseudo-terminal (Linux), so installers that ask
#  questions can be answered from the browser's terminal.
#  License: MIT  (c) 2026 eris4444
# ==============================================================================
import os, sys, re, json, time, hmac, base64, hashlib, secrets, subprocess, ssl
import select, signal, socket, threading, http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

try:  # real terminal support (Linux / BSD / macOS)
    import pty, termios, fcntl, struct
    HAVE_PTY = True
except ImportError:  # e.g. Windows - plain pipes, for local development only
    HAVE_PTY = False

CONF_PATH = os.environ.get("ERISPM_CONF", "/etc/eris-panel-manager/config.env")
HERE      = os.path.dirname(os.path.abspath(__file__))
STATIC    = os.path.join(HERE, "static")
ERISPM    = os.environ.get("ERISPM_BIN", "/usr/local/bin/erispm")
BACKUP_DIR = "/etc/eris-panel-manager/backups"
IMPORT_TMP = "/etc/eris-panel-manager/state/cert-import"

PANELS = {"pasarguard", "marzban", "marzneshin", "3x-ui"}
NODES  = {"pasarguard-node", "marzban-node", "marzneshin-node"}
TUNNELS = {"spoof", "eris-tunnel-2"}
CERT_METHODS = {"standalone", "nginx", "webroot"}
COOKIE = "erispm_session"
SESSION_TTL = 8 * 3600

REPLAY_MAX = 2 * 1024 * 1024   # bytes of task output kept for re-attaching
CHUNK_MAX  = 256 * 1024        # largest piece sent in one stream chunk
INPUT_MAX  = 64 * 1024         # largest keystroke/paste batch accepted
BODY_MAX   = 1024 * 1024       # largest JSON request body accepted
PROXY_BODY_MAX = 64 * 1024 * 1024   # largest upload passed to the Spoof panel

# the official Spoof Tunnel panel (ParsaKSH/spoof-tunnel), as its installer sets it up
SPOOF_UNIT = os.environ.get("ERISPM_SPOOF_UNIT", "/etc/systemd/system/spoof-panel.service")
SPOOF_BIN  = "/usr/local/bin/spoof-panel"
HOP_HEADERS = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te",
               "trailer", "transfer-encoding", "upgrade", "host", "cookie", "content-length"}
TLS_ON = False


def erispm_argv():
    # A .py stand-in is accepted so the web panel can be developed without bash.
    if ERISPM.endswith(".py"):
        return [sys.executable, ERISPM]
    return [ERISPM]


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


# -------------------------------------------------------------------- jobs ----
# One task at a time. Its output is kept in a replay buffer, so a browser that
# reloads (or loses its connection) re-attaches from any byte offset.
class Job:
    def __init__(self, title, argv, env, cleanup, rows, cols):
        self.id = secrets.token_hex(6)
        self.title = title
        self.argv, self.env, self.cleanup = argv, env, cleanup or []
        self.rows, self.cols = rows, cols
        self.pty = HAVE_PTY
        self.cond = threading.Condition()
        self.io = threading.Lock()   # guards the pty fd against close-while-writing
        self.buf = bytearray()
        self.base = 0                # stream offset of buf[0]
        self.done = False
        self.rc = None
        self.started = int(time.time())
        self.ended = None
        self.pid = None              # child = session & process-group leader
        self.fd = None               # pty master
        self.proc = None             # pipe fallback
        self.line = bytearray()      # pipe fallback: the line being typed

    # --- output buffer ---------------------------------------------------------
    def end(self):
        return self.base + len(self.buf)

    def append(self, data):
        if not data:
            return
        with self.cond:
            self.buf += data
            over = len(self.buf) - REPLAY_MAX
            if over > 0:
                # cut on a line boundary when one is near, so a replay starts cleanly
                nl = self.buf.find(b"\n", over, over + 4096)
                cut = nl + 1 if nl >= 0 else over
                del self.buf[:cut]
                self.base += cut
            self.cond.notify_all()

    def info(self):
        return {"id": self.id, "title": self.title, "done": self.done, "rc": self.rc,
                "started": self.started, "ended": self.ended, "pty": self.pty,
                "end": self.end()}

    # --- start -----------------------------------------------------------------
    def start(self):
        self.append(("\x1b[38;5;244m$ " + self.title + "\x1b[0m\r\n").encode("utf-8", "replace"))
        if self.pty:
            self._start_pty()
            target = self._pump_pty
        else:
            self._start_pipe()
            target = self._pump_pipe
        threading.Thread(target=target, name="job-" + self.id, daemon=True).start()

    def _start_pty(self):
        argv, env = self.argv, self.env
        winsz = struct.pack("HHHH", self.rows, self.cols, 0, 0)
        pid, fd = pty.fork()
        if pid == 0:
            # child: already a session leader with the pty as its controlling tty
            try:
                fcntl.ioctl(0, termios.TIOCSWINSZ, winsz)
                if hasattr(termios, "IUTF8"):
                    at = termios.tcgetattr(0)
                    at[0] |= termios.IUTF8
                    termios.tcsetattr(0, termios.TCSANOW, at)
            except Exception:
                pass
            try:
                os.execvpe(argv[0], argv, env)
            except Exception as e:
                os.write(2, ("cannot run %s: %s\r\n" % (argv[0], e)).encode())
            os._exit(127)
        self.pid, self.fd = pid, fd
        fl = fcntl.fcntl(fd, fcntl.F_GETFL)
        fcntl.fcntl(fd, fcntl.F_SETFL, fl | os.O_NONBLOCK)

    def _start_pipe(self):
        kw = {}
        if os.name == "posix":
            kw["start_new_session"] = True
        self.proc = subprocess.Popen(
            self.argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, env=self.env, bufsize=0, **kw)
        self.pid = self.proc.pid

    # --- output pumps ----------------------------------------------------------
    def _pump_pty(self):
        fd, status, exited_at = self.fd, 0, None
        while True:
            try:
                r, _, _ = select.select([fd], [], [], 0.25)
            except (OSError, ValueError):
                break
            if r:
                try:
                    data = os.read(fd, 65536)
                except BlockingIOError:
                    data = None
                except OSError:      # EIO: the last slave fd is closed
                    break
                if data == b"":
                    break
                if data:
                    self.append(data)
                    if exited_at is not None:
                        exited_at = time.time()
                    continue
            if exited_at is None:
                try:
                    wpid, st = os.waitpid(self.pid, os.WNOHANG)
                except ChildProcessError:
                    wpid, st = self.pid, 0
                if wpid == self.pid:
                    status, exited_at = st, time.time()
            elif time.time() - exited_at > 1.0:
                break  # the task ended; something it left in the background holds the tty
        if exited_at is None:
            try:
                _, status = os.waitpid(self.pid, 0)
            except ChildProcessError:
                status = 0
        with self.io:
            try:
                os.close(fd)
            except OSError:
                pass
            self.fd = None
        if os.WIFEXITED(status):
            rc = os.WEXITSTATUS(status)
        elif os.WIFSIGNALED(status):
            rc = 128 + os.WTERMSIG(status)
        else:
            rc = 1
        self._finish(rc)

    def _pump_pipe(self):
        out = self.proc.stdout
        while True:
            try:
                data = os.read(out.fileno(), 65536)
            except OSError:
                break
            if not data:
                break
            self.append(data.replace(b"\n", b"\r\n"))  # what the tty's ONLCR would do
        try:
            out.close()
        except Exception:
            pass
        self._finish(self.proc.wait())

    def _finish(self, rc):
        for pth in self.cleanup:
            try:
                os.remove(pth)
            except Exception:
                pass
        color = "38;5;114" if rc == 0 else "38;5;203"
        self.append(("\r\n\x1b[%sm[exit %d]\x1b[0m\r\n" % (color, rc)).encode())
        with self.cond:
            self.rc = rc
            self.ended = int(time.time())
            self.done = True
            self.cond.notify_all()

    # --- control ---------------------------------------------------------------
    def write(self, data):
        if self.done:
            return False
        if self.pty:
            return self._write_pty(data)
        return self._write_pipe(data)

    def _write_pty(self, data):
        deadline = time.time() + 3
        view = memoryview(data)
        with self.io:
            if self.fd is None:
                return False
            while len(view):
                try:
                    n = os.write(self.fd, view)
                    view = view[n:]
                except BlockingIOError:
                    if time.time() > deadline:
                        return False
                    select.select([], [self.fd], [], 0.2)
                except OSError:
                    return False
        return True

    def _write_pipe(self, data):
        # Without a tty nobody echoes or edits lines, so emulate a tiny cooked
        # mode: echo, backspace, Enter -> newline, Ctrl-C -> interrupt, Ctrl-D -> EOF.
        data = re.sub(rb"\x1b(\[[0-9;?]*[ -/]*[@-~]|O.|.)", b"", data)
        echo, send = bytearray(), bytearray()
        for b in data:
            if b == 3:
                echo += b"^C\r\n"
                self.line.clear()
                self.signal("INT")
            elif b == 4:
                send += self.line
                self.line.clear()
                self._pipe_send(send)
                send = bytearray()
                try:
                    self.proc.stdin.close()
                except Exception:
                    pass
            elif b in (10, 13):
                send += self.line + b"\n"
                self.line.clear()
                echo += b"\r\n"
            elif b in (8, 127):
                if self.line:
                    self.line.pop()
                    echo += b"\b \b"
            elif b >= 32 or b == 9:
                self.line.append(b)
                echo.append(b)
        self.append(bytes(echo))
        return self._pipe_send(send)

    def _pipe_send(self, data):
        if not data:
            return True
        try:
            self.proc.stdin.write(bytes(data))
            self.proc.stdin.flush()
            return True
        except Exception:
            return False

    def signal(self, name):
        if self.done:
            return False
        sig = {"INT": signal.SIGINT, "TERM": signal.SIGTERM,
               "KILL": getattr(signal, "SIGKILL", signal.SIGTERM)}.get(name)
        if sig is None:
            return False
        try:
            if os.name == "posix":
                os.killpg(self.pid, sig)   # the whole task: erispm and its children
            elif name == "KILL":
                self.proc.kill()
            else:
                self.proc.terminate()
            return True
        except Exception:
            return False

    def resize(self, rows, cols):
        self.rows, self.cols = rows, cols
        if not self.pty or self.done:
            return
        with self.io:
            if self.fd is not None:
                try:   # the kernel sends SIGWINCH to the foreground process group
                    fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
                except OSError:
                    pass


JOB_LOCK = threading.Lock()
JOB = None  # the current task, or the last one that ran


def start_job(title, argv, env, cleanup, rows, cols):
    """-> (job, None) when started, (None, running_job) when busy."""
    global JOB
    with JOB_LOCK:
        if JOB is not None and not JOB.done:
            return None, JOB
        job = Job(title, argv, env, cleanup, rows, cols)
        job.start()
        JOB = job
        return job, None


def find_job(jid):
    job = JOB
    if job is not None and jid and job.id == str(jid):
        return job
    return None


# ------------------------------------------------------------- spoof panel ----
# The official Spoof panel runs on its own random port under a random web path
# (/<web_path>/, settings in its SQLite DB). It is shown inside this panel
# UNCHANGED through a same-origin reverse proxy: /<web_path>/... plus the
# root-relative /_next/ assets its Next.js build always asks for.
_SPOOF = {"t": 0.0, "v": None}


def spoof_info():
    now = time.time()
    if now - _SPOOF["t"] > 5:
        _SPOOF["v"], _SPOOF["t"] = _spoof_discover(), now
    return _SPOOF["v"]


def _spoof_discover():
    try:
        with open(SPOOF_UNIT, encoding="utf-8") as f:
            unit = f.read()
    except OSError:
        unit = ""
    if not unit and not os.path.exists(SPOOF_BIN):
        return {"installed": False, "ready": False}
    m = re.search(r"-port[= ]+(\d+)", unit)
    port = int(m.group(1)) if m else 0
    m = re.search(r"SPOOF_DATA_DIR=\"?([^\s\"]+)", unit)
    data_dir = m.group(1) if m else "/etc/spoof-panel"
    web_path = ""
    try:
        import sqlite3
        db = os.path.join(data_dir, "panel.db").replace("\\", "/")
        con = sqlite3.connect("file:%s?mode=ro" % db, uri=True, timeout=2)
        try:
            for k, v in con.execute("SELECT key, value FROM settings WHERE key IN ('web_path', 'panel_port')"):
                if k == "web_path":
                    web_path = str(v)
                elif k == "panel_port" and not port and str(v).isdigit():
                    port = int(v)
        finally:
            con.close()
    except Exception:
        pass
    ready = bool(port) and bool(re.match(r"^[A-Za-z0-9_-]{1,64}$", web_path))
    return {"installed": True, "ready": ready, "port": port if ready else 0,
            "web_path": web_path if ready else ""}


def port_open(port):
    try:
        socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
        return True
    except OSError:
        return False


def _clamp(v, lo, hi, default):
    try:
        return max(lo, min(hi, int(v)))
    except (TypeError, ValueError):
        return default


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
        self.send_header("Cache-Control", "no-store")
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
        if n > BODY_MAX:
            self.close_connection = True
            return {}
        raw = self.rfile.read(n) if n > 0 else b""
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
            return body if isinstance(body, dict) else {}
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
            self._send(200, f.read(), ctype, extra=[("Cache-Control", "no-cache")])

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
            to = self._spoof_login_redirect()
            if to:
                return self._send(302, "", extra=[("Location", to)])
            return self._static("login.html")
        if p.startswith("/static/"):
            return self._static(p[len("/static/"):])
        if p == "/api/logout":
            return self._send(302, "", extra=[
                ("Location", "/login"),
                ("Set-Cookie", f"{COOKIE}=; Path=/; Max-Age=0"),
            ])
        if not p.startswith("/api/"):
            return self._spoof_or_404(p)
        if not self._authed():
            return self._json(401, {"error": "auth"})
        if p == "/api/status":
            return self._run_json(["status", "--json"])
        if p == "/api/backups":
            return self._json(200, {"backups": self._list_backups()})
        if p == "/api/spoof":
            sp = dict(spoof_info())
            if sp.get("ready"):
                sp["running"] = port_open(sp["port"])
                sp["path"] = "/" + sp["web_path"] + "/"
            return self._json(200, sp)
        if p == "/api/job":
            job = JOB
            return self._json(200, {"job": job.info() if job else None})
        if p == "/api/stream":
            return self._stream(parse_qs(u.query))
        return self._send(404, "not found")

    def do_PUT(self):   # only the embedded Spoof panel uses these methods
        self._spoof_or_404(urlparse(self.path).path)

    do_DELETE = do_PATCH = do_OPTIONS = do_PUT

    def do_POST(self):
        u = urlparse(self.path)
        p = u.path
        if not p.startswith("/api/"):
            return self._spoof_or_404(p)
        if p == "/api/login":
            return self._login()
        body = self._read_body()   # always drain it, or a kept-alive connection desyncs
        if not self._authed():
            return self._json(401, {"error": "auth"})
        # browsers cannot send a cross-site JSON POST without a CORS preflight
        if not self.headers.get("Content-Type", "").startswith("application/json"):
            return self._json(415, {"error": "expected application/json"})
        if p == "/api/run":
            return self._run(body)
        if p in ("/api/input", "/api/signal", "/api/resize"):
            job = find_job(body.get("job"))
            if job is None:
                return self._json(404, {"error": "no such task"})
            if p == "/api/input":
                data = body.get("data", "")
                if not isinstance(data, str) or len(data) > INPUT_MAX:
                    return self._json(400, {"error": "bad input"})
                return self._json(200, {"ok": job.write(data.encode("utf-8", "replace"))})
            if p == "/api/signal":
                return self._json(200, {"ok": job.signal(str(body.get("sig", "")))})
            job.resize(_clamp(body.get("rows"), 2, 400, 24), _clamp(body.get("cols"), 10, 500, 80))
            return self._json(200, {"ok": True})
        return self._send(404, "not found")

    # --- auth -----------------------------------------------------------------
    def _login(self):
        body = self._read_body()
        cfg = self._conf()
        user = body.get("user", "")
        pw = body.get("pass", "")
        if not isinstance(user, str) or not isinstance(pw, str):
            return self._json(400, {"ok": False, "error": "bad request"})
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
    # Returns (cmd_list, extra_env, cleanup_paths) or (None, {}, []).
    def _apply_ok(self, v):
        if not v or v == "none":
            return None
        if v == "all":
            return "all"
        if all(x in PANELS for x in v.split(",")):
            return v
        return None

    def _build_cmd(self, action, args):
        a = args if isinstance(args, dict) else {}
        if action == "menu":
            return [ERISPM, "menu"], {}, []
        if action == "install-panel":
            k = a.get("key")
            if k in PANELS:
                return [ERISPM, "install-panel", k] + (["--force"] if a.get("force") else []), {}, []
        if action == "install-node":
            k = a.get("key")
            if k in NODES:
                return [ERISPM, "install-node", k] + (["--force"] if a.get("force") else []), {}, []
        if action == "delete-panel":
            k = a.get("key")
            if k in (PANELS | NODES):
                cmd = [ERISPM, "delete-panel", k]
                if a.get("purge"):
                    cmd.append("--purge")
                return cmd, {}, []
        if action == "backup":
            k = a.get("key")
            if k in PANELS:
                return [ERISPM, "backup", k], {}, []
            if k == "ALL":
                return [ERISPM, "backup", "pasarguard"], {}, []  # UI loops ALL itself
        if action == "restore":
            k = a.get("key")
            f = os.path.normpath(str(a.get("archive", "")))
            if k in PANELS and f.startswith(BACKUP_DIR) and os.path.isfile(f):
                return [ERISPM, "restore", k, f], {}, []
        if action == "cert-issue":
            d = str(a.get("domain", ""))
            m = a.get("method", "standalone")
            if re.match(r"^[A-Za-z0-9._-]+$", d) and m in CERT_METHODS:
                cmd = [ERISPM, "cert", "issue", "--domain", d, "--method", m]
                e = str(a.get("email", "") or "")
                if re.match(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$", e):
                    cmd += ["--email", e]
                ap = self._apply_ok(a.get("apply", ""))
                if ap:
                    cmd += ["--apply", ap]
                return cmd, {}, []
        if action == "cert-apply":
            d = str(a.get("domain", ""))
            ap = self._apply_ok(a.get("apply", ""))
            if re.match(r"^[A-Za-z0-9._-]+$", d) and ap:
                return [ERISPM, "cert", "apply", "--domain", d, "--panel", ap], {}, []
        if action == "cert-sync":
            d = str(a.get("domain", ""))
            if re.match(r"^[A-Za-z0-9._-]+$", d):
                return [ERISPM, "cert", "sync", d], {}, []
        if action == "cert-import":
            d = str(a.get("domain", ""))
            cert = str(a.get("cert", ""))
            key = str(a.get("key", ""))
            if not re.match(r"^[A-Za-z0-9._-]+$", d) or "BEGIN" not in cert or "BEGIN" not in key:
                return None, {}, []
            try:
                os.makedirs(IMPORT_TMP, exist_ok=True)
                os.chmod(IMPORT_TMP, 0o700)
                cf = os.path.join(IMPORT_TMP, f"{d}.cert.pem")
                kf = os.path.join(IMPORT_TMP, f"{d}.key.pem")
                with open(os.open(cf, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as fh:
                    fh.write(cert)
                with open(os.open(kf, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as fh:
                    fh.write(key)
            except Exception:
                return None, {}, []
            cmd = [ERISPM, "cert", "import", "--domain", d, "--cert-file", cf, "--key-file", kf]
            ap = self._apply_ok(a.get("apply", ""))
            if ap:
                cmd += ["--apply", ap]
            return cmd, {}, [cf, kf]
        if action == "cert-list":
            return [ERISPM, "cert", "list"], {}, []
        if action == "tunnel-install":
            w = a.get("what")
            if w in TUNNELS:
                return [ERISPM, "tunnel", "install", w], {}, []
        if action == "migrate":
            to = str(a.get("to", ""))
            port = str(a.get("port", "22"))
            panels = str(a.get("panels", ""))
            if not re.match(r"^[A-Za-z0-9._@-]+$", to) or not port.isdigit():
                return None, {}, []
            ok_panels = panels == "ALL" or all(x in PANELS for x in panels.split(","))
            if not ok_panels:
                return None, {}, []
            cmd = [ERISPM, "migrate", "--to", to, "--port", port, "--panels", panels]
            env = {}
            pw = str(a.get("password", "") or "")
            if pw:
                env["ERISPM_SSH_PASS"] = pw
                cmd += ["--password-env", "ERISPM_SSH_PASS"]
            if a.get("dry_run"):
                cmd.append("--dry-run")
            return cmd, env, []
        return None, {}, []

    # --- run ------------------------------------------------------------------
    def _base_env(self, extra):
        env = dict(os.environ)
        env.setdefault("HOME", "/root")   # systemd services may start without HOME
        env["ERISPM_YES"] = "1"
        env["ERISPM_NONINTERACTIVE"] = "1"
        env["NO_COLOR"] = "1"
        env["ERISPM_CONF"] = CONF_PATH
        env.update(extra or {})
        return env

    def _job_env(self, extra, interactive):
        env = dict(os.environ)
        env.setdefault("HOME", "/root")
        env["TERM"] = "xterm-256color"
        env.pop("NO_COLOR", None)
        env["ERISPM_CONF"] = CONF_PATH
        if interactive:   # `erispm menu` asks its own questions
            env.pop("ERISPM_YES", None)
            env.pop("ERISPM_NONINTERACTIVE", None)
        else:             # form actions: erispm takes the defaults, upstream installers may still ask
            env["ERISPM_YES"] = "1"
            env["ERISPM_NONINTERACTIVE"] = "1"
        env.update(extra or {})
        return env

    def _run_json(self, argv):
        try:
            out = subprocess.run(
                erispm_argv() + argv, capture_output=True, text=True,
                env=self._base_env({}), timeout=30
            ).stdout
            return self._send(200, out, "application/json; charset=utf-8",
                              extra=[("Cache-Control", "no-store")])
        except Exception as e:
            return self._json(500, {"error": str(e)})

    def _run(self, body):
        action = body.get("action", "")
        cmd, extra_env, cleanup = self._build_cmd(action, body.get("args", {}))
        if not cmd:
            return self._json(400, {"error": "unknown or invalid action"})
        rows = _clamp(body.get("rows"), 2, 400, 24)
        cols = _clamp(body.get("cols"), 10, 500, 80)
        argv = erispm_argv() + cmd[1:]
        title = "erispm " + " ".join(cmd[1:])
        try:
            job, busy = start_job(title, argv, self._job_env(extra_env, action == "menu"),
                                  cleanup, rows, cols)
        except Exception as e:
            for pth in cleanup:
                try:
                    os.remove(pth)
                except Exception:
                    pass
            return self._json(500, {"error": f"could not start: {e}"})
        if busy is not None:
            for pth in cleanup:
                try:
                    os.remove(pth)
                except Exception:
                    pass
            return self._json(409, {"error": "another task is running", "job": busy.info()})
        return self._json(200, {"job": job.info()})

    # --- stream ---------------------------------------------------------------
    # Raw terminal bytes from ?from=<offset> until the task ends. X-Stream-From
    # tells the client where the data really starts (older output may be trimmed).
    def _stream(self, q):
        job = find_job((q.get("job") or [""])[0])
        if job is None:
            return self._json(404, {"error": "no such task"})
        try:
            pos = max(0, int((q.get("from") or ["0"])[0]))
        except ValueError:
            pos = 0
        with job.cond:
            pos = min(max(pos, job.base), job.end())
        self.close_connection = True
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Cache-Control", "no-cache, no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("X-Stream-From", str(pos))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        while True:
            with job.cond:
                if pos >= job.end() and not job.done:
                    job.cond.wait(5)
                if pos < job.base:
                    break      # fell behind the replay buffer - the client reconnects
                i = pos - job.base
                data = bytes(job.buf[i:i + CHUNK_MAX])
                finished = job.done and pos + len(data) >= job.end()
            if data:
                if not self._chunk(data):
                    return
                pos += len(data)
                continue
            if finished:
                break
            if self._client_gone():
                return
        self._chunk(b"")

    def _chunk(self, data):
        try:
            if data:
                self.wfile.write(b"%X\r\n%s\r\n" % (len(data), data))
            else:
                self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
            return True
        except (OSError, ValueError):
            return False

    def _client_gone(self):
        # a streaming GET never sends more bytes, so "readable" means closed
        try:
            r, _, _ = select.select([self.connection], [], [], 0)
            return bool(r)
        except (OSError, ValueError):
            return True

    # --- the embedded Spoof panel (reverse proxy) --------------------------------
    def _spoof_target(self, path):
        """-> spoof info when this path belongs to the Spoof panel, else None."""
        sp = spoof_info()
        if not sp.get("ready"):
            return None
        wp = "/" + sp["web_path"]
        if (path == wp or path.startswith(wp + "/") or path.startswith("/_next/")
                or re.match(r"^/[\w.-]+\.(ico|svg|png|txt)$", path)):
            return sp
        return None

    def _spoof_or_404(self, path):
        sp = self._spoof_target(path)
        if sp is None or not self._authed():
            self._drain_body()
            if sp is None:
                return self._send(404, "not found")
            if self.command == "GET":
                return self._send(302, "", extra=[("Location", "/login")])
            return self._send(401, "sign in to the panel first")
        return self._proxy(sp)

    def _spoof_login_redirect(self):
        # The Spoof panel sends an expired session to the root "/login", which is
        # ours here - send it back to its own login page instead.
        sp = spoof_info()
        if not sp.get("ready"):
            return None
        wp = "/" + sp["web_path"]
        ref = urlparse(self.headers.get("Referer", "")).path
        from_spoof = self.headers.get("Sec-Fetch-Dest", "") == "iframe" or ref == wp or ref.startswith(wp + "/")
        if from_spoof and self._authed():
            return wp + "/login/"
        return None

    def _drain_body(self):
        try:
            n = int(self.headers.get("Content-Length", 0))
        except ValueError:
            n = 0
        if n > BODY_MAX or self.headers.get("Transfer-Encoding"):
            self.close_connection = True
        elif n > 0:
            self.rfile.read(n)

    def _proxy(self, sp):
        port = sp["port"]
        if self.headers.get("Transfer-Encoding"):
            self.close_connection = True
            return self._send(411, "chunked request bodies are not supported")
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n > PROXY_BODY_MAX:
            self.close_connection = True
            return self._send(413, "request too large")
        body = self.rfile.read(n) if n > 0 else None
        if "websocket" in self.headers.get("Upgrade", "").lower():
            return self._proxy_ws(port)
        # our session cookie stays here; the Spoof panel uses its own bearer token
        hdrs = {k: v for k, v in self.headers.items() if k.lower() not in HOP_HEADERS}
        hdrs["Host"] = "127.0.0.1:%d" % port
        hdrs["X-Forwarded-For"] = self.client_address[0]
        hdrs["X-Forwarded-Proto"] = "https" if TLS_ON else "http"
        if body is not None:
            hdrs["Content-Length"] = str(len(body))
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=120)
        try:
            conn.request(self.command, self.path, body=body, headers=hdrs)
            resp = conn.getresponse()
        except (OSError, http.client.HTTPException) as e:
            conn.close()
            return self._send(502, f"the Spoof panel is not answering on 127.0.0.1:{port} ({e})")
        try:
            self._relay(resp)
        except (OSError, ValueError, http.client.HTTPException):
            self.close_connection = True
        finally:
            conn.close()

    def _relay(self, resp):
        self.send_response(resp.status, resp.reason)
        length = resp.getheader("Content-Length")
        for k, v in resp.getheaders():
            if k.lower() in HOP_HEADERS or k.lower() in ("date", "server", "x-frame-options"):
                continue
            self.send_header(k, v)
        self.send_header("X-Frame-Options", "SAMEORIGIN")   # framed by this panel, nobody else
        no_body = self.command == "HEAD" or resp.status in (204, 304) or resp.status < 200
        if length is not None:
            self.send_header("Content-Length", length)
        elif not no_body:
            self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        if no_body:
            return
        if length is not None:
            left = int(length)
            while left > 0:
                data = resp.read(min(65536, left))
                if not data:
                    self.close_connection = True
                    break
                self.wfile.write(data)
                left -= len(data)
            return
        read = getattr(resp, "read1", resp.read)
        while True:
            data = read(65536)
            if not data:
                break
            self.wfile.write(b"%X\r\n%s\r\n" % (len(data), data))
        self.wfile.write(b"0\r\n\r\n")

    def _proxy_ws(self, port):
        # WebSocket (the Spoof panel's live tunnel logs): replay the handshake to
        # the panel, then pass bytes both ways until one side closes.
        try:
            up = socket.create_connection(("127.0.0.1", port), timeout=10)
        except OSError as e:
            return self._send(502, f"the Spoof panel is not answering on 127.0.0.1:{port} ({e})")
        self.close_connection = True
        try:
            head = ["%s %s HTTP/1.1" % (self.command, self.path), "Host: 127.0.0.1:%d" % port]
            head += ["%s: %s" % (k, v) for k, v in self.headers.items() if k.lower() not in ("host", "cookie")]
            up.sendall(("\r\n".join(head) + "\r\n\r\n").encode("latin-1", "replace"))
            resp = b""
            while b"\r\n\r\n" not in resp and len(resp) < 65536:
                data = up.recv(4096)
                if not data:
                    break
                resp += data
            self.wfile.write(resp)
            if not resp.startswith(b"HTTP/1.1 101"):
                return
            up.settimeout(None)
            self.connection.settimeout(None)
            self._pipe(self.connection, up)
        except (OSError, ValueError):
            pass
        finally:
            try:
                up.close()
            except OSError:
                pass

    def _pipe(self, a, b):
        while True:
            pending = getattr(a, "pending", None)   # TLS may hold bytes select() can't see
            if pending and pending():
                ready = [a]
            else:
                ready, _, _ = select.select([a, b], [], [], 300)
            for s in ready:
                data = s.recv(65536)
                if not data:
                    return
                (b if s is a else a).sendall(data)

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
    global TLS_ON
    cfg = load_conf()
    port = int(cfg.get("web_port", "8787"))
    httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    httpd.daemon_threads = True
    if cfg.get("web_tls", "n") == "y":
        cert = os.path.join(HERE, "tls", "cert.pem")
        key = os.path.join(HERE, "tls", "key.pem")
        if os.path.isfile(cert) and os.path.isfile(key):
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(cert, key)
            httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
            TLS_ON = True
    mode = "pty" if HAVE_PTY else "pipes (no pty on this OS)"
    print(f"eris-panel-web listening on :{port}  [{mode}]", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
