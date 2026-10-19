/* Eris Panel Manager — a native UI for the Spoof Tunnel backend.
   The tunnel core and its panel backend are the official ParsaKSH/spoof-tunnel;
   this is only an Eris-styled front-end that talks to that backend's REST API
   (through the same-origin reverse proxy in server.py). No iframe, no CDN.
   The backend keeps its own login — you sign in once here with the username and
   password its installer printed (or create the first admin); the token lives in
   the browser only. */
'use strict';
(function (global) {
  const TRANSPORTS = [['tcp', 'TCP (SYN)'], ['udp', 'UDP'], ['icmp', 'ICMP'], ['icmpv6', 'ICMPv6']];
  const PRESETS = [   // transport pairs (send / recv); the other server mirrors them
    ['tcp', 'tcp', 'TCP both ways (simplest)'],
    ['udp', 'udp', 'UDP both ways'],
    ['tcp', 'udp', 'Send TCP · Recv UDP'],
    ['udp', 'tcp', 'Send UDP · Recv TCP'],
    ['icmp', 'icmp', 'ICMP both ways'],
  ];
  const INSTALL_CMD = 'curl -fsSL https://raw.githubusercontent.com/eris4444/eris-panel-manager/main/install.sh | bash';
  const TOKEN_KEY = 'token';   // shared with the official panel's own new-tab view
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g,
    c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
  const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const lines = s => String(s || '').split('\n').map(x => x.trim()).filter(Boolean);

  class Spoof {
    constructor(root) {
      this.root = root;
      this.base = '';
      this.ready = false;
      this.token = localStorage.getItem(TOKEN_KEY) || '';
      this.view = 'tunnels';
      this.authMode = 'login';
      this.mounted = false;
      this.timer = 0; this.ws = null; this.tPoll = 0;
      this.editing = null;
      this.lastSig = '';      // tunnels list signature, to avoid re-render churn
      this.tuns = [];         // last known tunnels (for the Tester → tunnel picker)
    }

    setPanel(sp) {
      this.ready = !!(sp && sp.ready);
      this.base = this.ready ? ('/' + sp.web_path) : '';
      this.panel = sp || {};
    }

    /* ---------------- backend calls ---------------- */
    async api(path, opts = {}) {
      const o = Object.assign({ headers: {} }, opts);
      o.headers = Object.assign({}, opts.headers);
      if (this.token) o.headers['Authorization'] = 'Bearer ' + this.token;
      if (o.body !== undefined && !(o.body instanceof FormData)) {
        o.headers['Content-Type'] = 'application/json';
        o.body = JSON.stringify(o.body);
      }
      const r = await fetch(this.base + '/api' + path, o);
      if (r.status === 401) {
        if (!opts.noRedirect) this.logout(true);
        throw new Error('unauthorized');
      }
      let data = null;
      try { data = await r.json(); } catch (_) {}
      if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
      return data;
    }
    wsURL(path) {
      const p = location.protocol === 'https:' ? 'wss:' : 'ws:';
      return p + '//' + location.host + this.base + '/api' + path +
        (path.indexOf('?') < 0 ? '?' : '&') + 'token=' + encodeURIComponent(this.token);
    }
    // a call to the ERIS panel itself (not the Spoof backend) — uses the Eris cookie
    async erisApi(path, body) {
      const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (r.status === 401) { location.href = '/login'; throw new Error('eris-auth'); }
      let d = null; try { d = await r.json(); } catch (_) {}
      if (!r.ok) throw new Error((d && d.error) || ('HTTP ' + r.status));
      return d;
    }

    /* ---------------- lifecycle ---------------- */
    async mount() {
      this.mounted = true;
      if (!this.ready) { this.renderUnavailable(); return; }
      if (!this.token) {
        this.renderAuthLoading();
        try { const c = await this.api('/auth/check', { noRedirect: true }); this.authMode = (c && c.needs_setup) ? 'setup' : 'login'; }
        catch (_) { this.authMode = 'login'; }
        if (!this.mounted || this.token) return;
        if (this.authMode === 'setup') this.renderSetup(); else this.renderLogin();
        return;
      }
      ({ tunnels: () => this.renderTunnels(), editor: () => this.renderEditor(this.editing),
         newpick: () => this.renderNewPicker(), tester: () => this.renderTester(),
         settings: () => this.renderSettings(), guide: () => this.renderGuide() }[this.view]
         || (() => this.renderTunnels()))();
    }
    unmount() {
      this.mounted = false;
      clearInterval(this.timer); this.timer = 0;
      clearInterval(this.tPoll); this.tPoll = 0;
      this.closeWS();
    }
    closeWS() { if (this.ws) { try { this.ws.close(); } catch (_) {} this.ws = null; } }
    logout(silent) {
      this.token = '';
      try { localStorage.removeItem(TOKEN_KEY); } catch (_) {}
      this.closeWS();
      if (this.mounted) { this.view = 'tunnels'; this.authMode = 'login'; this.renderLogin(silent ? 'Session expired — sign in again.' : ''); }
    }
    go(view) {
      this.view = view;
      clearInterval(this.timer); this.timer = 0;
      clearInterval(this.tPoll); this.tPoll = 0;
      this.closeWS();
      this.mount();
    }
    openFresh() { if (this.token) this.view = 'tunnels'; }   // caller shows the tab, which mounts

    toast(msg, kind) {
      let t = this.root.querySelector('.sp-toast');
      if (!t) { t = el('<div class="sp-toast"></div>'); this.root.appendChild(t); }
      t.className = 'sp-toast ' + (kind || '');
      t.textContent = msg;
      requestAnimationFrame(() => t.classList.add('show'));
      clearTimeout(this._tt);
      this._tt = setTimeout(() => t.classList.remove('show'), 2600);
    }

    header(active) {
      const tab = (id, label) => `<button class="sp-tab${active === id ? ' active' : ''}" data-go="${id}">${label}</button>`;
      return `<div class="sp-sub">
        ${tab('tunnels', '🔗 Tunnels')}
        ${tab('tester', '🔬 Spoof Tester')}
        ${tab('guide', '❓ Guide')}
        ${tab('settings', '⚙ Settings')}
        <span class="sp-spacer">
          ${this.panel.path ? `<a class="btn btn-ghost btn-sm" href="${esc(this.panel.path)}" target="_blank" rel="noopener">Original panel ↗</a>` : ''}
          <button class="btn btn-ghost btn-sm" data-logout>Sign out of Spoof</button>
        </span>
      </div>`;
    }
    bindHeader() {
      this.root.querySelectorAll('[data-go]').forEach(b => b.onclick = () => this.go(b.dataset.go));
      const lo = this.root.querySelector('[data-logout]');
      if (lo) lo.onclick = () => this.logout(false);
    }
    bindCopy() {
      this.root.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => {
        this.copy(b.dataset.copy); this.toast('Copied', 'ok');
      });
    }

    /* ---------------- unavailable / auth ---------------- */
    renderUnavailable() {
      const installed = this.panel && this.panel.installed;
      this.root.innerHTML = `<div class="sp-empty">
        <div class="big">🛰️</div>
        <h3>${installed ? 'Spoof panel found, but its address could not be read' : 'Spoof Tunnel is not installed yet'}</h3>
        <p class="sp-muted">${installed
          ? 'Its port / web path could not be read from spoof-panel.service.'
          : 'Install it, then manage your tunnels and the Spoof Tester right here.'}</p>
        ${installed ? '' : `<div class="sp-cmd"><code>${esc(INSTALL_CMD)}</code><button class="btn btn-sm" data-copy="${esc(INSTALL_CMD)}">Copy</button></div>
          <p class="sp-muted">then:&nbsp; <code>erispm tunnel install spoof</code> &nbsp;(or the Tunnels tab → Install)</p>`}
      </div>`;
      this.bindCopy();
    }
    renderAuthLoading() {
      this.root.innerHTML = `<div class="sp-empty"><div class="big">🔐</div><p class="sp-muted">Checking the Spoof panel…</p></div>`;
    }
    renderLogin(note) {
      this.root.innerHTML = `
        <div class="sp-login">
          <div class="card">
            <h3>Sign in to Spoof</h3>
            <p class="sp-muted" style="font-size:.82rem;margin:.1rem 0 1.1rem">
              Use the username and password the Spoof Tunnel installer printed. It is kept in this browser only.</p>
            ${note ? `<p class="err">${esc(note)}</p>` : ''}
            <form class="form" id="sp-login-form">
              <label>Username<input name="user" autocomplete="username" required></label>
              <label>Password<input name="pass" type="password" autocomplete="current-password" required></label>
              <p class="err" id="sp-login-err" hidden></p>
              <button class="btn btn-primary btn-block" type="submit">Sign in</button>
            </form>
          </div>
        </div>`;
      const f = this.root.querySelector('#sp-login-form');
      f.addEventListener('submit', async e => {
        e.preventDefault();
        const err = this.root.querySelector('#sp-login-err'); err.hidden = true;
        const btn = f.querySelector('button'); btn.disabled = true; btn.textContent = 'Signing in…';
        try {
          const d = await this.api('/auth/login', { method: 'POST', noRedirect: true, body: { username: f.user.value, password: f.pass.value } });
          this.saveToken(d.token); this.go('tunnels');
        } catch (ex) {
          err.textContent = ex.message === 'unauthorized' ? 'Invalid username or password' : ex.message;
          err.hidden = false; btn.disabled = false; btn.textContent = 'Sign in';
        }
      });
    }
    renderSetup() {
      this.root.innerHTML = `
        <div class="sp-login">
          <div class="card">
            <h3>Set up the Spoof panel</h3>
            <p class="sp-muted" style="font-size:.82rem;margin:.1rem 0 1.1rem">
              No admin exists yet. Create one to start — it becomes this panel's login.</p>
            <form class="form" id="sp-setup-form">
              <label>New username<input name="user" autocomplete="username" required></label>
              <label>New password<input name="pass" type="password" autocomplete="new-password" required minlength="4"></label>
              <label>Confirm password<input name="pass2" type="password" autocomplete="new-password" required></label>
              <p class="err" id="sp-setup-err" hidden></p>
              <button class="btn btn-primary btn-block" type="submit">Create admin</button>
            </form>
          </div>
        </div>`;
      const f = this.root.querySelector('#sp-setup-form'), err = this.root.querySelector('#sp-setup-err');
      f.addEventListener('submit', async e => {
        e.preventDefault(); err.hidden = true;
        if (f.pass.value !== f.pass2.value) { err.textContent = 'Passwords do not match'; err.hidden = false; return; }
        const btn = f.querySelector('button'); btn.disabled = true;
        try {
          const d = await this.api('/auth/setup', { method: 'POST', noRedirect: true, body: { username: f.user.value, password: f.pass.value } });
          this.saveToken(d.token); this.toast('Admin created', 'ok'); this.go('tunnels');
        } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
      });
    }
    saveToken(t) { this.token = t || ''; try { localStorage.setItem(TOKEN_KEY, this.token); } catch (_) {} }

    /* ---------------- tunnels ---------------- */
    async renderTunnels() {
      this.root.innerHTML = this.header('tunnels') +
        `<div class="section-head"><h2>Tunnels</h2>
          <div class="head-actions">
            <button class="btn btn-ghost" data-refresh>↻ Refresh</button>
            <button class="btn btn-primary" data-new>+ New tunnel</button>
          </div></div>
        <div id="sp-metrics" class="sp-metrics"></div>
        <div id="sp-tuns" class="sp-tun"><p class="sp-muted">Loading…</p></div>`;
      this.bindHeader();
      this.root.querySelector('[data-new]').onclick = () => this.go('newpick');
      this.root.querySelector('[data-refresh]').onclick = () => { this.lastSig = ''; this.loadTunnels(); };
      this.lastSig = '';
      await this.loadTunnels();
      clearInterval(this.timer);
      this.timer = setInterval(() => { if (this.view === 'tunnels' && !document.hidden) this.loadTunnels(true); }, 4000);
    }
    async loadTunnels(quiet) {
      let list;
      try { list = await this.api('/instances'); }
      catch (ex) { if (ex.message !== 'unauthorized' && !quiet) this.toast(ex.message, 'err'); return; }
      if (this.view !== 'tunnels') return;
      list = list || []; this.tuns = list;
      const sig = JSON.stringify(list.map(i => [i.id, i.name, i.status, i.mode, i.remote_addr, i.remote_port,
        i.listen_port, i.forward_addr, i.send_transport, i.recv_transport, (i.spoof_ip_list || '').length, i.status_error]));
      if (sig === this.lastSig) return;   // nothing changed → don't churn the DOM (fixes click races)
      this.lastSig = sig;
      const n = { running: 0, stopped: 0, error: 0 };
      list.forEach(i => { n[i.status === 'running' ? 'running' : i.status === 'error' ? 'error' : 'stopped']++; });
      this.root.querySelector('#sp-metrics').innerHTML = `
        <div class="sp-metric"><div class="n">${list.length}</div><div class="l">Tunnels</div></div>
        <div class="sp-metric ok"><div class="n">${n.running}</div><div class="l">Running</div></div>
        <div class="sp-metric"><div class="n">${n.stopped}</div><div class="l">Stopped</div></div>
        <div class="sp-metric bad"><div class="n">${n.error}</div><div class="l">Error</div></div>`;
      const box = this.root.querySelector('#sp-tuns');
      if (!list.length) {
        box.innerHTML = `<div class="sp-empty"><div class="big">🔗</div><p>No tunnels yet. Create one to get started.</p>
          <p class="sp-muted">New here? Open the <b>Guide</b> tab first.</p></div>`;
        return;
      }
      box.innerHTML = list.map(i => this.tunRow(i)).join('');
      box.querySelectorAll('[data-act]').forEach(b => b.onclick = () => this.tunAction(+b.dataset.id, b.dataset.act));
      box.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => this.openEditor(+b.dataset.edit));
    }
    tunRow(i) {
      const dot = i.status === 'running' ? 'dot-on' : i.status === 'error' ? 'dot-error' : i.status === 'starting' ? 'dot-starting' : 'dot-off';
      const meta = i.mode === 'local'
        ? `→ ${esc(i.remote_addr || '—')}:${i.remote_port} · send ${esc(i.send_transport)} · recv ${esc(i.recv_transport)}`
        : `:${i.listen_port} → ${esc(i.forward_addr || '—')} · send ${esc(i.send_transport)} · recv ${esc(i.recv_transport)}`;
      const spoof = i.spoof_ip_list ? `${lines(i.spoof_ip_list).length} spoof IPs` : (i.spoof_ip ? esc(i.spoof_ip) : 'no spoof IP');
      const up = (i.status === 'running' && i.uptime) ? ' · up ' + this.dur(i.uptime) : '';
      const run = i.status === 'running';
      const ctl = run
        ? `<button class="btn btn-sm" data-act="restart" data-id="${i.id}">🔄<span> Restart</span></button>
           <button class="btn btn-sm btn-danger" data-act="stop" data-id="${i.id}">⏹<span> Stop</span></button>`
        : `<button class="btn btn-sm btn-primary" data-act="start" data-id="${i.id}">▶<span> Start</span></button>`;
      return `<div class="sp-tun-row">
        <div class="sp-tun-main">
          <span class="dot ${dot}"></span>
          <div>
            <div class="sp-tun-name">${esc(i.name)} <span class="sp-mode ${i.mode === 'local' ? 'local' : 'remote'}">${esc((i.mode || '').toUpperCase())}</span></div>
            <div class="sp-tun-meta">${meta} · ${spoof}${up}</div>
            ${i.status_error ? `<div class="sp-tun-meta" style="color:var(--red)">${esc(i.status_error)}</div>` : ''}
          </div>
        </div>
        <div class="sp-tun-actions">${ctl}<button class="btn btn-sm" data-edit="${i.id}">Edit</button></div>
      </div>`;
    }
    dur(s) { s = s | 0; const h = s / 3600 | 0, m = (s % 3600) / 60 | 0; return h ? h + 'h ' + m + 'm' : m ? m + 'm' : s + 's'; }
    async tunAction(id, act) {
      try { await this.api('/instances/' + id + '/' + act, { method: 'POST' }); this.toast(act + 'ed', 'ok'); }
      catch (ex) { if (ex.message !== 'unauthorized') this.toast(ex.message, 'err'); }
      this.lastSig = '';
      setTimeout(() => this.loadTunnels(true), 700);
    }

    /* ---------------- new-tunnel wizard (Iran / Foreign) ---------------- */
    renderNewPicker() {
      this.root.innerHTML = this.header('tunnels') + `
        <div class="section-head"><h2>New tunnel — which side is this server?</h2>
          <button class="btn btn-ghost" data-back>← Back</button></div>
        <p class="hint">A Spoof tunnel always has two ends. Set up each server as the matching side.</p>
        <div class="grid two">
          <button class="card sp-pick" data-mode="local">
            <h3>🇮🇷 Iran side <span class="sp-mode local">LOCAL</span></h3>
            <p class="sp-muted">The client. Your apps/WireGuard send traffic to it; it tunnels out to the
              foreign server. Choose this on the server inside Iran.</p>
          </button>
          <button class="card sp-pick" data-mode="remote">
            <h3>🌍 Foreign side <span class="sp-mode remote">REMOTE</span></h3>
            <p class="sp-muted">The server. Receives from the Iran side and forwards to your service
              (e.g. WireGuard). Choose this on the server abroad.</p>
          </button>
        </div>`;
      this.bindHeader();
      this.root.querySelector('[data-back]').onclick = () => this.go('tunnels');
      this.root.querySelectorAll('.sp-pick').forEach(b => b.onclick = () => {
        this.editing = { mode: b.dataset.mode, name: b.dataset.mode === 'local' ? 'Iran tunnel' : 'Foreign tunnel' };
        this.go('editor');
      });
    }

    /* ---------------- editor ---------------- */
    async openEditor(id) {
      this.editing = null;
      if (id != null) {
        try { const d = await this.api('/instances/' + id); this.editing = d.instance; }
        catch (ex) { if (ex.message !== 'unauthorized') this.toast(ex.message, 'err'); return; }
      }
      this.go('editor');
    }
    renderEditor(inst) {
      const c = Object.assign({
        id: 0, name: '', mode: 'local', send_transport: 'tcp', recv_transport: 'udp',
        listen_addr: '127.0.0.1:5000', remote_addr: '', remote_port: 8090, recv_port: 5001,
        listen_port: 8090, forward_addr: '127.0.0.1:51820', client_ip: '', client_port: 5001,
        spoof_ip: '', spoof_port: 443, peer_spoof_ip: '', spoof_ip_list: '', xdp_interface: ''
      }, inst || {});
      const isNew = !c.id;
      const topt = (v) => TRANSPORTS.map(([val, lab]) => `<option value="${val}"${v === val ? ' selected' : ''}>${lab}</option>`).join('');
      const popt = PRESETS.map(([s, r, lab]) => `<option value="${s},${r}"${(c.send_transport === s && c.recv_transport === r) ? ' selected' : ''}>${lab}</option>`).join('')
        + '<option value="custom">Custom…</option>';
      const field = (label, name, val, type = 'text') =>
        `<label>${label}<input name="${name}" type="${type}" value="${esc(val)}"></label>`;
      const roleBanner = isNew
        ? (c.mode === 'local'
          ? '🇮🇷 <b>Iran side (Local)</b> — set <b>Remote server IP</b> to your foreign server. Send your traffic to the Listen address.'
          : '🌍 <b>Foreign side (Remote)</b> — set <b>Client IP</b> to your Iran server. Forward to your service (e.g. WireGuard).')
        : '';
      this.root.innerHTML = this.header('tunnels') + `
        <div class="section-head">
          <h2>${isNew ? 'New tunnel' : 'Edit — ' + esc(c.name)}</h2>
          <button class="btn btn-ghost" data-back>← Back to tunnels</button>
        </div>
        ${roleBanner ? `<p class="sp-banner">${roleBanner}</p>` : ''}
        <div class="sp-editor">
          <div class="sp-seg" id="sp-eseg">
            <button data-seg="config" class="active">⚙ Config</button>
            <button data-seg="spoofips">📋 Spoof IPs</button>
            ${isNew ? '' : '<button data-seg="logs">📝 Live logs</button>'}
          </div>
          <form class="form" id="sp-eform">
            <div data-pane="config">
              <div class="grid two">
                <div class="card"><h3>General</h3>
                  ${field('Name', 'name', c.name)}
                  <label>Mode<select name="mode">
                    <option value="local"${c.mode === 'local' ? ' selected' : ''}>Local (Iran / client)</option>
                    <option value="remote"${c.mode === 'remote' ? ' selected' : ''}>Remote (foreign / server)</option>
                  </select></label>
                </div>
                <div class="card"><h3>Transport</h3>
                  <label>Preset<select name="preset">${popt}</select></label>
                  <div class="sp-grid2">
                    <label>Send<select name="send_transport">${topt(c.send_transport)}</select></label>
                    <label>Recv<select name="recv_transport">${topt(c.recv_transport)}</select></label>
                  </div>
                  <p class="sp-mirror" id="sp-mirror"></p>
                  <label>XDP interface <span class="sp-muted">(Linux, optional — blank = off)</span>
                    <input name="xdp_interface" value="${esc(c.xdp_interface || '')}" placeholder="e.g. eth0"></label>
                </div>
                <div class="card" data-mode="local">
                  <h3>Local mode (Iran)</h3>
                  ${field('Listen address (your traffic → here)', 'listen_addr', c.listen_addr)}
                  ${field('Remote server IP (foreign)', 'remote_addr', c.remote_addr)}
                  <div class="sp-grid2">
                    ${field('Remote port', 'remote_port', c.remote_port, 'number')}
                    ${field('Recv port', 'recv_port', c.recv_port, 'number')}
                  </div>
                </div>
                <div class="card" data-mode="remote">
                  <h3>Remote mode (foreign)</h3>
                  ${field('Listen port', 'listen_port', c.listen_port, 'number')}
                  ${field('Forward to (your service)', 'forward_addr', c.forward_addr)}
                  <div class="sp-grid2">
                    ${field('Client IP (Iran)', 'client_ip', c.client_ip)}
                    ${field('Client port', 'client_port', c.client_port, 'number')}
                  </div>
                </div>
                <div class="card"><h3>Spoof</h3>
                  ${field('Spoof IP (single — or use the list)', 'spoof_ip', c.spoof_ip)}
                  <div class="sp-grid2">
                    ${field('Spoof port', 'spoof_port', c.spoof_port, 'number')}
                    ${field('Peer spoof IP', 'peer_spoof_ip', c.peer_spoof_ip)}
                  </div>
                </div>
              </div>
            </div>
            <div data-pane="spoofips" hidden>
              <div class="card">
                <h3>Spoof IP list <span class="sp-muted" id="sp-ipcount"></span></h3>
                <p class="hint">One per line — single IPs, CIDR (<code>10.0.0.0/24</code>) or ranges
                  (<code>172.16.0.1-172.16.0.50</code>). Used round-robin as spoofed source addresses.
                  Tip: the Spoof Tester can fill this for you.</p>
                <textarea name="spoof_ip_list" rows="14" class="sp-mono"
                  placeholder="1.2.3.4&#10;10.0.0.0/24">${esc(c.spoof_ip_list || '')}</textarea>
              </div>
            </div>
            ${isNew ? '' : '<div data-pane="logs" hidden><div class="card"><h3>Live logs</h3><div class="sp-logs" id="sp-elogs">Connecting…</div></div></div>'}
            <div class="head-actions">
              <button class="btn btn-primary" type="submit" data-save>${isNew ? 'Create tunnel' : 'Save changes'}</button>
              ${isNew ? '' : `<button class="btn btn-danger" type="button" data-del>Delete</button>`}
            </div>
          </form>
        </div>`;
      this.bindHeader();
      this.root.querySelector('[data-back]').onclick = () => this.go('tunnels');
      const form = this.root.querySelector('#sp-eform');
      const mirror = this.root.querySelector('#sp-mirror');
      const applyMode = () => {
        const m = form.mode.value;
        this.root.querySelectorAll('[data-mode]').forEach(d => d.hidden = d.dataset.mode !== m);
      };
      const applyMirror = () => {
        mirror.textContent = 'On the OTHER server set → Send: ' + form.recv_transport.value + ' · Recv: ' + form.send_transport.value + ' (mirrored)';
      };
      form.mode.onchange = applyMode; applyMode();
      form.preset.onchange = () => {
        if (form.preset.value === 'custom') return;
        const [s, r] = form.preset.value.split(',');
        form.send_transport.value = s; form.recv_transport.value = r; applyMirror();
      };
      const syncPreset = () => {
        const v = form.send_transport.value + ',' + form.recv_transport.value;
        form.preset.value = [...form.preset.options].some(o => o.value === v) ? v : 'custom';
        applyMirror();
      };
      form.send_transport.onchange = syncPreset; form.recv_transport.onchange = syncPreset;
      applyMirror();
      const ta = form.spoof_ip_list, cnt = this.root.querySelector('#sp-ipcount');
      const upd = () => { const v = lines(ta.value).length; cnt.textContent = v ? '(' + v + ' IPs)' : ''; };
      ta.addEventListener('input', upd); upd();
      this.root.querySelectorAll('#sp-eseg button').forEach(b => b.onclick = () => {
        this.root.querySelectorAll('#sp-eseg button').forEach(x => x.classList.toggle('active', x === b));
        this.root.querySelectorAll('[data-pane]').forEach(p => p.hidden = p.dataset.pane !== b.dataset.seg);
        if (b.dataset.seg === 'logs') this.streamLogs(c.id, this.root.querySelector('#sp-elogs'));
        else this.closeWS();
      });
      form.addEventListener('submit', e => { e.preventDefault(); this.saveEditor(form, c.id); });
      const del = this.root.querySelector('[data-del]');
      if (del) del.onclick = () => this.deleteInstance(c.id, c.name);
    }
    collect(form) {
      const num = v => parseInt(v, 10) || 0;
      return {
        name: form.name.value.trim() || 'Tunnel', mode: form.mode.value,
        send_transport: form.send_transport.value, recv_transport: form.recv_transport.value,
        xdp_interface: form.xdp_interface.value.trim(),
        listen_addr: form.listen_addr.value.trim(), remote_addr: form.remote_addr.value.trim(),
        remote_port: num(form.remote_port.value), recv_port: num(form.recv_port.value),
        listen_port: num(form.listen_port.value), forward_addr: form.forward_addr.value.trim(),
        client_ip: form.client_ip.value.trim(), client_port: num(form.client_port.value),
        spoof_ip: form.spoof_ip.value.trim(), spoof_port: num(form.spoof_port.value),
        peer_spoof_ip: form.peer_spoof_ip.value.trim(), spoof_ip_list: form.spoof_ip_list.value.trim()
      };
    }
    async saveEditor(form, id) {
      const btn = form.querySelector('[data-save]'); btn.disabled = true;
      try {
        const body = this.collect(form);
        if (id) await this.api('/instances/' + id, { method: 'PUT', body });
        else await this.api('/instances', { method: 'POST', body });
        this.toast(id ? 'Saved' : 'Tunnel created', 'ok');
        this.go('tunnels');
      } catch (ex) { if (ex.message !== 'unauthorized') this.toast(ex.message, 'err'); btn.disabled = false; }
    }
    async deleteInstance(id, name) {
      if (!confirm('Delete tunnel "' + name + '"? It is stopped and removed.')) return;
      try { await this.api('/instances/' + id, { method: 'DELETE' }); this.toast('Deleted', 'ok'); this.go('tunnels'); }
      catch (ex) { if (ex.message !== 'unauthorized') this.toast(ex.message, 'err'); }
    }
    streamLogs(id, box) {
      this.closeWS();
      if (!id || !box) return;
      box.textContent = 'Connecting…';
      let first = true, ws;
      try { ws = new WebSocket(this.wsURL('/instances/' + id + '/logs')); }
      catch (_) { box.textContent = 'cannot open log stream'; return; }
      this.ws = ws;
      ws.onmessage = ev => {
        if (first) { box.textContent = ''; first = false; }
        const line = el('<div></div>');
        const low = ev.data.toLowerCase();
        if (low.includes('error')) line.className = 'le'; else if (low.includes('warn')) line.className = 'lw';
        line.textContent = ev.data;
        box.appendChild(line);
        while (box.childNodes.length > 500) box.removeChild(box.firstChild);
        box.scrollTop = box.scrollHeight;
      };
      ws.onclose = () => { if (this.ws === ws && first) box.textContent = 'Log stream closed (start the tunnel to see logs).'; };
      ws.onerror = () => { if (first) box.textContent = 'log stream error'; };
    }

    /* ---------------- tester ---------------- */
    renderTester() {
      this.root.innerHTML = this.header('tester') + `
        <div class="section-head"><h2>🔬 Spoof Tester</h2></div>
        <p class="hint">Find which spoofed source IPs can reach a destination. Run <b>Receiver</b> on the
          foreign server, then <b>Sender</b> on the Iran side. Passed IPs feed a tunnel's Spoof IP list.</p>
        <div class="card sp-capcard">
          <h3>🩺 Does spoofing work on this server?</h3>
          <p class="hint">If none of your IPs ever pass, test this first. It checks whether this server can make
            spoofed packets at all — and, with SSH to your <b>other</b> server, whether they actually arrive there.</p>
          <div class="head-actions">
            <button class="btn" type="button" data-capquick>Check this server</button>
          </div>
          <div id="sp-capres"></div>
          <details class="sp-capfull">
            <summary>Full check — does a spoofed packet really arrive? (needs SSH to the other server)</summary>
            <form class="form" id="sp-capform">
              <div class="row">
                <label>Other server IP (target)<input name="target" placeholder="203.0.113.9" required></label>
                <label>Spoof IP to try<input name="spoof_ip" value="1.1.1.1"></label>
              </div>
              <div class="row">
                <label>SSH host <span class="sp-muted">(blank = same as target)</span><input name="host"></label>
                <label>SSH user<input name="user" value="root"></label>
                <label>SSH port<input name="port" value="22"></label>
              </div>
              <label>SSH password <span class="sp-muted">(blank = use your key)</span><input name="pass" type="password" autocomplete="off"></label>
              <p class="err" id="sp-caperr" hidden></p>
              <button class="btn btn-primary" type="submit">Run full check</button>
            </form>
          </details>
        </div>
        <div class="sp-seg" id="sp-tmode">
          <button data-m="receiver" class="active">📡 Receiver</button>
          <button data-m="sender">📤 Sender</button>
        </div>
        <div class="grid two">
          <div class="card"><h3 id="sp-tcfg-title">Receiver config</h3>
            <form class="form" id="sp-tform">
              <label>Protocol<select name="protocol">
                <option value="icmp">ICMP</option><option value="tcp">TCP</option></select></label>
              <div data-only="sender">
                <label>Destination IP (receiver server)<input name="dst_ip" placeholder="1.2.3.4"></label>
                <label>Concurrency<input name="concurrency" type="number" value="100" min="1" max="1000"></label>
              </div>
              <label data-only="tcp">Port <span class="sp-muted">(TCP)</span><input name="dst_port" type="number" value="80"></label>
              <label data-only="receiver">Timeout (seconds)<input name="timeout" type="number" value="30" min="5" max="600"></label>
              <label>Packets per IP<input name="packet_count" type="number" value="10" min="1" max="100"></label>
              <label data-only="receiver">Max packet loss %<input name="max_packet_loss" type="number" value="20" min="0" max="100"></label>
              <label>Source IPs <span class="sp-muted" id="sp-tcount"></span>
                <textarea name="ip_list" rows="7" class="sp-mono" placeholder="1.1.1.1&#10;10.0.0.0/8&#10;192.168.1.1-192.168.1.100"></textarea></label>
              <div class="chips">
                <button class="chip" type="button" data-upload>📁 Upload file</button>
                <input type="file" id="sp-tfile" accept=".txt,.csv,.list" hidden>
              </div>
              <p class="err" id="sp-terr" hidden></p>
              <button class="btn btn-primary" type="submit" id="sp-tstart">▶ Start receiver</button>
            </form>
          </div>
          <div class="card"><h3>Status &amp; results</h3><div id="sp-tres"></div></div>
        </div>`;
      this.bindHeader();
      this.tMode = 'receiver';
      const form = this.root.querySelector('#sp-tform');
      const applyMode = () => {
        const proto = form.protocol.value;
        this.root.querySelectorAll('[data-only]').forEach(d => {
          const k = d.dataset.only;
          d.hidden = !((k === this.tMode) || (k === 'tcp' && proto === 'tcp'));
        });
        this.root.querySelector('#sp-tcfg-title').textContent = this.tMode === 'receiver' ? 'Receiver config' : 'Sender config';
        this.root.querySelector('#sp-tstart').textContent = '▶ Start ' + this.tMode;
      };
      this.root.querySelectorAll('#sp-tmode button').forEach(b => b.onclick = () => {
        this.tMode = b.dataset.m;
        this.root.querySelectorAll('#sp-tmode button').forEach(x => x.classList.toggle('active', x === b));
        applyMode();
      });
      form.protocol.onchange = applyMode; applyMode();
      const ta = form.ip_list, cnt = this.root.querySelector('#sp-tcount');
      ta.addEventListener('input', () => { const v = lines(ta.value).length; cnt.textContent = v ? '(' + v + ' lines)' : ''; });
      const file = this.root.querySelector('#sp-tfile');
      this.root.querySelector('[data-upload]').onclick = () => file.click();
      file.onchange = async () => {
        if (!file.files[0]) return;
        try { const fd = new FormData(); fd.append('file', file.files[0]); const d = await this.api('/tester/upload', { method: 'POST', body: fd }); ta.value = d.content || ''; ta.dispatchEvent(new Event('input')); }
        catch (ex) { if (ex.message !== 'unauthorized') this.toast(ex.message, 'err'); }
        file.value = '';
      };
      form.addEventListener('submit', e => { e.preventDefault(); this.startTester(form); });
      // capability check
      this.root.querySelector('[data-capquick]').onclick = (ev) => this.runCapCheck(null, ev.target);
      const cf = this.root.querySelector('#sp-capform');
      cf.addEventListener('submit', e => { e.preventDefault(); this.runCapCheck(cf, cf.querySelector('button')); });
      this.api('/instances').then(l => { this.tuns = l || []; }).catch(() => {});
      this.pollTester();
    }
    async runCapCheck(form, btn) {
      const box = this.root.querySelector('#sp-capres');
      const err = this.root.querySelector('#sp-caperr'); if (err) err.hidden = true;
      let body = {};
      if (form) {
        if (!form.target.value.trim()) { err.textContent = 'Enter the other server IP'; err.hidden = false; return; }
        body = { target: form.target.value.trim(), spoof_ip: form.spoof_ip.value.trim() || '1.1.1.1',
                 ssh: { host: form.host.value.trim(), user: form.user.value.trim() || 'root', port: form.port.value.trim() || '22', pass: form.pass.value } };
      }
      const label = btn ? btn.textContent : '';
      if (btn) { btn.disabled = true; btn.textContent = form ? 'Checking… (a few seconds)' : 'Checking…'; }
      box.innerHTML = '<p class="sp-muted">Checking…</p>';
      try {
        const d = await this.erisApi('/api/spoof-check', body);
        box.innerHTML = this.capResultHtml(d, !!form);
      } catch (ex) {
        if (ex.message !== 'eris-auth') box.innerHTML = '<p class="err">' + esc(ex.message) + '</p>';
      }
      if (btn) { btn.disabled = false; btn.textContent = label; }
    }
    capResultHtml(d, didFull) {
      let h = '';
      h += d.raw_ok
        ? '<p class="sp-cap ok">✓ ' + esc(d.raw_msg) + '</p>'
        : '<p class="sp-cap bad">✗ ' + esc(d.raw_msg) + '<br><span class="sp-muted">Spoofing is impossible on this server — a different provider / server is needed.</span></p>';
      if (d.full) {
        const s = d.full.status;
        const map = {
          PASS: ['ok', '✓ PASS — spoofed packets reached the other server. This server CAN spoof. 🎉'],
          FAIL: ['bad', '✗ FAIL — the spoofed packets did NOT arrive. Your provider most likely blocks spoofing (egress filtering), so Spoof Tunnel will not work from this server.'],
          NO_TCPDUMP: ['warn', 'Could not verify — tcpdump is not installed on the other server. Install it there (apt/dnf/apk install tcpdump) and retry.'],
          NOSSH: ['warn', 'Could not SSH to the other server — check the SSH host / user / port / password.'],
          UNKNOWN: ['warn', 'Could not read a clear result — try again.'],
          ERROR: ['warn', 'Check failed: ' + (d.full.detail || '')],
        };
        const [cls, msg] = map[s] || ['warn', s + (d.full.detail ? ' — ' + d.full.detail : '')];
        h += '<p class="sp-cap ' + cls + '">' + esc(msg) + '</p>';
      } else if (didFull) {
        h += '<p class="sp-muted">(no full result)</p>';
      } else if (d.raw_ok) {
        h += '<p class="sp-muted">Raw sockets work, but that alone does not prove your provider lets spoofed packets leave. Use the full check (needs SSH to your other server) for the real answer.</p>';
      }
      return h;
    }
    async startTester(form) {
      const err = this.root.querySelector('#sp-terr'); err.hidden = true;
      const num = v => parseInt(v, 10) || 0;
      const body = {
        mode: this.tMode, protocol: form.protocol.value, ip_list: form.ip_list.value.trim(),
        dst_ip: form.dst_ip.value.trim(), dst_port: num(form.dst_port.value),
        timeout: num(form.timeout.value), packet_count: num(form.packet_count.value),
        max_packet_loss: num(form.max_packet_loss.value), concurrency: num(form.concurrency.value)
      };
      if (!body.ip_list) { err.textContent = 'Enter source IPs'; err.hidden = false; return; }
      if (this.tMode === 'sender' && !body.dst_ip) { err.textContent = 'Enter the destination IP'; err.hidden = false; return; }
      try { await this.api('/tester/start', { method: 'POST', body }); this.toast('Tester started', 'ok'); this.pollTester(); }
      catch (ex) { if (ex.message !== 'unauthorized') { err.textContent = ex.message; err.hidden = false; } }
    }
    pollTester() {
      clearInterval(this.tPoll);
      const tick = async () => {
        let s;
        try { s = await this.api('/tester/status'); } catch (_) { return; }
        if (this.view !== 'tester') { clearInterval(this.tPoll); return; }
        this.renderTesterResults(s);
        if (s.status !== 'running') clearInterval(this.tPoll);
      };
      tick();
      this.tPoll = setInterval(tick, 2000);
    }
    renderTesterResults(s) {
      const box = this.root.querySelector('#sp-tres'); if (!box) return;
      const res = s.results || [];
      if (s.status === 'idle' && !res.length) {
        box.innerHTML = `<div class="sp-empty"><div class="big">🔬</div><p>Start a test to see results here.</p></div>`;
        return;
      }
      const passedN = s.passed_count || res.filter(r => r.passed).length;
      const total = s.total_ips || res.length;
      const live = s.status === 'running' && s.mode === 'receiver';
      const rows = res.slice(0, 500).map(r => `<tr>
        <td class="sp-mono">${esc(r.ip)}</td><td>${r.received}/${r.sent}</td>
        <td style="color:${r.loss_pct <= 10 ? 'var(--green)' : r.loss_pct <= 30 ? 'var(--yellow)' : 'var(--red)'}">${r.loss_pct.toFixed(1)}%</td>
        <td class="${r.passed ? 'sp-pass' : 'sp-fail'}">${r.passed ? 'PASS' : 'FAIL'}</td></tr>`).join('');
      const tunOpts = (this.tuns || []).map(t => `<option value="${t.id}">${esc(t.name)} (${esc(t.mode)})</option>`).join('');
      box.innerHTML = `
        <div style="display:flex;align-items:center;gap:.6rem;margin-bottom:.6rem">
          <span class="dot ${s.status === 'running' ? 'dot-busy' : s.status === 'error' ? 'dot-error' : 'dot-on'}"></span>
          <b style="text-transform:uppercase">${esc(s.status)}${s.mode ? ' (' + esc(s.mode) + ')' : ''}</b>
          ${live ? `<span class="sp-live">● LIVE · ${s.recv_count || 0} seen</span>` : ''}
        </div>
        ${s.status === 'running' ? `<div class="sp-bar"><div style="width:${s.progress || 0}%"></div></div>` : ''}
        ${s.error ? `<p class="err">${esc(s.error)}</p>` : ''}
        <div class="sp-metrics" style="margin-top:.9rem">
          <div class="sp-metric"><div class="n">${total.toLocaleString()}</div><div class="l">Total</div></div>
          <div class="sp-metric ok"><div class="n">${passedN}</div><div class="l">Passed</div></div>
          <div class="sp-metric acc"><div class="n">${res.length}</div><div class="l">Received</div></div>
        </div>
        <div class="head-actions" style="margin:.9rem 0">
          ${s.status === 'running'
            ? '<button class="btn btn-danger btn-sm" data-tstop>⏹ Stop</button>'
            : (passedN ? '<button class="btn btn-sm" data-tcopy>📋 Copy passed</button><button class="btn btn-sm" data-tdl>📥 Download</button>' : '')}
        </div>
        ${(passedN && s.status !== 'running' && tunOpts) ? `<div class="sp-addrow">
          <span class="sp-muted">Add the ${passedN} passed IPs to:</span>
          <select id="sp-taddsel">${tunOpts}</select>
          <button class="btn btn-sm btn-primary" data-tadd>Add to tunnel</button>
        </div>` : ''}
        ${res.length ? `<div style="max-height:340px;overflow:auto;border:1px solid var(--line);border-radius:10px">
          <table class="tbl"><thead><tr><th>IP</th><th>Recv</th><th>Loss</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}`;
      const passedIPs = () => res.filter(r => r.passed).map(r => r.ip);
      const stop = box.querySelector('[data-tstop]'); if (stop) stop.onclick = async () => { try { await this.api('/tester/stop', { method: 'POST' }); this.toast('Stopped', 'ok'); } catch (_) {} };
      const cp = box.querySelector('[data-tcopy]'); if (cp) cp.onclick = () => { this.copy(passedIPs().join('\n')); this.toast('Copied ' + passedN + ' IPs', 'ok'); };
      const dl = box.querySelector('[data-tdl]'); if (dl) dl.onclick = () => this.download('spoof-ips.txt', passedIPs().join('\n') + '\n');
      const add = box.querySelector('[data-tadd]'); if (add) add.onclick = () => this.addIPsToTunnel(+box.querySelector('#sp-taddsel').value, passedIPs());
    }
    async addIPsToTunnel(id, ips) {
      if (!id || !ips.length) return;
      try {
        const d = await this.api('/instances/' + id);
        const have = new Set(lines(d.instance.spoof_ip_list));
        let added = 0;
        ips.forEach(ip => { if (!have.has(ip)) { have.add(ip); added++; } });
        const merged = [...have].join('\n');
        await this.api('/instances/' + id, { method: 'PUT', body: Object.assign({}, d.instance, { spoof_ip_list: merged }) });
        this.toast(added ? ('Added ' + added + ' IPs (' + have.size + ' total)') : 'Already in the list', 'ok');
      } catch (ex) { if (ex.message !== 'unauthorized') this.toast(ex.message, 'err'); }
    }
    copy(text) {
      if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(text).catch(() => {}); return; }
      const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (_) {} document.body.removeChild(ta);
    }
    download(name, text) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    /* ---------------- guide ---------------- */
    renderGuide() {
      const direct = this.panel.path ? `http://${esc(global.ErisServerIP || 'SERVER_IP')}:${this.panel.port}${esc(this.panel.path)}` : '';
      this.root.innerHTML = this.header('guide') + `
        <div class="section-head"><h2>How Spoof Tunnel works here</h2></div>
        <div class="grid two">
          <div class="card sp-doc">
            <h3>The idea</h3>
            <p>A Spoof tunnel always joins <b>two servers</b> and carries your traffic between them using
              IP‑spoofed packets (TCP‑SYN / UDP / ICMP). You run one end on each server:</p>
            <ul>
              <li>🇮🇷 <b>Iran side = Local</b> — your apps/WireGuard send traffic to its Listen address; it tunnels out.</li>
              <li>🌍 <b>Foreign side = Remote</b> — receives from Iran and forwards to your service (e.g. WireGuard).</li>
            </ul>
            <h3>Step by step</h3>
            <ol>
              <li><b>Install</b> on both servers (command on the right), then install Spoof on each.</li>
              <li><b>Find spoof IPs</b> in the <b>Spoof Tester</b>: Receiver on the foreign server, Sender on Iran.
                Then “Add to tunnel” drops the passing IPs straight into a tunnel.</li>
              <li><b>New tunnel</b> on each server — pick Iran or Foreign; fill the highlighted fields.</li>
              <li><b>Match the transports</b>: the editor shows what to set on the other server (mirrored).</li>
              <li><b>Start</b> both ends and watch the live logs.</li>
            </ol>
            <h3>Use it (recommended: WireGuard)</h3>
            <p>Put WireGuard on top: on Iran set the WG client <code>Endpoint = 127.0.0.1:&lt;Listen port&gt;</code>
              and <code>MTU 1280</code>; on the foreign server WG listens where the tunnel forwards
              (e.g. <code>127.0.0.1:51820</code>). Anything you send to the Iran Listen address comes out abroad.</p>
          </div>
          <div class="card sp-doc">
            <h3>Install command</h3>
            <p class="sp-muted">Run on each server (as root):</p>
            <div class="sp-cmd"><code>${esc(INSTALL_CMD)}</code><button class="btn btn-sm" data-copy="${esc(INSTALL_CMD)}">Copy</button></div>
            <p class="sp-muted">then install Spoof:</p>
            <div class="sp-cmd"><code>erispm tunnel install spoof</code><button class="btn btn-sm" data-copy="erispm tunnel install spoof">Copy</button></div>
            <h3>Field cheat‑sheet</h3>
            <ul class="sp-mini">
              <li><b>Listen address</b> (Iran) — where you send your traffic, e.g. <code>127.0.0.1:5000</code>.</li>
              <li><b>Remote server IP</b> (Iran) — the foreign server's public IP.</li>
              <li><b>Listen port</b> (foreign) — matches the Iran side's Remote port.</li>
              <li><b>Forward to</b> (foreign) — your service, e.g. <code>127.0.0.1:51820</code>.</li>
              <li><b>Client IP</b> (foreign) — the Iran server's public IP.</li>
              <li><b>Spoof IPs</b> — source IPs that passed the Tester, used round‑robin.</li>
            </ul>
            <h3>Troubleshooting</h3>
            <ul class="sp-mini">
              <li>No traffic? Open a tunnel's <b>Live logs</b> on both ends.</li>
              <li>Check the foreign <b>Listen port</b> is open, the spoof IPs <b>passed</b> the Tester,
                and the transports are <b>mirrored</b>.</li>
              <li>Quick sanity test: <code>erispm</code> menu → Tunnels → Quick spoof‑capability check.</li>
            </ul>
            ${direct ? `<p class="sp-muted sp-mono" style="margin-top:.6rem">Original panel: ${esc(direct)}</p>` : ''}
          </div>
        </div>`;
      this.bindHeader();
      this.bindCopy();
    }

    /* ---------------- settings ---------------- */
    renderSettings() {
      this.root.innerHTML = this.header('settings') + `
        <div class="section-head"><h2>Spoof panel settings</h2></div>
        <div class="grid two">
          <div class="card"><h3>Change password</h3>
            <p class="hint">Updates the login of the Spoof panel backend.</p>
            <form class="form" id="sp-pwform">
              <label>Current password<input name="old" type="password" autocomplete="current-password" required></label>
              <label>New password<input name="new" type="password" autocomplete="new-password" required minlength="4"></label>
              <label>Confirm new password<input name="new2" type="password" autocomplete="new-password" required></label>
              <p class="err" id="sp-pwerr" hidden></p>
              <button class="btn btn-primary" type="submit">Change password</button>
            </form>
          </div>
          <div class="card"><h3>Reset / add login <span class="sp-muted">(no current password needed)</span></h3>
            <p class="hint">Set a new username <b>and</b> password for the Spoof panel, done by erispm as root
              (handy if you forgot the password). Tick the box to add a second login instead of replacing.</p>
            <form class="form" id="sp-setform">
              <label>New username <span class="sp-muted">(letters, digits, . _ -)</span><input name="user" autocomplete="off" required></label>
              <label>New password<input name="pass" type="password" autocomplete="new-password" required minlength="4"></label>
              <label>Confirm password<input name="pass2" type="password" autocomplete="new-password" required></label>
              <label class="check"><input type="checkbox" name="add"> Add as an extra user (keep the current login)</label>
              <p class="err" id="sp-seterr" hidden></p>
              <button class="btn btn-primary" type="submit">Apply</button>
            </form>
          </div>
          <div class="card"><h3>About</h3>
            <p class="hint">An Eris-designed interface over the official
              <a href="https://github.com/ParsaKSH/spoof-tunnel" target="_blank" rel="noopener noreferrer">ParsaKSH/spoof-tunnel</a>
              backend. The tunnel core and its API are upstream and unchanged.</p>
            <p class="hint">New to this? Open the <b>Guide</b> tab.</p>
          </div>
        </div>`;
      this.bindHeader();
      const setf = this.root.querySelector('#sp-setform'), serr = this.root.querySelector('#sp-seterr');
      setf.addEventListener('submit', async e => {
        e.preventDefault(); serr.hidden = true;
        if (setf.pass.value !== setf.pass2.value) { serr.textContent = 'Passwords do not match'; serr.hidden = false; return; }
        const add = setf.add.checked;
        if (!add && !confirm('Replace the Spoof panel login with "' + setf.user.value + '"? The old login stops working.')) return;
        const btn = setf.querySelector('button'); btn.disabled = true; btn.textContent = 'Applying…';
        try {
          await this.erisApi('/api/spoof-admin', { op: add ? 'add-user' : 'set-login', user: setf.user.value, pass: setf.pass.value });
          if (add) { this.toast('User "' + setf.user.value + '" added', 'ok'); setf.reset(); }
          else { this.token = ''; try { localStorage.removeItem(TOKEN_KEY); } catch (_) {} this.closeWS(); this.view = 'tunnels'; this.renderLogin('Login updated — sign in with the new username and password.'); return; }
        } catch (ex) {
          if (ex.message !== 'eris-auth') { serr.textContent = ex.message; serr.hidden = false; }
        }
        btn.disabled = false; btn.textContent = 'Apply';
      });
      const f = this.root.querySelector('#sp-pwform'), err = this.root.querySelector('#sp-pwerr');
      f.addEventListener('submit', async e => {
        e.preventDefault(); err.hidden = true;
        if (f.new.value !== f.new2.value) { err.textContent = 'New passwords do not match'; err.hidden = false; return; }
        const btn = f.querySelector('button'); btn.disabled = true;
        try {
          const d = await this.api('/settings/password', { method: 'PUT', noRedirect: true, body: { old_password: f.old.value, new_password: f.new.value } });
          if (d && d.token) this.saveToken(d.token);
          this.toast('Password changed', 'ok'); f.reset();
        } catch (ex) { err.textContent = ex.message === 'unauthorized' ? 'Wrong current password' : ex.message; err.hidden = false; }
        btn.disabled = false;
      });
    }
  }

  global.ErisSpoof = { create: root => new Spoof(root) };
})(window);
