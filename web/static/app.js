/* Eris Panel Manager - web panel client */
'use strict';
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];

const PANEL_KEYS = ['pasarguard','marzban','marzneshin','3x-ui'];
const PRETTY = {
  'pasarguard':'PasarGuard','marzban':'Marzban','marzneshin':'Marzneshin','3x-ui':'3x-ui (Sanaei)',
  'pasarguard-node':'PasarGuard node','marzban-node':'Marzban node','marzneshin-node':'Marzneshin node',
  'spoof-tunnel':'Spoof Tunnel','eris-tunnel-2':'Eris Tunnel 2'
};

/* ---------------- console ---------------- */
const con = {
  box: $('#console'),
  body: $('#console-body'),
  dot: $('#run-dot'),
  busy: false,
  line(text){
    const span = document.createElement('span');
    const t = text;
    if (/^\s*✓/.test(t)) span.className = 'c-ok';
    else if (/^\s*✗/.test(t)) span.className = 'c-bad';
    else if (/^\s*·/.test(t)) span.className = 'c-info';
    else if (/^\s*!/.test(t)) span.className = 'c-warn';
    else if (/^\s*▸/.test(t)) span.className = 'c-step';
    else if (/^\s*\$/.test(t)) span.className = 'c-cmd';
    span.textContent = t;
    this.body.appendChild(span);
    this.body.scrollTop = this.body.scrollHeight;
  },
  write(chunk){ chunk.split(/(?<=\n)/).forEach(l => { if (l) this.line(l); }); },
  clear(){ this.body.textContent = ''; },
  setBusy(b){
    this.busy = b;
    this.dot.className = 'dot ' + (b ? 'dot-busy' : 'dot-idle');
    if (b && this.box.classList.contains('collapsed')) this.box.classList.remove('collapsed');
  }
};
$('#console-clear').onclick = () => con.clear();
$('#console-toggle').onclick = (e) => {
  con.box.classList.toggle('collapsed');
  e.target.textContent = con.box.classList.contains('collapsed') ? 'show' : 'hide';
};

/* ---------------- run & stream ---------------- */
let running = false;
async function runStream(action, args){
  if (running){ con.line('\n! a task is already running — wait for it to finish\n'); return; }
  running = true; con.setBusy(true);
  con.line(`\n──────── ${action} ────────\n`);
  try {
    const r = await fetch('/api/run', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({action, args})
    });
    if (r.status === 401){ location.href = '/login'; return; }
    if (!r.body){ con.line(await r.text()); return; }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    for(;;){
      const {value, done} = await reader.read();
      if (done) break;
      con.write(dec.decode(value, {stream:true}));
    }
  } catch(err){
    con.line(`\n[error] ${err}\n`);
  } finally {
    running = false; con.setBusy(false);
    refreshStatus(); if (currentTab === 'backups') refreshBackups();
  }
}

/* ---------------- status ---------------- */
async function refreshStatus(){
  try {
    const r = await fetch('/api/status');
    if (r.status === 401){ location.href='/login'; return; }
    const d = await r.json();
    $('#server-ip').textContent = d.server || '—';
    $('#server-ver').textContent = d.version ? 'v'+d.version : '';
    renderStatus(d.panels || []);
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
    }
    card.innerHTML = `<h3><span class="status-row"><span class="dot ${dot}"></span>${it.name}</span>${tag}</h3>${actions}`;
    grid.appendChild(card);
  });
  bindRunButtons(grid);
  $$('[data-del]', grid).forEach(b => b.onclick = () => {
    const key = b.dataset.del;
    const purge = confirm(`Remove ${PRETTY[key]||key}?\n\nA safety backup is taken first.\nPress Cancel to keep its data directory, or OK to also PURGE all data.`);
    // confirm() can't do 3 states cleanly; ask purge explicitly
    const reallyPurge = purge && confirm('Also PURGE the data directory? This is irreversible.');
    runStream('delete-panel', {key, purge: reallyPurge});
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
    const r = await fetch('/api/backups');
    if (r.status === 401){ location.href='/login'; return; }
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
        runStream('restore', a);
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
        // loop every installed panel on the client side
        (async () => { for (const k of PANEL_KEYS) await runStream('backup', {key:k}); })();
        return;
      }
      runStream(spec.action, spec.args || {});
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
  runStream('cert-issue', {
    domain:f.domain.value.trim(), email:f.email.value.trim(),
    method:f.method.value, apply:f.apply.value
  });
});
$('#cert-import-form').addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target;
  runStream('cert-import', {
    domain:f.domain.value.trim(), cert:f.cert.value, key:f.key.value, apply:f.apply.value
  });
});
$('#cert-apply-form').addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target;
  if (!f.domain.value.trim()) return;
  runStream('cert-apply', {domain:f.domain.value.trim(), apply:f.apply.value});
});
$('#cert-list-btn').onclick = () => runStream('cert-list', {});

$('#migrate-form').addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target;
  const args = {
    to: f.to.value.trim(), port: f.port.value.trim() || '22',
    panels: f.panels.value, password: f.password.value,
    dry_run: f.dry_run.checked
  };
  if (!args.dry_run && !confirm('Run the REAL migration now? The destination will be modified.')) return;
  runStream('migrate', args);
});

/* ---------------- tabs ---------------- */
let currentTab = 'dashboard';
$('#tabs').addEventListener('click', e => {
  const t = e.target.closest('.tab'); if (!t) return;
  currentTab = t.dataset.tab;
  $$('.tab').forEach(x => x.classList.toggle('active', x === t));
  $$('.panel').forEach(p => p.classList.toggle('active', p.dataset.panel === currentTab));
  if (currentTab === 'backups') refreshBackups();
});

$('#refresh').onclick = refreshStatus;

/* ---------------- boot ---------------- */
bindRunButtons();
refreshStatus();
setInterval(() => { if (!running && currentTab === 'dashboard') refreshStatus(); }, 15000);
