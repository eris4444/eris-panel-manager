/* Eris Panel Manager - web panel client */
'use strict';
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];
const sleep = ms => new Promise(res => setTimeout(res, ms));

const PANEL_KEYS = ['pasarguard','marzban','marzneshin','3x-ui'];
const PRETTY = {
  'pasarguard':'PasarGuard','marzban':'Marzban','marzneshin':'Marzneshin','3x-ui':'3x-ui (Sanaei)',
  'pasarguard-node':'PasarGuard node','marzban-node':'Marzban node','marzneshin-node':'Marzneshin node',
  'spoof-tunnel':'Spoof Tunnel','eris-tunnel-2':'Eris Tunnel 2'
};
let currentTab = 'dashboard';

// GET when body is undefined, JSON POST otherwise; a lost session goes back to /login
async function api(url, body){
  const opt = body === undefined ? {cache:'no-store'}
    : {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)};
  const r = await fetch(url, opt);
  if (r.status === 401){ location.href = '/login'; throw new Error('auth'); }
  return r;
}

/* ---------------- terminal ---------------- */
const consoleEl = $('#console');
const termEl = $('#term');
const tin = $('#term-input');
const T = new ErisTerm(termEl);

// the task this page is attached to (one task runs at a time on the server)
const job = {id:null, done:true, offset:0, replayEnd:0, dec:null, waiters:[]};
let stopStage = 0, stopTimer = 0;

function showConsole(show){
  consoleEl.classList.toggle('collapsed', !show);
  document.body.classList.toggle('console-open', show);
  $('#console-hide').textContent = show ? 'Hide' : 'Show';
}
$('#console-toggle').onclick = () => showConsole(consoleEl.classList.contains('collapsed'));
$('#console-hide').onclick = () => showConsole(consoleEl.classList.contains('collapsed'));
$('#console-size').onclick = () => {
  const big = !consoleEl.classList.contains('expanded');
  consoleEl.classList.toggle('expanded', big);
  document.body.classList.toggle('console-big', big);
  $('#console-size').textContent = big ? 'Shrink' : 'Expand';
  showConsole(true);
};
$('#console-clear').onclick = () => T.clear();

function setJobUI(info){
  const running = !!(info && !info.done);
  $('#run-dot').className = 'dot ' + (running ? 'dot-busy' : 'dot-idle');
  $('#job-title').textContent = info ? info.title : 'idle';
  const st = $('#job-state');
  if (!info){ st.textContent = ''; st.className = 'job-state'; }
  else if (running){ st.textContent = 'running'; st.className = 'job-state run'; }
  else if (info.rc === null || info.rc === undefined){ st.textContent = 'ended'; st.className = 'job-state'; }
  else { st.textContent = 'exit ' + info.rc; st.className = 'job-state ' + (info.rc === 0 ? 'ok' : 'bad'); }
  const stop = $('#job-stop');
  stop.disabled = !running;
  stop.textContent = stopStage ? '■ Kill' : '■ Stop';
  $$('#term-keys .key').forEach(b => b.disabled = !running);
  $('#term-hint').textContent = !running ? 'no task running'
    : info.pty === false ? 'no pty on this OS — line mode only' : 'click the terminal to type';
  T.setActive(running);
}

function attach(info, fresh){
  job.id = info.id; job.done = !!info.done; job.offset = 0;
  job.replayEnd = fresh ? 0 : (info.end || 0);   // replayed bytes never answer terminal queries
  job.dec = new TextDecoder();
  job.waiters = [];
  stopStage = 0; clearTimeout(stopTimer);
  setJobUI(info);
  pump(info.id);
}

// Stream the task's output; on a dropped connection re-attach from the last byte seen.
async function pump(id){
  let fails = 0;
  while (job.id === id){
    try {
      const r = await api(`/api/stream?job=${encodeURIComponent(id)}&from=${job.offset}`);
      if (r.status === 404) break;
      if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);
      const from = parseInt(r.headers.get('X-Stream-From') || '', 10);
      if (from > job.offset) job.offset = from;   // older output was trimmed on the server
      const rd = r.body.getReader();
      for (;;){
        const {value, done} = await rd.read();
        if (done) break;
        if (job.id !== id){ rd.cancel().catch(() => {}); return; }
        T.mute = job.offset < job.replayEnd;
        job.offset += value.length;
        T.write(job.dec.decode(value, {stream:true}));
      }
      fails = 0;
    } catch (e){
      if (e && e.message === 'auth') return;
      fails++;
    }
    T.mute = false;
    if (job.id !== id) return;
    // the stream closed: either the task ended or the connection dropped
    let info = null, ok = false;
    try { info = (await (await api('/api/job')).json()).job; ok = true; } catch (_) {}
    if (ok){
      if (!info || info.id !== id) break;              // the server no longer has this task
      if (info.done && job.offset >= info.end){ finish(info); return; }
    }
    await sleep(Math.min(5000, 500 * (fails + 1)));
  }
  if (job.id === id && !job.done) finish({id, title:$('#job-title').textContent, done:true, rc:null});
}

function finish(info){
  job.done = true;
  stopStage = 0; clearTimeout(stopTimer);
  setJobUI(info);
  const w = job.waiters; job.waiters = [];
  w.forEach(fn => fn(info));
  refreshStatus();
  refreshSpoof();
  if (currentTab === 'backups') refreshBackups();
}

// Start a task. Resolves with its final info when it ends, or null if it could not start.
async function runJob(action, args){
  showConsole(true);
  if (job.id && !job.done){
    T.note('! a task is still running — answer it in the terminal, or press Stop first');
    return null;
  }
  let r, d = {};
  try {
    r = await api('/api/run', {action, args: args || {}, rows: T.rows, cols: T.cols});
    d = await r.json().catch(() => ({}));
  } catch (e){
    if (e.message !== 'auth') T.note('✗ cannot reach the panel: ' + e.message, '38;5;203');
    return null;
  }
  if (r.status === 409 && d.job){
    T.note('! another task is running: ' + d.job.title);
    if (job.id !== d.job.id) attach(d.job, false);
    return null;
  }
  if (!r.ok || !d.job){ T.note('✗ ' + (d.error || 'HTTP ' + r.status), '38;5;203'); return null; }
  T.softReset();
  if (T.x > 0) T.write('\r\n');
  if (T.y > 0) T.write('\r\n');
  attach(d.job, true);
  const done = new Promise(res => job.waiters.push(res));
  if (action === 'menu') focusTerm();
  return done;
}

/* ---- keyboard → task ---- */
const inq = {buf:'', timer:0, busy:false};
function sendInput(s){
  if (!s || !job.id || job.done) return;
  inq.buf += s;
  if (!inq.timer && !inq.busy) inq.timer = setTimeout(flushInput, 15);   // batch keystrokes
}
async function flushInput(){
  inq.timer = 0;
  if (inq.busy || !inq.buf) return;
  const data = inq.buf.slice(0, 60000);
  inq.buf = inq.buf.slice(data.length);
  inq.busy = true;
  try { await api('/api/input', {job: job.id, data}); } catch (_) {}
  inq.busy = false;
  if (inq.buf) inq.timer = setTimeout(flushInput, 15);
}
T.onReply = sendInput;

function focusTerm(){ tin.focus({preventScroll:true}); }
termEl.addEventListener('mouseup', () => {
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && String(sel).length) return;   // let people select & copy
  focusTerm();
});
tin.addEventListener('focus', () => termEl.classList.add('focused'));
tin.addEventListener('blur', () => termEl.classList.remove('focused'));
tin.addEventListener('keydown', e => {
  if (e.shiftKey && (e.key === 'PageUp' || e.key === 'PageDown')){
    termEl.scrollTop += (e.key === 'PageUp' ? -0.9 : 0.9) * termEl.clientHeight;
    e.preventDefault();
    return;
  }
  const seq = T.keySeq(e);
  if (seq === null || seq === '') return;   // browser default / the input event sends the text
  e.preventDefault();
  sendInput(seq);
  termEl.scrollTop = termEl.scrollHeight;
});
let composing = false;
function flushTextarea(){
  const v = tin.value;
  tin.value = '';
  if (v){ sendInput(v.replace(/\r?\n/g, '\r')); termEl.scrollTop = termEl.scrollHeight; }
}
tin.addEventListener('compositionstart', () => { composing = true; });
tin.addEventListener('compositionend', () => { composing = false; flushTextarea(); });
tin.addEventListener('input', () => { if (!composing) flushTextarea(); });
tin.addEventListener('paste', e => {
  const t = (e.clipboardData || window.clipboardData).getData('text');
  e.preventDefault();
  if (t) sendInput(T.pasteSeq(t));
});

const QUICK = {enter:'\r', ctrlc:'\x03', ctrld:'\x04', tab:'\t', esc:'\x1b', y:'y', n:'n'};
$$('#term-keys .key').forEach(b => {
  b.addEventListener('mousedown', e => e.preventDefault());   // keep the focus in the terminal
  b.addEventListener('click', () => {
    const k = b.dataset.key;
    const pre = T.appCursor ? '\x1bO' : '\x1b[';
    sendInput(k === 'up' ? pre + 'A' : k === 'down' ? pre + 'B' : QUICK[k]);
  });
});

// Stop: Ctrl-C (SIGINT) first, SIGTERM 2.5 s later; pressing again sends SIGKILL
$('#job-stop').onclick = () => {
  if (!job.id || job.done) return;
  const id = job.id;
  if (stopStage){
    api('/api/signal', {job:id, sig:'KILL'}).catch(() => {});
    T.note('■ SIGKILL sent', '38;5;203');
    return;
  }
  stopStage = 1;
  $('#job-stop').textContent = '■ Kill';
  api('/api/signal', {job:id, sig:'INT'}).catch(() => {});
  stopTimer = setTimeout(() => {
    if (job.id === id && !job.done) api('/api/signal', {job:id, sig:'TERM'}).catch(() => {});
  }, 2500);
};

$$('.open-menu').forEach(b => b.onclick = () => runJob('menu', {}));

// keep the server-side terminal size in step with the visible one
let fitTimer = 0;
function fitTerm(){
  if (!T.fit()) return;
  if (job.id && !job.done) api('/api/resize', {job: job.id, rows: T.rows, cols: T.cols}).catch(() => {});
}
function fitSoon(){ clearTimeout(fitTimer); fitTimer = setTimeout(fitTerm, 120); }
if ('ResizeObserver' in window) new ResizeObserver(fitSoon).observe(termEl);
window.addEventListener('resize', fitSoon);

/* ---------------- Spoof Tunnel panel (official, shown unchanged) ---------------- */
let spoof = null, serverIp = '';
async function refreshSpoof(){
  try { spoof = await (await api('/api/spoof')).json(); } catch(_){ return; }
  const ready = !!spoof.ready;
  $('#tab-spoof').hidden = !ready;
  $('#spoof-open').hidden = !ready;
  $('#spoof-install').hidden = !!spoof.installed;   // never re-run its installer from here
  const st = $('#spoof-state');
  st.className = 'spoof-state' + (ready ? (spoof.running ? ' on' : ' off') : '');
  st.textContent = !spoof.installed ? ''
    : !ready ? 'installed — its port / web path could not be read'
    : spoof.running ? '● installed · running' : '● installed · not running (systemctl start spoof-panel)';
  if (ready) $('#spoof-newtab').href = spoof.path;
  spoofDirect();
  if (!ready && currentTab === 'spoof') showTab('dashboard');
}
function spoofDirect(){
  if (spoof && spoof.ready) $('#spoof-direct').textContent = `http://${serverIp || 'SERVER_IP'}:${spoof.port}${spoof.path}`;
}
function openSpoof(){
  const f = $('#spoof-frame');
  if (spoof && spoof.ready && !f.getAttribute('src')) f.src = spoof.path;
}
$('#spoof-open').onclick = () => showTab('spoof');
$('#spoof-reload').onclick = () => {
  const f = $('#spoof-frame');
  if (!spoof || !spoof.ready) return;
  try { f.contentWindow.location.reload(); } catch(_){ f.src = spoof.path; }
};

/* ---------------- status ---------------- */
async function refreshStatus(){
  try {
    const r = await api('/api/status');
    const d = await r.json();
    serverIp = d.server || '';
    $('#server-ip').textContent = d.server || '—';
    $('#server-ver').textContent = d.version ? 'v'+d.version : '';
    renderStatus(d.panels || []);
    spoofDirect();
  } catch(_){ /* keep last render */ }
}

function renderStatus(items){
  const grid = $('#status-grid');
  grid.innerHTML = '';
  items.forEach(it => {
    const card = document.createElement('div');
    card.className = 'card stat';
    let tag, dot;
    if (!it.installed){ tag = '<span class="state-tag state-none">not installed</span>'; dot='dot-none'; }
    else if (it.running){ tag = '<span class="state-tag state-on">running</span>'; dot='dot-on'; }
    else { tag = '<span class="state-tag state-off">installed</span>'; dot='dot-off'; }

    let actions = '';
    if (it.installed && PANEL_KEYS.includes(it.key)){
      actions = `<div class="mini-actions">
        <button class="btn btn-sm" data-run='{"action":"backup","args":{"key":"${it.key}"}}'>Backup</button>
        <button class="btn btn-sm btn-danger" data-del="${it.key}">Remove</button>
      </div>`;
    } else if (!it.installed && PANEL_KEYS.includes(it.key)){
      actions = `<div class="mini-actions">
        <button class="btn btn-sm btn-primary" data-run='{"action":"install-panel","args":{"key":"${it.key}"}}'>Install</button>
      </div>`;
    } else if (it.installed && it.key === 'spoof-tunnel'){
      actions = `<div class="mini-actions">
        <button class="btn btn-sm" data-open-spoof>Open Spoof panel</button>
      </div>`;
    }
    card.innerHTML = `<h3><span class="status-row"><span class="dot ${dot}"></span>${it.name}</span>${tag}</h3>${actions}`;
    grid.appendChild(card);
  });
  bindRunButtons(grid);
  $$('[data-open-spoof]', grid).forEach(b => b.onclick = () => {
    if (spoof && spoof.ready) showTab('spoof');
    else { showConsole(true); T.note('! the Spoof panel\'s port / web path could not be read yet'); }
  });
  $$('[data-del]', grid).forEach(b => b.onclick = () => {
    const key = b.dataset.del;
    const purge = confirm(`Remove ${PRETTY[key]||key}?\n\nA safety backup is taken first.\nPress Cancel to keep its data directory, or OK to also PURGE all data.`);
    // confirm() can't do 3 states cleanly; ask purge explicitly
    const reallyPurge = purge && confirm('Also PURGE the data directory? This is irreversible.');
    runJob('delete-panel', {key, purge: reallyPurge});
  });
}

/* ---------------- backups ---------------- */
function keyFromName(name){
  for (const k of PANEL_KEYS){ if (name.startsWith(k + '-')) return k; }
  return 'marzban';
}
function human(n){
  if (n < 1024) return n+' B';
  if (n < 1048576) return (n/1024).toFixed(1)+' KB';
  if (n < 1073741824) return (n/1048576).toFixed(1)+' MB';
  return (n/1073741824).toFixed(1)+' GB';
}
async function refreshBackups(){
  try{
    const r = await api('/api/backups');
    const d = await r.json();
    const tb = $('#backup-tbl tbody'); tb.innerHTML = '';
    (d.backups || []).forEach(b => {
      const tr = document.createElement('tr');
      const when = new Date(b.mtime*1000).toLocaleString();
      tr.innerHTML = `<td>${b.name}</td><td>${human(b.size)}</td><td>${when}</td>
        <td><button class="btn btn-sm" data-restore='${JSON.stringify({key:keyFromName(b.name),archive:b.path})}'>Restore</button></td>`;
      tb.appendChild(tr);
    });
    $$('[data-restore]', tb).forEach(btn => btn.onclick = () => {
      const a = JSON.parse(btn.dataset.restore);
      if (confirm(`Restore ${PRETTY[a.key]||a.key} from this archive? Current data will be overwritten.`))
        runJob('restore', a);
    });
    if (!(d.backups||[]).length) tb.innerHTML = '<tr><td colspan="4" class="muted">no backups yet</td></tr>';
  }catch(_){}
}

/* ---------------- generic run buttons ---------------- */
function bindRunButtons(root=document){
  $$('[data-run]', root).forEach(btn => {
    if (btn._bound) return; btn._bound = true;
    btn.onclick = () => {
      let spec;
      try { spec = JSON.parse(btn.dataset.run); } catch(_){ return; }
      if (spec.action === 'backup' && spec.args.key === 'ALL'){
        // loop every panel on the client side, one task after another
        (async () => {
          for (const k of PANEL_KEYS){ if (await runJob('backup', {key:k}) === null) break; }
        })();
        return;
      }
      runJob(spec.action, spec.args || {});
    };
  });
}

/* ---------------- forms ---------------- */
function fillApplySelects(){
  $$('.apply-select').forEach(sel => {
    const noAll = sel.classList.contains('apply-noall');
    let html = '';
    if (!noAll) html += '<option value="none">Save only — don\'t apply to a panel</option>';
    html += '<option value="all">All installed panels</option>';
    PANEL_KEYS.forEach(k => html += `<option value="${k}">${PRETTY[k]}</option>`);
    sel.innerHTML = html;
  });
}
fillApplySelects();

$('#cert-form').addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target;
  runJob('cert-issue', {
    domain:f.domain.value.trim(), email:f.email.value.trim(),
    method:f.method.value, apply:f.apply.value
  });
});
$('#cert-import-form').addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target;
  runJob('cert-import', {
    domain:f.domain.value.trim(), cert:f.cert.value, key:f.key.value, apply:f.apply.value
  });
});
$('#cert-apply-form').addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target;
  if (!f.domain.value.trim()) return;
  runJob('cert-apply', {domain:f.domain.value.trim(), apply:f.apply.value});
});
$('#cert-list-btn').onclick = () => runJob('cert-list', {});

$('#migrate-form').addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target;
  const args = {
    to: f.to.value.trim(), port: f.port.value.trim() || '22',
    panels: f.panels.value, password: f.password.value,
    dry_run: f.dry_run.checked
  };
  if (!args.dry_run && !confirm('Run the REAL migration now? The destination will be modified.')) return;
  runJob('migrate', args);
});

/* ---------------- tabs ---------------- */
function showTab(name){
  currentTab = name;
  $$('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === name));
  $$('.panel').forEach(p => p.classList.toggle('active', p.dataset.panel === name));
  document.body.classList.toggle('tab-spoof', name === 'spoof');
  if (name === 'backups') refreshBackups();
  if (name === 'spoof') openSpoof();
}
$('#tabs').addEventListener('click', e => {
  const t = e.target.closest('.tab'); if (t) showTab(t.dataset.tab);
});

$('#refresh').onclick = refreshStatus;

/* ---------------- boot ---------------- */
bindRunButtons();
T.fit();
refreshStatus();
refreshSpoof();
// re-attach to a running (or the last) task, e.g. after a page reload
(async () => {
  try {
    const info = (await (await api('/api/job')).json()).job;
    if (info){
      attach(info, false);
      if (!info.done) showConsole(true);
    }
  } catch(_){}
})();
setInterval(() => { if ((!job.id || job.done) && currentTab === 'dashboard') refreshStatus(); }, 15000);
