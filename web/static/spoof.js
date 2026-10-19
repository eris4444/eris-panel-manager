/* Eris Panel Manager — a native UI for the Spoof Tunnel backend.
   The tunnel core and its panel backend are the official ParsaKSH/spoof-tunnel;
   this is only an Eris-styled front-end that talks to that backend's REST API
   (through the same-origin reverse proxy in server.py). No iframe, no CDN.
   The backend keeps its own JWT login — you sign in once here with the username
   and password its installer printed; the token lives in the browser only. */
'use strict';
(function (global) {
  const TRANSPORTS = [['tcp', 'TCP (SYN)'], ['udp', 'UDP'], ['icmp', 'ICMP'], ['icmpv6', 'ICMPv6']];
  const TOKEN_KEY = 'token';   // shared with the official panel's own new-tab view
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g,
    c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
  const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

  class Spoof {
    constructor(root) {
      this.root = root;
      this.base = '';          // e.g. "/a1b2c3d4e5"  (API is base + "/api")
      this.ready = false;
      this.token = localStorage.getItem(TOKEN_KEY) || '';
      this.view = 'tunnels';
      this.mounted = false;
      this.timer = 0;          // tunnels auto-refresh
      this.ws = null;          // live-logs socket
      this.tPoll = 0;          // tester poll
      this.editing = null;
    }

    setPanel(sp) {   // sp = /api/spoof result
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
        if (!opts.noRedirect) this.logout(true);   // session expired → back to login
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

    /* ---------------- lifecycle ---------------- */
    mount() {
      this.mounted = true;
      if (!this.ready) { this.renderUnavailable(); return; }
      if (!this.token) { this.view = 'tunnels'; this.renderLogin(); return; }
      if (this.view === 'tester') this.renderTester();
      else if (this.view === 'settings') this.renderSettings();
      else if (this.view === 'editor') this.renderEditor(this.editing);
      else this.renderTunnels();
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
      if (this.mounted) { this.view = 'tunnels'; this.renderLogin(silent ? 'Session expired — sign in again.' : ''); }
    }
    go(view) {
      this.view = view;
      clearInterval(this.timer); this.timer = 0;
      clearInterval(this.tPoll); this.tPoll = 0;
      this.closeWS();
      this.mount();
    }

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
      const direct = this.panel.path ? `http://${esc(global.ErisServerIP || 'SERVER_IP')}:${this.panel.port}${esc(this.panel.path)}` : '';
      return `<div class="sp-sub">
        ${tab('tunnels', '🔗 Tunnels')}
        ${tab('tester', '🔬 Spoof Tester')}
        ${tab('settings', '⚙ Settings')}
        <span class="sp-spacer">
          ${direct ? `<a class="btn btn-ghost btn-sm" href="${esc(this.panel.path)}" target="_blank" rel="noopener" title="${esc(direct)}">Original panel ↗</a>` : ''}
          <button class="btn btn-ghost btn-sm" data-logout>Sign out of Spoof</button>
        </span>
      </div>`;
    }
    bindHeader() {
      this.root.querySelectorAll('[data-go]').forEach(b => b.onclick = () => this.go(b.dataset.go));
      const lo = this.root.querySelector('[data-logout]');
      if (lo) lo.onclick = () => this.logout(false);
    }

    /* ---------------- unavailable / login ---------------- */
    renderUnavailable() {
      const installed = this.panel && this.panel.installed;
      this.root.innerHTML = `<div class="sp-empty">
        <div class="big">🛰️</div>
        <h3>${installed ? 'Spoof panel found, but its address could not be read' : 'Spoof Tunnel is not installed yet'}</h3>
        <p class="sp-muted">${installed
          ? 'Its port / web path could not be read from spoof-panel.service. Make sure the Spoof panel service is set up.'
          : 'Install it from the Tunnels tab, then this page shows your tunnels and the Spoof Tester here.'}</p>
      </div>`;
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
        const err = this.root.querySelector('#sp-login-err');
        err.hidden = true;
        const btn = f.querySelector('button'); btn.disabled = true; btn.textContent = 'Signing in…';
        try {
          const d = await this.api('/auth/login', { method: 'POST', noRedirect: true, body: { username: f.user.value, password: f.pass.value } });
          this.token = d.token;
          try { localStorage.setItem(TOKEN_KEY, d.token); } catch (_) {}
          this.go('tunnels');
        } catch (ex) {
          err.textContent = ex.message === 'unauthorized' ? 'Invalid username or password' : ex.message;
          err.hidden = false;
          btn.disabled = false; btn.textContent = 'Sign in';
        }
      });
    }

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
      this.root.querySelector('[data-new]').onclick = () => this.openEditor(null);
      this.root.querySelector('[data-refresh]').onclick = () => this.loadTunnels();
      await this.loadTunnels();
      clearInterval(this.timer);
      this.timer = setInterval(() => { if (this.view === 'tunnels') this.loadTunnels(true); }, 4000);
    }
    async loadTunnels(quiet) {
      let list;
      try { list = await this.api('/instances'); }
      catch (ex) { if (ex.message !== 'unauthorized' && !quiet) this.toast(ex.message, 'err'); return; }
      if (this.view !== 'tunnels') return;
      list = list || [];
      const n = { running: 0, stopped: 0, error: 0 };
      list.forEach(i => { n[i.status === 'running' ? 'running' : i.status === 'error' ? 'error' : 'stopped']++; });
      this.root.querySelector('#sp-metrics').innerHTML = `
        <div class="sp-metric"><div class="n">${list.length}</div><div class="l">Tunnels</div></div>
        <div class="sp-metric ok"><div class="n">${n.running}</div><div class="l">Running</div></div>
        <div class="sp-metric"><div class="n">${n.stopped}</div><div class="l">Stopped</div></div>
        <div class="sp-metric bad"><div class="n">${n.error}</div><div class="l">Error</div></div>`;
      const box = this.root.querySelector('#sp-tuns');
      if (!list.length) {
        box.innerHTML = `<div class="sp-empty"><div class="big">🔗</div><p>No tunnels yet. Create one to get started.</p></div>`;
        return;
      }
      box.innerHTML = list.map(i => this.tunRow(i)).join('');
      box.querySelectorAll('[data-act]').forEach(b => b.onclick = () => this.tunAction(+b.dataset.id, b.dataset.act));
      box.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => this.openEditor(+b.dataset.edit));
    }
    tunRow(i) {
      const dot = i.status === 'running' ? 'dot-on' : i.status === 'error' ? 'dot-error' : i.status === 'starting' ? 'dot-starting' : 'dot-off';
      const meta = i.mode === 'local'
        ? `${esc(i.remote_addr || '—')}:${i.remote_port} · send ${esc(i.send_transport)} · recv ${esc(i.recv_transport)}`
        : `:${i.listen_port} → ${esc(i.forward_addr || '—')} · send ${esc(i.send_transport)} · recv ${esc(i.recv_transport)}`;
      const spoof = i.spoof_ip_list ? `${i.spoof_ip_list.split('\n').filter(Boolean).length} spoof IPs` : (i.spoof_ip ? esc(i.spoof_ip) : 'no spoof IP');
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
            <div class="sp-tun-meta">${meta} · ${spoof}</div>
            ${i.status_error ? `<div class="sp-tun-meta" style="color:var(--red)">${esc(i.status_error)}</div>` : ''}
          </div>
        </div>
        <div class="sp-tun-actions">
          ${ctl}
          <button class="btn btn-sm" data-edit="${i.id}">Edit</button>
        </div>
      </div>`;
    }
    async tunAction(id, act) {
      try { await this.api('/instances/' + id + '/' + act, { method: 'POST' }); this.toast(act + 'ed', 'ok'); }
      catch (ex) { if (ex.message !== 'unauthorized') this.toast(ex.message, 'err'); }
      setTimeout(() => this.loadTunnels(true), 700);
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
      const field = (label, name, val, type = 'text') =>
        `<label>${label}<input name="${name}" type="${type}" value="${esc(val)}"></label>`;
      this.root.innerHTML = this.header('tunnels') + `
        <div class="section-head">
          <h2>${isNew ? 'New tunnel' : 'Edit — ' + esc(c.name)}</h2>
          <button class="btn btn-ghost" data-back>← Back to tunnels</button>
        </div>
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
                    <option value="local"${c.mode === 'local' ? ' selected' : ''}>Local (client side)</option>
                    <option value="remote"${c.mode === 'remote' ? ' selected' : ''}>Remote (server side)</option>
                  </select></label>
                </div>
                <div class="card"><h3>Transport</h3>
                  <label>Send transport<select name="send_transport">${topt(c.send_transport)}</select></label>
                  <label>Recv transport<select name="recv_transport">${topt(c.recv_transport)}</select></label>
                  <label>XDP interface <span class="sp-muted">(Linux, optional — blank = off)</span>
                    <input name="xdp_interface" value="${esc(c.xdp_interface || '')}" placeholder="e.g. eth0"></label>
                </div>
                <div class="card" data-mode="local">
                  <h3>Local mode</h3>
                  ${field('Listen address (your traffic → here)', 'listen_addr', c.listen_addr)}
                  ${field('Remote server IP', 'remote_addr', c.remote_addr)}
                  <div class="sp-grid2">
                    ${field('Remote port', 'remote_port', c.remote_port, 'number')}
                    ${field('Recv port', 'recv_port', c.recv_port, 'number')}
                  </div>
                </div>
                <div class="card" data-mode="remote">
                  <h3>Remote mode</h3>
                  ${field('Listen port', 'listen_port', c.listen_port, 'number')}
                  ${field('Forward to', 'forward_addr', c.forward_addr)}
                  <div class="sp-grid2">
                    ${field('Client IP', 'client_ip', c.client_ip)}
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
                  Tip: the Spoof Tester fills this for you.</p>
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
      const applyMode = () => {
        const m = form.mode.value;
        this.root.querySelectorAll('[data-mode]').forEach(d => d.hidden = d.dataset.mode !== m);
      };
      form.mode.onchange = applyMode; applyMode();
      const ta = form.spoof_ip_list, cnt = this.root.querySelector('#sp-ipcount');
      const upd = () => { const v = ta.value.trim(); cnt.textContent = v ? '(' + v.split('\n').filter(l => l.trim()).length + ' IPs)' : ''; };
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
      } catch (ex) {
        if (ex.message !== 'unauthorized') this.toast(ex.message, 'err');
        btn.disabled = false;
      }
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
      let first = true;
      let ws;
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
        <div class="sp-seg" id="sp-tmode">
          <button data-m="receiver" class="active">📡 Receiver</button>
          <button data-m="sender">📤 Sender</button>
        </div>
        <div class="grid two">
          <div class="card"><h3 id="sp-tcfg-title">Receiver config</h3>
            <form class="form" id="sp-tform">
              <label>Protocol<select name="protocol">
                <option value="icmp">ICMP</option><option value="tcp">TCP</option></select></label>
              <div data-only="sender">${''}
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
      const upd = () => { const v = ta.value.trim(); cnt.textContent = v ? '(' + v.split('\n').filter(l => l.trim()).length + ' lines)' : ''; };
      ta.addEventListener('input', upd);
      const file = this.root.querySelector('#sp-tfile');
      this.root.querySelector('[data-upload]').onclick = () => file.click();
      file.onchange = async () => {
        if (!file.files[0]) return;
        try { const fd = new FormData(); fd.append('file', file.files[0]); const d = await this.api('/tester/upload', { method: 'POST', body: fd }); ta.value = d.content || ''; upd(); }
        catch (ex) { if (ex.message !== 'unauthorized') this.toast(ex.message, 'err'); }
        file.value = '';
      };
      form.addEventListener('submit', e => { e.preventDefault(); this.startTester(form); });
      this.pollTester(true);
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
    pollTester(once) {
      clearInterval(this.tPoll);
      const tick = async () => {
        let s;
        try { s = await this.api('/tester/status'); } catch (_) { return; }
        if (this.view !== 'tester') { clearInterval(this.tPoll); return; }
        this.renderTesterResults(s);
        if (s.status !== 'running') clearInterval(this.tPoll);
      };
      tick();
      if (!once) this.tPoll = setInterval(tick, 2000);
      else this.tPoll = setInterval(() => { this.api('/tester/status').then(s => { if (s.status === 'running' && this.view === 'tester') { this.renderTesterResults(s); this.pollTester(); } }).catch(() => {}); }, 3000);
    }
    renderTesterResults(s) {
      const box = this.root.querySelector('#sp-tres'); if (!box) return;
      const res = s.results || [];
      if (s.status === 'idle' && !res.length) {
        box.innerHTML = `<div class="sp-empty"><div class="big">🔬</div><p>Start a test to see results here.</p></div>`;
        return;
      }
      const passed = s.passed_count || res.filter(r => r.passed).length;
      const total = s.total_ips || res.length;
      const live = s.status === 'running' && s.mode === 'receiver';
      const rows = res.slice(0, 500).map(r => `<tr>
        <td class="sp-mono">${esc(r.ip)}</td><td>${r.received}/${r.sent}</td>
        <td style="color:${r.loss_pct <= 10 ? 'var(--green)' : r.loss_pct <= 30 ? 'var(--yellow)' : 'var(--red)'}">${r.loss_pct.toFixed(1)}%</td>
        <td class="${r.passed ? 'sp-pass' : 'sp-fail'}">${r.passed ? 'PASS' : 'FAIL'}</td></tr>`).join('');
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
          <div class="sp-metric ok"><div class="n">${passed}</div><div class="l">Passed</div></div>
          <div class="sp-metric acc"><div class="n">${res.length}</div><div class="l">Received</div></div>
        </div>
        <div class="head-actions" style="margin:.9rem 0">
          ${s.status === 'running'
            ? '<button class="btn btn-danger btn-sm" data-tstop>⏹ Stop</button>'
            : (passed ? '<button class="btn btn-sm" data-tcopy>📋 Copy passed</button><button class="btn btn-sm" data-tdl>📥 Download</button>' : '')}
        </div>
        ${res.length ? `<div style="max-height:360px;overflow:auto;border:1px solid var(--line);border-radius:10px">
          <table class="tbl"><thead><tr><th>IP</th><th>Recv</th><th>Loss</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}`;
      const passedIPs = () => res.filter(r => r.passed).map(r => r.ip).join('\n');
      const stop = box.querySelector('[data-tstop]'); if (stop) stop.onclick = async () => { try { await this.api('/tester/stop', { method: 'POST' }); this.toast('Stopped', 'ok'); } catch (_) {} };
      const cp = box.querySelector('[data-tcopy]'); if (cp) cp.onclick = () => { this.copy(passedIPs()); this.toast('Copied ' + passed + ' IPs', 'ok'); };
      const dl = box.querySelector('[data-tdl]'); if (dl) dl.onclick = () => this.download('spoof-ips.txt', passedIPs() + '\n');
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
          <div class="card"><h3>About</h3>
            <p class="hint">This is an Eris-designed interface over the official
              <a href="https://github.com/ParsaKSH/spoof-tunnel" target="_blank" rel="noopener noreferrer">ParsaKSH/spoof-tunnel</a>
              backend. The tunnel core and its API are upstream and unchanged.</p>
            ${this.panel.path ? `<p class="hint sp-mono">Direct panel: ${esc('http://' + (global.ErisServerIP || 'SERVER_IP') + ':' + this.panel.port + this.panel.path)}</p>` : ''}
          </div>
        </div>`;
      this.bindHeader();
      const f = this.root.querySelector('#sp-pwform'), err = this.root.querySelector('#sp-pwerr');
      f.addEventListener('submit', async e => {
        e.preventDefault(); err.hidden = true;
        if (f.new.value !== f.new2.value) { err.textContent = 'New passwords do not match'; err.hidden = false; return; }
        const btn = f.querySelector('button'); btn.disabled = true;
        try {
          const d = await this.api('/settings/password', { method: 'PUT', noRedirect: true, body: { old_password: f.old.value, new_password: f.new.value } });
          if (d && d.token) { this.token = d.token; try { localStorage.setItem(TOKEN_KEY, d.token); } catch (_) {} }
          this.toast('Password changed', 'ok'); f.reset();
        } catch (ex) { err.textContent = ex.message === 'unauthorized' ? 'Wrong current password' : ex.message; err.hidden = false; }
        btn.disabled = false;
      });
    }
  }

  global.ErisSpoof = { create: root => new Spoof(root) };
})(window);
