/* Eris Panel Manager - a small terminal emulator for the web panel.
   No dependencies and no CDN (the panel is used where CDNs get filtered).
   It understands what installers and the erispm menu print: colours
   (16 / 256 / truecolor), cursor movement, erase, scroll regions, the
   alternate screen, auto-wrap and DEC line drawing. OSC/DCS are ignored. */
'use strict';
(function (global) {
  const BOLD = 1, DIM = 2, ITALIC = 4, UNDER = 8, INVERSE = 16, HIDDEN = 32, STRIKE = 64;

  const BASE16 = ['#1b2230', '#ff6b76', '#7ee0a2', '#ffd166', '#6aa8ff', '#b48bff', '#5fd7ff', '#cdd6e4',
                  '#5f6b7e', '#ff9aa2', '#a3f0bf', '#ffe08a', '#93c2ff', '#cdb0ff', '#9ae8ff', '#ffffff'];
  const PALETTE = (() => {
    const p = BASE16.slice(), lv = [0, 95, 135, 175, 215, 255];
    const hx = n => n.toString(16).padStart(2, '0');
    for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++)
      p.push('#' + hx(lv[r]) + hx(lv[g]) + hx(lv[b]));
    for (let i = 0; i < 24; i++) { const v = hx(8 + i * 10); p.push('#' + v + v + v); }
    return p;
  })();
  const DEF_FG = '#cdd6e4', DEF_BG = '#0b0f16';

  // attributes are interned, so cells can be grouped into spans by reference
  const ATTRS = new Map();
  function mkAttr(fg, bg, fl) {
    const k = fg + '|' + bg + '|' + fl;
    let a = ATTRS.get(k);
    if (!a) {
      if (ATTRS.size > 4096) ATTRS.clear();
      a = { fg, bg, fl, css: null };
      ATTRS.set(k, a);
    }
    return a;
  }
  const DEF = mkAttr(-1, -1, 0);

  function colour(c) { return c === -1 ? null : (typeof c === 'number' ? PALETTE[c] : c); }
  function cssOf(a) {
    if (a.css !== null) return a.css;
    let fg = a.fg;
    if ((a.fl & BOLD) && typeof fg === 'number' && fg >= 0 && fg < 8) fg += 8;  // bold = bright
    let f = colour(fg), b = colour(a.bg), s = '';
    if (a.fl & INVERSE) { const t = f || DEF_FG; f = b || DEF_BG; b = t; }
    if (a.fl & HIDDEN) f = 'transparent';
    if (f) s += 'color:' + f + ';';
    if (b) s += 'background:' + b + ';';
    if (a.fl & BOLD) s += 'font-weight:700;';
    if (a.fl & DIM) s += 'opacity:.62;';
    if (a.fl & ITALIC) s += 'font-style:italic;';
    if (a.fl & (UNDER | STRIKE))
      s += 'text-decoration:' + ((a.fl & UNDER) ? 'underline ' : '') + ((a.fl & STRIKE) ? 'line-through' : '') + ';';
    a.css = s;
    return s;
  }
  function hexRgb(v) {
    return '#' + v.map(x => Math.max(0, Math.min(255, x | 0)).toString(16).padStart(2, '0')).join('');
  }

  // DEC special graphics (ESC ( 0): line drawing used by dialog / whiptail
  const DEC = { '`': '◆', a: '▒', f: '°', g: '±', j: '┘', k: '┐', l: '┌', m: '└', n: '┼', o: '⎺', p: '⎻',
                q: '─', r: '⎼', s: '⎽', t: '├', u: '┤', v: '┴', w: '┬', x: '│', y: '≤', z: '≥', '{': 'π',
                '|': '≠', '}': '£', '~': '·' };

  function isWide(c) {
    return (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) ||
      (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) ||
      (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1f64f) || (c >= 0x1f900 && c <= 0x1f9ff) || (c >= 0x20000 && c <= 0x3fffd);
  }
  function isZeroWidth(c) {
    return (c >= 0x300 && c <= 0x36f) || (c >= 0x610 && c <= 0x61a) || (c >= 0x64b && c <= 0x65f) ||
      c === 0x670 || (c >= 0x200b && c <= 0x200f) || (c >= 0x20d0 && c <= 0x20ff) || c === 0xfe0e || c === 0xfe0f;
  }

  function blankRow(cols, a) { return { c: new Array(cols).fill(' '), a: new Array(cols).fill(a || DEF) }; }
  function escHtml(s) { return s.replace(/[&<>]/g, ch => (ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : '&gt;')); }

  // parser states
  const GROUND = 0, ESC = 1, CSI = 2, OSC = 3, OSC_ESC = 4, STR = 5, STR_ESC = 6, CHARSET = 7, SKIP = 8;

  class Term {
    constructor(host) {
      this.host = host;
      host.innerHTML = '<div class="term-sb"></div><div class="term-screen"></div>';
      this.sbEl = host.firstChild;
      this.scrEl = host.lastChild;
      this.rows = 24; this.cols = 80;
      this.maxSb = 5000; this.sbCount = 0;
      this.sbPending = []; this.sbClear = false;
      this.onReply = null;   // fn(str): answers to cursor-position / device queries
      this.mute = false;     // true while replaying old output: never answer stale queries
      this.active = false;   // a task is running: draw the cursor
      this.rowEls = []; this.dirty = new Set(); this.lastCy = -1; this.raf = 0;
      this.reset(false);
    }

    /* ---------- state ---------- */
    reset(clearScrollback) {
      this.screen = this.blankScreen();
      this.alt = null;
      this.x = 0; this.y = 0; this.wrapPending = false;
      this.cur = DEF; this.saved = null;
      this.top = 0; this.bot = this.rows - 1;
      this.cursorOn = true; this.appCursor = false; this.autowrap = true; this.bracketed = false;
      this.g = ['B', 'B']; this.gl = 0; this.gset = 0;
      this.state = GROUND; this.buf = '';
      if (clearScrollback) { this.sbPending = []; this.sbClear = true; }
      this.dirtyAll = true;
      this.schedule();
    }
    // between tasks: leave full-screen modes but keep what is on screen
    softReset() {
      if (this.alt) this.altScreen(false, false);
      this.cur = DEF; this.top = 0; this.bot = this.rows - 1;
      this.cursorOn = true; this.appCursor = false; this.autowrap = true; this.bracketed = false;
      this.g = ['B', 'B']; this.gl = 0; this.state = GROUND; this.buf = '';
      this.schedule();
    }
    // the "clear" button: wipe scrollback and screen, keep the cursor's line
    clear() {
      const row = this.screen[this.y];
      this.screen = this.blankScreen();
      this.screen[0] = row; this.y = 0;
      this.sbPending = []; this.sbClear = true;
      this.dirtyAll = true;
      this.schedule();
    }
    blankScreen() { const s = []; for (let i = 0; i < this.rows; i++) s.push(blankRow(this.cols)); return s; }
    setActive(on) { this.active = !!on; this.schedule(); }
    // a local message that is not part of the task's output
    note(text, sgr) {
      const keep = { state: this.state, buf: this.buf, cur: this.cur, g: this.g.slice(), gl: this.gl };
      this.state = GROUND; this.g = ['B', 'B']; this.gl = 0;
      this.write((this.x > 0 || this.wrapPending ? '\r\n' : '') + '\x1b[' + (sgr || '38;5;221') + 'm' + text + '\x1b[0m\r\n');
      Object.assign(this, keep);
    }

    /* ---------- input bytes ---------- */
    write(s) {
      for (const ch of s) this.feed(ch);
      this.schedule();
    }
    feed(ch) {
      const c = ch.codePointAt(0);
      switch (this.state) {
        case GROUND:
          if (c < 0x20 || c === 0x7f) return this.ctrl(c);
          if (c >= 0x80 && c < 0xa0) return;
          return this.print(ch, c);
        case ESC:
          return this.esc(ch);
        case CSI:
          if (c >= 0x40 && c <= 0x7e) { const p = this.buf; this.buf = ''; this.state = GROUND; return this.csi(p, ch); }
          if (c === 0x1b) { this.state = ESC; this.buf = ''; return; }
          if (c === 0x18 || c === 0x1a) { this.state = GROUND; this.buf = ''; return; }
          if (c < 0x20) return this.ctrl(c);
          if (this.buf.length < 96) this.buf += ch;
          return;
        case OSC:
          if (c === 7 || c === 0x9c) this.state = GROUND;
          else if (c === 0x1b) this.state = OSC_ESC;
          return;
        case OSC_ESC:
          if (ch === '\\') { this.state = GROUND; return; }
          this.state = ESC;
          return this.esc(ch);
        case STR:
          if (c === 0x1b) this.state = STR_ESC; else if (c === 0x9c) this.state = GROUND;
          return;
        case STR_ESC:
          this.state = ch === '\\' ? GROUND : STR;
          return;
        case CHARSET:
          this.state = GROUND;
          if (this.gset < 2) this.g[this.gset] = ch;
          return;
        case SKIP:
          this.state = GROUND;
          return;
      }
    }
    ctrl(c) {
      switch (c) {
        case 8: if (this.x > 0) this.x--; this.wrapPending = false; return;
        case 9: this.x = Math.min(this.cols - 1, (Math.floor(this.x / 8) + 1) * 8); this.wrapPending = false; return;
        case 10: case 11: case 12: return this.lf();
        case 13: this.x = 0; this.wrapPending = false; return;
        case 14: this.gl = 1; return;
        case 15: this.gl = 0; return;
        case 0x1b: this.state = ESC; this.buf = ''; return;
      }
    }
    print(ch, c) {
      if (isZeroWidth(c)) {   // combining mark: join the previous cell
        let px = this.wrapPending ? this.x : this.x - 1;
        if (px > 0 && this.screen[this.y].c[px] === '') px--;
        if (px >= 0) { this.screen[this.y].c[px] += ch; this.dirty.add(this.y); }
        return;
      }
      if (this.g[this.gl] === '0' && c >= 0x60 && c <= 0x7e) ch = DEC[ch] || ch;
      const w = isWide(c) ? 2 : 1;
      if (this.wrapPending && this.autowrap) { this.x = 0; this.lf(); }
      this.wrapPending = false;
      if (w === 2 && this.x >= this.cols - 1) {
        if (!this.autowrap) return;
        this.screen[this.y].c[this.x] = ' ';
        this.x = 0; this.lf();
      }
      const row = this.screen[this.y];
      if (row.c[this.x] === '' && this.x > 0) row.c[this.x - 1] = ' ';   // overwrote half a wide char
      row.c[this.x] = ch; row.a[this.x] = this.cur;
      if (w === 2) { row.c[this.x + 1] = ''; row.a[this.x + 1] = this.cur; }
      else if (this.x + 1 < this.cols && row.c[this.x + 1] === '') row.c[this.x + 1] = ' ';
      this.dirty.add(this.y);
      const nx = this.x + w;
      if (nx >= this.cols) { this.x = this.cols - 1; this.wrapPending = true; } else this.x = nx;
    }
    lf() {
      this.wrapPending = false;
      if (this.y === this.bot) this.scrollUp(1);
      else if (this.y < this.rows - 1) this.y++;
    }
    ri() {
      this.wrapPending = false;
      if (this.y === this.top) this.scrollDown(1);
      else if (this.y > 0) this.y--;
    }
    mv(x, y) {
      this.x = Math.max(0, Math.min(this.cols - 1, x));
      this.y = Math.max(0, Math.min(this.rows - 1, y));
      this.wrapPending = false;
    }
    saveCursor() { this.saved = { x: this.x, y: this.y, cur: this.cur, g: this.g.slice(), gl: this.gl }; }
    restoreCursor() {
      const s = this.saved;
      if (!s) { this.mv(0, 0); this.cur = DEF; return; }
      this.mv(s.x, s.y);
      this.cur = s.cur; this.g = s.g.slice(); this.gl = s.gl;
    }
    reply(s) { if (!this.mute && this.onReply) this.onReply(s); }
    eraseAttr() { return this.cur.bg === -1 ? DEF : mkAttr(-1, this.cur.bg, 0); }

    esc(ch) {
      this.state = GROUND;
      switch (ch) {
        case '[': this.state = CSI; this.buf = ''; return;
        case ']': this.state = OSC; return;
        case 'P': case '_': case '^': case 'X': this.state = STR; return;
        case '(': this.state = CHARSET; this.gset = 0; return;
        case ')': this.state = CHARSET; this.gset = 1; return;
        case '*': case '+': case '-': case '.': case '/': this.state = CHARSET; this.gset = 2; return;
        case '#': case '%': case ' ': this.state = SKIP; return;
        case '7': return this.saveCursor();
        case '8': return this.restoreCursor();
        case 'D': return this.lf();
        case 'E': this.x = 0; return this.lf();
        case 'M': return this.ri();
        case 'c': return this.reset(false);
      }
    }

    csi(p, fin) {
      let priv = '';
      if (p && '?>=<'.indexOf(p[0]) >= 0) { priv = p[0]; p = p.slice(1); }
      const im = /[ -/]+$/.exec(p);
      const inter = im ? im[0] : '';
      if (im) p = p.slice(0, im.index);
      const raw = p ? p.split(';') : [];
      const n = raw.map(v => parseInt(v, 10) || 0);
      const a = i => n[i] || 1;
      if (inter) { if (inter === '!' && fin === 'p') this.softReset(); return; }
      if (priv === '?') { if (fin === 'h' || fin === 'l') this.setModes(n, fin === 'h'); return; }
      if (priv) { if (priv === '>' && fin === 'c') this.reply('\x1b[>0;10;1c'); return; }
      switch (fin) {
        case 'm': return this.sgr(raw);
        case 'A': return this.mv(this.x, Math.max(this.y >= this.top ? this.top : 0, this.y - a(0)));
        case 'B': case 'e': return this.mv(this.x, Math.min(this.y <= this.bot ? this.bot : this.rows - 1, this.y + a(0)));
        case 'C': case 'a': return this.mv(this.x + a(0), this.y);
        case 'D': return this.mv(this.x - a(0), this.y);
        case 'E': return this.mv(0, Math.min(this.y <= this.bot ? this.bot : this.rows - 1, this.y + a(0)));
        case 'F': return this.mv(0, Math.max(this.y >= this.top ? this.top : 0, this.y - a(0)));
        case 'G': case '`': return this.mv(a(0) - 1, this.y);
        case 'd': return this.mv(this.x, a(0) - 1);
        case 'H': case 'f': return this.mv(a(1) - 1, a(0) - 1);
        case 'J': return this.ed(n[0] || 0);
        case 'K': return this.el(n[0] || 0);
        case 'L': return this.insLines(a(0));
        case 'M': return this.delLines(a(0));
        case '@': return this.insChars(a(0));
        case 'P': return this.delChars(a(0));
        case 'X': return this.eraseChars(a(0));
        case 'S': return this.scrollUp(a(0));
        case 'T': if (n.length <= 1) this.scrollDown(a(0)); return;
        case 'r': {
          const t = a(0) - 1, b = (n[1] || this.rows) - 1;
          if (t < b && b < this.rows) { this.top = t; this.bot = b; }
          return this.mv(0, 0);
        }
        case 's': return this.saveCursor();
        case 'u': return this.restoreCursor();
        case 'n':
          if (n[0] === 6) this.reply('\x1b[' + (this.y + 1) + ';' + (this.x + 1) + 'R');
          else if (n[0] === 5) this.reply('\x1b[0n');
          return;
        case 'c': if (!n[0]) this.reply('\x1b[?1;2c'); return;
      }
    }
    setModes(list, on) {
      for (const m of list) {
        if (m === 1) this.appCursor = on;
        else if (m === 7) this.autowrap = on;
        else if (m === 25) this.cursorOn = on;
        else if (m === 47 || m === 1047) this.altScreen(on, false);
        else if (m === 1049) this.altScreen(on, true);
        else if (m === 2004) this.bracketed = on;
      }
    }
    // the alternate screen: a fresh blank screen, the normal one comes back after
    altScreen(on, withCursor) {
      if (on && !this.alt) {
        if (withCursor) this.saveCursor();
        this.alt = { screen: this.screen };
        this.screen = this.blankScreen();
      } else if (!on && this.alt) {
        this.screen = this.alt.screen;
        this.alt = null;
        if (withCursor) this.restoreCursor();
      } else return;
      this.top = 0; this.bot = this.rows - 1;
      this.dirtyAll = true;
    }

    sgr(raw) {
      let fg = this.cur.fg, bg = this.cur.bg, fl = this.cur.fl;
      if (!raw.length) raw = ['0'];
      for (let i = 0; i < raw.length; i++) {
        const part = raw[i];
        if (part.indexOf(':') >= 0) {   // ITU form: 38:2::r:g:b, 38:5:n, 4:3 ...
          const s = part.split(':').map(v => parseInt(v, 10) || 0);
          if (s[0] === 38 || s[0] === 48) {
            let col = null;
            if (s[1] === 5) col = s[2] & 255;
            else if (s[1] === 2) col = hexRgb(s.length >= 6 ? s.slice(3, 6) : s.slice(2, 5));
            if (col !== null) { if (s[0] === 38) fg = col; else bg = col; }
          } else if (s[0] === 4) { if (s[1]) fl |= UNDER; else fl &= ~UNDER; }
          continue;
        }
        const c = parseInt(part, 10) || 0;
        if (c === 0) { fg = -1; bg = -1; fl = 0; }
        else if (c === 1) fl |= BOLD;
        else if (c === 2) fl |= DIM;
        else if (c === 3) fl |= ITALIC;
        else if (c === 4 || c === 21) fl |= UNDER;
        else if (c === 7) fl |= INVERSE;
        else if (c === 8) fl |= HIDDEN;
        else if (c === 9) fl |= STRIKE;
        else if (c === 22) fl &= ~(BOLD | DIM);
        else if (c === 23) fl &= ~ITALIC;
        else if (c === 24) fl &= ~UNDER;
        else if (c === 27) fl &= ~INVERSE;
        else if (c === 28) fl &= ~HIDDEN;
        else if (c === 29) fl &= ~STRIKE;
        else if (c >= 30 && c <= 37) fg = c - 30;
        else if (c === 39) fg = -1;
        else if (c >= 40 && c <= 47) bg = c - 40;
        else if (c === 49) bg = -1;
        else if (c >= 90 && c <= 97) fg = c - 90 + 8;
        else if (c >= 100 && c <= 107) bg = c - 100 + 8;
        else if (c === 38 || c === 48) {
          const mode = parseInt(raw[i + 1], 10);
          let col = null;
          if (mode === 5) { col = (parseInt(raw[i + 2], 10) || 0) & 255; i += 2; }
          else if (mode === 2) { col = hexRgb([raw[i + 2], raw[i + 3], raw[i + 4]].map(v => parseInt(v, 10) || 0)); i += 4; }
          if (col !== null) { if (c === 38) fg = col; else bg = col; }
        }
      }
      this.cur = mkAttr(fg, bg, fl);
    }

    /* ---------- erase / scroll / edit ---------- */
    ed(m) {
      const ea = this.eraseAttr();
      if (m === 0) { this.el(0); for (let y = this.y + 1; y < this.rows; y++) this.screen[y] = blankRow(this.cols, ea); }
      else if (m === 1) { this.el(1); for (let y = 0; y < this.y; y++) this.screen[y] = blankRow(this.cols, ea); }
      else if (m === 2) { for (let y = 0; y < this.rows; y++) this.screen[y] = blankRow(this.cols, ea); }
      else if (m === 3) { this.sbPending = []; this.sbClear = true; }
      this.dirtyAll = true;
    }
    el(m) {
      const r = this.screen[this.y], ea = this.eraseAttr();
      let from = 0, to = this.cols;
      if (m === 0) from = this.x; else if (m === 1) to = this.x + 1;
      for (let i = from; i < to; i++) { r.c[i] = ' '; r.a[i] = ea; }
      this.dirty.add(this.y);
    }
    eraseChars(n) {
      const r = this.screen[this.y], ea = this.eraseAttr();
      for (let i = this.x, e = Math.min(this.cols, this.x + n); i < e; i++) { r.c[i] = ' '; r.a[i] = ea; }
      this.dirty.add(this.y);
    }
    insChars(n) {
      const r = this.screen[this.y], ea = this.eraseAttr();
      n = Math.min(n, this.cols - this.x);
      for (let i = 0; i < n; i++) { r.c.splice(this.x, 0, ' '); r.a.splice(this.x, 0, ea); }
      r.c.length = this.cols; r.a.length = this.cols;
      this.dirty.add(this.y);
    }
    delChars(n) {
      const r = this.screen[this.y], ea = this.eraseAttr();
      n = Math.min(n, this.cols - this.x);
      r.c.splice(this.x, n); r.a.splice(this.x, n);
      for (let i = 0; i < n; i++) { r.c.push(' '); r.a.push(ea); }
      this.dirty.add(this.y);
    }
    insLines(n) {
      if (this.y < this.top || this.y > this.bot) return;
      n = Math.min(n, this.bot - this.y + 1);
      for (let i = 0; i < n; i++) { this.screen.splice(this.bot, 1); this.screen.splice(this.y, 0, blankRow(this.cols, this.eraseAttr())); }
      this.x = 0; this.wrapPending = false; this.dirtyAll = true;
    }
    delLines(n) {
      if (this.y < this.top || this.y > this.bot) return;
      n = Math.min(n, this.bot - this.y + 1);
      for (let i = 0; i < n; i++) { this.screen.splice(this.y, 1); this.screen.splice(this.bot, 0, blankRow(this.cols, this.eraseAttr())); }
      this.x = 0; this.wrapPending = false; this.dirtyAll = true;
    }
    scrollUp(n) {
      n = Math.min(n, this.bot - this.top + 1);
      for (let i = 0; i < n; i++) {
        const row = this.screen.splice(this.top, 1)[0];
        if (this.top === 0 && !this.alt) this.pushSb(row);
        this.screen.splice(this.bot, 0, blankRow(this.cols, this.eraseAttr()));
      }
      this.dirtyAll = true;
    }
    scrollDown(n) {
      n = Math.min(n, this.bot - this.top + 1);
      for (let i = 0; i < n; i++) {
        this.screen.splice(this.bot, 1);
        this.screen.splice(this.top, 0, blankRow(this.cols, this.eraseAttr()));
      }
      this.dirtyAll = true;
    }
    pushSb(row) {
      this.sbPending.push(row);
      if (this.sbPending.length > this.maxSb * 2) this.sbPending.splice(0, this.sbPending.length - this.maxSb);
    }

    /* ---------- size ---------- */
    // -> {rows, cols} that fit the visible box, or null while it is not laid out
    measure() {
      const p = document.createElement('span');
      p.className = 'term-probe';
      p.textContent = 'MMMMMMMMMMMMMMMMMMMM';
      this.host.appendChild(p);
      const r = p.getBoundingClientRect();
      p.remove();
      const cw = r.width / 20 || 8, lh = r.height || 18;
      const cs = getComputedStyle(this.host);
      const w = this.host.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const h = this.host.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      if (w < cw * 10 || h < lh * 2) return null;   // hidden / not laid out yet: keep the old size
      return { rows: Math.max(4, Math.floor(h / lh)), cols: Math.max(20, Math.floor(w / cw)) };
    }
    fit() { const s = this.measure(); return s ? this.resize(s.rows, s.cols) : false; }
    resize(rows, cols) {
      rows = Math.max(2, rows | 0); cols = Math.max(10, cols | 0);
      if (rows === this.rows && cols === this.cols) return false;
      const fixCols = scr => {
        for (const r of scr) {
          if (r.c.length > cols) { r.c.length = cols; r.a.length = cols; }
          while (r.c.length < cols) { r.c.push(' '); r.a.push(DEF); }
        }
      };
      // fewer rows: move lines into scrollback only as far as needed to keep the cursor
      const fitRows = (scr, cy, toSb) => {
        while (scr.length > rows) {
          if (cy >= rows) { const r = scr.shift(); if (toSb) this.pushSb(r); cy--; }
          else scr.pop();
        }
        while (scr.length < rows) scr.push(blankRow(cols));
        return cy;
      };
      fixCols(this.screen);
      this.y = fitRows(this.screen, this.y, !this.alt);
      if (this.alt) {
        fixCols(this.alt.screen);
        const sy = fitRows(this.alt.screen, this.saved ? this.saved.y : 0, true);
        if (this.saved) this.saved.y = sy;
      }
      this.rows = rows; this.cols = cols;
      this.x = Math.min(this.x, cols - 1); this.y = Math.min(this.y, rows - 1);
      if (this.saved) { this.saved.x = Math.min(this.saved.x, cols - 1); this.saved.y = Math.min(this.saved.y, rows - 1); }
      this.top = 0; this.bot = rows - 1; this.wrapPending = false;
      this.dirtyAll = true;
      this.schedule();
      return true;
    }

    /* ---------- keyboard ---------- */
    // -> string to send, '' = let the input event deliver the text, null = browser default
    keySeq(e) {
      const k = e.key, ctrl = e.ctrlKey, alt = e.altKey, shift = e.shiftKey;
      if (e.metaKey || e.isComposing) return null;
      const mod = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
      const cur = fin => (mod > 1 ? '\x1b[1;' + mod + fin : (this.appCursor ? '\x1bO' : '\x1b[') + fin);
      const tilde = num => '\x1b[' + num + (mod > 1 ? ';' + mod : '') + '~';
      switch (k) {
        case 'Enter': return alt ? '\x1b\r' : '\r';
        case 'Backspace': return ctrl ? '\x08' : (alt ? '\x1b\x7f' : '\x7f');
        case 'Tab': return shift ? '\x1b[Z' : '\t';
        case 'Escape': return '\x1b';
        case 'ArrowUp': return cur('A');
        case 'ArrowDown': return cur('B');
        case 'ArrowRight': return cur('C');
        case 'ArrowLeft': return cur('D');
        case 'Home': return cur('H');
        case 'End': return cur('F');
        case 'Insert': return tilde(2);
        case 'Delete': return tilde(3);
        case 'PageUp': return tilde(5);
        case 'PageDown': return tilde(6);
        case 'F1': return '\x1bOP';
        case 'F2': return '\x1bOQ';
        case 'F3': return '\x1bOR';
        case 'F4': return '\x1bOS';
        case 'F6': return tilde(17);
        case 'F7': return tilde(18);
        case 'F8': return tilde(19);
        case 'F9': return tilde(20);
        case 'F10': return tilde(21);
      }
      if (k.length !== 1) return null;
      if (ctrl && alt) return '';          // AltGr on many layouts: a normal character
      if (ctrl) {
        if (k === 'v' || k === 'V') return null;   // paste
        if (shift && (k === 'c' || k === 'C')) return null;   // copy
        const c = k.toUpperCase().charCodeAt(0);
        if (c >= 64 && c <= 95) return String.fromCharCode(c - 64);   // ^@ ^A..^Z ^[ ^\ ^] ^^ ^_
        if (k === ' ' || k === '2') return '\x00';
        if (k === '/' || k === '-' || k === '7') return '\x1f';
        if (k === '?' || k === '8') return '\x7f';
        if (k === '3') return '\x1b';
        if (k === '4') return '\x1c';
        if (k === '5') return '\x1d';
        if (k === '6') return '\x1e';
        return null;
      }
      if (alt) return '\x1b' + k;
      return '';
    }
    pasteSeq(text) {
      let t = String(text).replace(/\r\n?/g, '\n').replace(/\n/g, '\r');
      if (this.bracketed) t = '\x1b[200~' + t.replace(/\x1b/g, '') + '\x1b[201~';
      return t;
    }

    /* ---------- drawing ---------- */
    schedule() {
      if (this.raf) return;
      this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); });
    }
    render() {
      const h = this.host;
      const stick = h.scrollHeight - h.scrollTop - h.clientHeight < 8;
      if (this.sbClear) { this.sbEl.textContent = ''; this.sbCount = 0; this.sbClear = false; }
      if (this.sbPending.length) {
        let rows = this.sbPending;
        this.sbPending = [];
        if (rows.length >= this.maxSb) { rows = rows.slice(-this.maxSb); this.sbEl.textContent = ''; this.sbCount = 0; }
        let html = '';
        for (const r of rows) html += '<div class="trow">' + this.rowHtml(r, -1) + '</div>';
        this.sbEl.insertAdjacentHTML('beforeend', html);
        this.sbCount += rows.length;
        for (let extra = this.sbCount - this.maxSb; extra > 0; extra--) { this.sbEl.firstChild.remove(); this.sbCount--; }
      }
      if (this.rowEls.length !== this.rows) {
        this.scrEl.textContent = '';
        this.rowEls = [];
        for (let i = 0; i < this.rows; i++) {
          const d = document.createElement('div');
          d.className = 'trow';
          this.scrEl.appendChild(d);
          this.rowEls.push(d);
        }
        this.dirtyAll = true;
      }
      const cy = this.cursorOn && this.active ? this.y : -1;
      for (let y = 0; y < this.rows; y++) {
        if (this.dirtyAll || this.dirty.has(y) || y === cy || y === this.lastCy)
          this.rowEls[y].innerHTML = this.rowHtml(this.screen[y], y === cy ? this.x : -1);
      }
      this.dirtyAll = false; this.dirty.clear(); this.lastCy = cy;
      if (stick) h.scrollTop = h.scrollHeight;
    }
    rowHtml(row, cx) {
      const c = row.c, a = row.a;
      let end = c.length;
      while (end > 0 && end - 1 > cx && c[end - 1] === ' ' && a[end - 1] === DEF) end--;  // clean copy/paste
      let html = '';
      for (let i = 0; i < end;) {
        if (i === cx) {
          const st = cssOf(a[i]);
          html += '<span class="tcur"' + (st ? ' style="' + st + '"' : '') + '>' + (c[i] ? escHtml(c[i]) : ' ') + '</span>';
          i++;
          continue;
        }
        const at = a[i];
        let j = i, t = '';
        while (j < end && a[j] === at && j !== cx) { t += c[j]; j++; }
        const st = cssOf(at);
        html += st ? '<span style="' + st + '">' + escHtml(t) + '</span>' : escHtml(t);
        i = j;
      }
      return html;
    }
  }

  global.ErisTerm = Term;
})(window);
