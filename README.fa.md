<div align="center">

# ⚡ اریس پنل منیجر

**با یک دستور، همه‌ی پنل‌های پراکسی‌ت رو نصب، امن، بکاپ، مهاجرت و تانل کن.**

PasarGuard · Marzban · Marzneshin · 3x‑ui (سنایی) — به‌همراه نودهاشون، سرتیفیکیت SSL،
بکاپ و بازیابی دیتابیس، مهاجرت سرور‌به‌سرور، و تانل‌های Spoof Tunnel و Eris Tunnel 2 —
همه از یک منوی ترمینالی رنگی **یا** یک پنل وب خوش‌دست.

[🇬🇧 English](README.md)

![version](https://img.shields.io/badge/version-1.0.0-5fd7ff?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-7ee0a2?style=flat-square)

<img src="docs/web-install.jpg" alt="Eris Panel Manager" width="85%">

</div>

---

## چرا؟

مدیریت زیرساخت پراکسی یعنی سر‌و‌کله‌زدن با چند پنل، نودهاشون، سرتیفیکیت‌های لتس‌اینکریپت،
بکاپ شبانه‌ی دیتابیس، و گاهی مهاجرت پراسترس به سرور جدید — که هرکدوم دستور و دردسر خودش رو داره.

**اریس پنل منیجر** همه‌ی این‌ها رو پشت یک دستور `erispm` جمع می‌کنه. منوی ترمینالی و پنل وب
دقیقاً از یک بک‌اند مشترک استفاده می‌کنن؛ پس هرکاری توی یکی بشه، توی اون‌یکی هم هست.

> هیچ پنلی رو از نو پیاده‌سازی نمی‌کنه. **نصاب‌های رسمی بالادست** رو صدا می‌زنه تا همیشه نرم‌افزار
> واقعی و به‌روز نصب بشه — و دور‌و‌برش ارکستراسیون، سرتیفیکیت، بکاپ، مهاجرت و تانل اضافه می‌کنه.

---

## امکانات

| بخش | چی به‌دست میاری |
|---|---|
| **نصب پنل** | PasarGuard · Marzban · Marzneshin · 3x‑ui (سنایی) |
| **نصب نود** | نود PasarGuard · نود Marzban · نود Marzneshin |
| **سرتیفیکیت** | لتس‌اینکریپت/ZeroSSL با `acme.sh` — standalone، nginx یا webroot؛ تمدید خودکار |
| **بکاپ** | تکی یا همگانی؛ چک‌پوینت SQLite + دامپ MySQL/MariaDB؛ با چک‌سام SHA‑256 |
| **بازیابی** | ریستور تأییدشده، آگاه به سرویس (stop/start)، ایمپورت مجدد SQL |
| **حذف** | آن‌اینستال رسمی + پاک‌سازی اختیاری دیتا — همیشه اول یک بکاپ ایمنی می‌گیره |
| **مهاجرت** | مبدأ → سرور جدید، **تکی یا همگانی**، با dry‑run اول |
| **تانل** | Spoof Tunnel (+ تستر اسپوف داخلی + وب GUI) · Eris Tunnel 2 |
| **پنل وب** | لاگین با پسورد، کنسول زنده، داشبورد وضعیت — فقط Python 3 بدون pip |
| **منوی ترمینالی** | منوی تمام‌صفحه‌ی رنگی، با هر اسم فایلی کار می‌کنه |

---

## نصب سریع

```bash
curl -fsSL https://raw.githubusercontent.com/eris4444/eris-panel-manager/main/install.sh | bash
```

بعدش فقط اجرا کن:

```bash
erispm
```

روی Debian/Ubuntu، RHEL/Alma/Rocky، Alpine و Arch کار می‌کنه. نیاز به `root` داره.

---

## پنل وب

یک داشبورد بدون‌وابستگی (فقط کتابخانه‌ی استاندارد Python 3 — هیچ‌چی از `pip`) که همون بک‌اند
`erispm` رو اجرا می‌کنه و خروجی زنده‌ی هر عملیات رو مستقیم به مرورگرت استریم می‌کنه.

```bash
erispm web install      # انتخاب پورت، تنظیم پسورد، HTTPS سلف‌ساین اختیاری
erispm web start|stop|restart|status|url
erispm web passwd       # تغییر پسورد ادمین
```

<div align="center">
<img src="docs/web-dashboard.jpg" alt="dashboard" width="48%">
&nbsp;
<img src="docs/web-install.jpg" alt="install" width="48%">
</div>

- **احراز هویت** — یوزرنیم + پسورد SHA‑256 نمک‌دار، کوکی نشست امضاشده با HMAC و انقضادار، `HttpOnly` + `SameSite=Strict`.
- **امنیت** — هر عملیات از یک allow‑list سخت‌گیر رد می‌شه و به‌صورت آرایه‌ی آرگومان اجرا می‌شه
  (نه رشته‌ی شل)، پس هیچ‌چیزی از مرورگر نمی‌تونه دستور تزریق کنه.
- **کنسول زنده** — خروجی هر کار بلادرنگ با خطوط رنگی `✓ / ✗ / ▸` استریم می‌شه.

> پنل وب با `root` اجرا می‌شه (چاره‌ای نیست، باید سرویس‌های سیستم رو مدیریت کنه). پشت HTTPS بذارش،
> پسورد قوی انتخاب کن، و پورتش رو فقط به آدرس‌های مورد‌اعتماد باز کن.

---

## مرجع دستورات (CLI)

هرکاری که منوها می‌کنن، یک ساب‌کامند ساده هم هست — مناسب اتوماسیون و خودِ پنل وب.

```bash
erispm install-panel <pasarguard|marzban|marzneshin|3x-ui>
erispm install-node  <pasarguard-node|marzban-node|marzneshin-node>
erispm delete-panel  <key> [--purge]
erispm backup  <pasarguard|marzban|marzneshin|3x-ui> [outdir]
erispm restore <key> <archive.tar.gz>
erispm cert issue --domain panel.example.com --email you@example.com --method standalone
erispm cert list
erispm migrate --to root@NEW_IP --port 22 --panels ALL --dry-run
erispm tunnel install <spoof|eris-tunnel-2>
erispm web <install|start|stop|restart|status|url|passwd>
erispm status [--json]
erispm update
```

فلگ‌های سراسری: `-y` / `--yes`، `NO_COLOR=1`، `ERISPM_YES=1` (کاملاً غیرتعاملی).

---

## مهاجرت

**روی سرور قدیمی** (مبدأ) اجراش کن. برای هر پنل یک بکاپ می‌گیره، روی SSH به مقصد کپی می‌کنه،
همون پنل رو اونجا نصب و ریستور می‌کنه — تکی یا همه با‌هم.

```bash
# اول یک dry-run کامل (بدون تغییر)
erispm migrate --to root@203.0.113.9 --panels ALL --dry-run

# بعد واقعی (احراز با کلید)
erispm migrate --to root@203.0.113.9 --panels ALL

# احراز با پسورد، یک پنل خاص، پورت دلخواه
ERISPM_SSH_PASS='…' erispm migrate --to root@203.0.113.9 --port 2222 \
  --panels marzban --password-env ERISPM_SSH_PASS
```

بعد از مهاجرت، DNS دامنه رو به سرور جدید اشاره بده و سرتیفیکیت‌ها رو همون‌جا دوباره بگیر
(`erispm` → *Certificates*).

---

## 💜 حمایت

اگه برات وقت صرفه‌جویی کرد، یه کمک کوچیک پروژه رو زنده نگه می‌داره:

<!-- آدرس‌های زیر placeholder هستن؛ آدرس ولت واقعی‌ت رو جایگزین کن و کامیت کن. -->
| دارایی | آدرس |
|---|---|
| USDT (TRC20) | `YOUR_USDT_TRC20_ADDRESS_HERE` |
| USDT (BEP20)  | `YOUR_USDT_BEP20_ADDRESS_HERE` |
| TON | `YOUR_TON_ADDRESS_HERE` |
| BTC | `YOUR_BTC_ADDRESS_HERE` |

ارتباط / پشتیبانی: **@erisrttg**

---

## تشکر

اریس پنل منیجر یک ارکستریتوره — همه‌ی کار اصلی رو این پروژه‌های عالی بالادست انجام می‌دن که
مستقیم از منبع رسمی‌شون نصب می‌شن:

- [PasarGuard](https://github.com/PasarGuard) · [Marzban](https://github.com/Gozargah/Marzban) ·
  [Marzneshin](https://github.com/marzneshin/Marzneshin) · [3x‑ui](https://github.com/MHSanaei/3x-ui)
- [acme.sh](https://github.com/acmesh-official/acme.sh)
- [spoof-tunnel](https://github.com/ParsaKSH/spoof-tunnel) · [Eris Tunnel 2](https://github.com/eris4444/eris-tunnel-2)

## لایسنس

[MIT](LICENSE) © 2026 eris4444
