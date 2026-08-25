'use strict';

const http = require('http');

/** Verilen saat dilimine gore YYYY-MM-DD uretir. */
function dateStamp(timezone, when = new Date()) {
  try {
    // en-CA formati zaten YYYY-MM-DD verir
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(when);
  } catch (err) {
    // Gecersiz saat dilimi -> UTC'ye dus
    return when.toISOString().slice(0, 10);
  }
}

function emptyCamera(username, dir) {
  return {
    username,
    dir,
    activeConnections: 0,
    lastLoginAt: null,
    lastLoginIp: null,
    lastUploadAt: null,
    lastUploadPath: null,
    uploadsToday: 0,
    bytesToday: 0,
    uploadsTotal: 0,
    bytesTotal: 0,
    failedLogins: 0,
    lastError: null,
    lastErrorAt: null,
    _day: null,
  };
}

class Stats {
  constructor({ timezone }) {
    this.timezone = timezone;
    this.startedAt = new Date();
    this.cameras = new Map();
    this.unknownLoginAttempts = 0;
  }

  register(username, dir) {
    if (!this.cameras.has(username)) {
      this.cameras.set(username, emptyCamera(username, dir));
    }
  }

  _get(username) {
    if (!this.cameras.has(username)) this.register(username, '');
    const c = this.cameras.get(username);
    const today = dateStamp(this.timezone);
    if (c._day !== today) {
      c._day = today;
      c.uploadsToday = 0;
      c.bytesToday = 0;
    }
    return c;
  }

  login(username, ip) {
    const c = this._get(username);
    c.activeConnections += 1;
    c.lastLoginAt = new Date().toISOString();
    c.lastLoginIp = ip || null;
  }

  logout(username) {
    const c = this._get(username);
    c.activeConnections = Math.max(0, c.activeConnections - 1);
  }

  failedLogin(username) {
    if (this.cameras.has(username)) this.cameras.get(username).failedLogins += 1;
    else this.unknownLoginAttempts += 1;
  }

  upload(username, key, bytes) {
    const c = this._get(username);
    c.uploadsToday += 1;
    c.bytesToday += bytes;
    c.uploadsTotal += 1;
    c.bytesTotal += bytes;
    c.lastUploadAt = new Date().toISOString();
    c.lastUploadPath = key;
  }

  error(username, message) {
    const c = this._get(username);
    c.lastError = message;
    c.lastErrorAt = new Date().toISOString();
  }

  snapshot() {
    const today = dateStamp(this.timezone);
    return {
      startedAt: this.startedAt.toISOString(),
      now: new Date().toISOString(),
      timezone: this.timezone,
      today,
      unknownLoginAttempts: this.unknownLoginAttempts,
      cameras: [...this.cameras.values()].map(({ _day, ...rest }) => {
        const fresh = _day === today;
        return {
          ...rest,
          uploadsToday: fresh ? rest.uploadsToday : 0,
          bytesToday: fresh ? rest.bytesToday : 0,
        };
      }),
    };
  }
}

function humanBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function ago(iso) {
  if (!iso) return '—';
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs} sn önce`;
  if (secs < 3600) return `${Math.round(secs / 60)} dk önce`;
  if (secs < 86400) return `${Math.round(secs / 3600)} sa önce`;
  return `${Math.round(secs / 86400)} gün önce`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

function renderHtml(snap, staleAfterMinutes) {
  const staleMs = staleAfterMinutes * 60 * 1000;
  const rows = snap.cameras.map((c) => {
    const last = c.lastUploadAt ? new Date(c.lastUploadAt).getTime() : 0;
    const state = c.activeConnections > 0
      ? ['bagli', 'Bağlı']
      : !last
        ? ['yok', 'Hiç yüklemedi']
        : Date.now() - last > staleMs
          ? ['sessiz', 'Sessiz']
          : ['ok', 'Çalışıyor'];
    return `<tr>
      <td><strong>${escapeHtml(c.username)}</strong><br><span class="dim">${escapeHtml(c.dir || '/')}</span></td>
      <td><span class="pill ${state[0]}">${state[1]}</span></td>
      <td>${ago(c.lastUploadAt)}<br><span class="dim">${escapeHtml(c.lastUploadPath || '—')}</span></td>
      <td>${c.uploadsToday}<br><span class="dim">${humanBytes(c.bytesToday)}</span></td>
      <td>${c.uploadsTotal}<br><span class="dim">${humanBytes(c.bytesTotal)}</span></td>
      <td>${escapeHtml(c.lastLoginIp || '—')}<br><span class="dim">${ago(c.lastLoginAt)}</span></td>
      <td>${c.lastError ? `<span class="err">${escapeHtml(c.lastError)}</span><br><span class="dim">${ago(c.lastErrorAt)}</span>` : '—'}</td>
    </tr>`;
  }).join('');

  return `<!doctype html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kamera FTP Durumu</title>
<meta http-equiv="refresh" content="30">
<style>
:root{color-scheme:light dark}
body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:24px;background:#0f1115;color:#e6e8ee}
h1{font-size:20px;margin:0 0 4px}
.dim{color:#8b93a7;font-size:12px}
.err{color:#ff8080;font-size:12px}
table{border-collapse:collapse;width:100%;margin-top:16px}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #232838;vertical-align:top}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#8b93a7}
.pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px}
.pill.ok{background:#123d24;color:#66dd8f}
.pill.bagli{background:#12334d;color:#6bb8ff}
.pill.sessiz{background:#4d3b12;color:#ffc861}
.pill.yok{background:#2a2f3d;color:#8b93a7}
</style></head><body>
<h1>Kamera FTP Durumu</h1>
<div class="dim">Bugün (${escapeHtml(snap.timezone)}): ${escapeHtml(snap.today)} · Sunucu ${ago(snap.startedAt)} başladı · ${snap.unknownLoginAttempts} bilinmeyen giriş denemesi · 30 sn'de bir yenilenir</div>
<table>
<thead><tr><th>Kamera</th><th>Durum</th><th>Son yükleme</th><th>Bugün</th><th>Toplam</th><th>Son bağlantı</th><th>Son hata</th></tr></thead>
<tbody>${rows || '<tr><td colspan="7" class="dim">Tanımlı kamera yok</td></tr>'}</tbody>
</table>
<div class="dim" style="margin-top:16px">JSON: <code>/stats.json</code> · "Sessiz" = ${staleAfterMinutes} dakikadır yükleme yok</div>
</body></html>`;
}

function startStatsServer(stats, { port, user, pass, staleAfterMinutes }) {
  const needsAuth = Boolean(user && pass);
  const expected = needsAuth
    ? 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')
    : null;

  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('ok');
    }

    if (needsAuth && req.headers.authorization !== expected) {
      res.writeHead(401, {
        'www-authenticate': 'Basic realm="Kamera FTP Durumu"',
        'content-type': 'text/plain',
      });
      return res.end('Yetkisiz');
    }

    const snap = stats.snapshot();
    if (req.url && req.url.startsWith('/stats.json')) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(snap, null, 2));
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(renderHtml(snap, staleAfterMinutes));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

module.exports = { Stats, dateStamp, startStatsServer };
