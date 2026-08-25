'use strict';

const http = require('http');
const { dateStamp } = require('./stats');

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

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) {
        reject(new Error('Istek govdesi cok buyuk'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(new URLSearchParams(data)));
    req.on('error', reject);
  });
}

const STYLE = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;padding:24px;
     background:#0f1115;color:#e6e8ee}
.wrap{max-width:1180px;margin:0 auto}
h1{font-size:21px;margin:0 0 4px}
h2{font-size:15px;margin:32px 0 12px;color:#c9cfdd}
.dim{color:#8b93a7;font-size:12px}
.err{color:#ff8f8f}
.ok{color:#66dd8f}
.bar{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap}
.msg{margin:16px 0;padding:12px 14px;border-radius:8px;font-size:14px}
.msg.good{background:#123d24;color:#8ce8ab;border:1px solid #1d5c37}
.msg.bad{background:#3d1414;color:#ffb0b0;border:1px solid #5c1d1d}
.card{background:#161923;border:1px solid #232838;border-radius:10px;padding:16px;margin-top:16px}
.tablewrap{overflow-x:auto;margin-top:12px}
table{border-collapse:collapse;width:100%;min-width:900px}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #232838;vertical-align:top}
th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#8b93a7;white-space:nowrap}
.pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;white-space:nowrap}
.pill.ok{background:#123d24;color:#66dd8f}
.pill.bagli{background:#12334d;color:#6bb8ff}
.pill.sessiz{background:#4d3b12;color:#ffc861}
.pill.yok{background:#2a2f3d;color:#8b93a7}
.pill.kapali{background:#3d1414;color:#ff9b9b}
code{background:#0b0d12;border:1px solid #232838;border-radius:5px;padding:1px 6px;font-size:12.5px}
form.inline{display:inline}
input,button{font:inherit;border-radius:7px;border:1px solid #2b3145;background:#0b0d12;
             color:#e6e8ee;padding:8px 11px}
input::placeholder{color:#5d6478}
button{cursor:pointer;background:#1f6feb;border-color:#1f6feb;color:#fff;font-size:14px}
button:hover{background:#2b7cf5}
button.ghost{background:transparent;border-color:#2b3145;color:#c9cfdd}
button.ghost:hover{background:#1b1f2b}
button.danger{background:transparent;border-color:#5c1d1d;color:#ff9b9b}
button.danger:hover{background:#2a1414}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.acts{display:flex;gap:6px;flex-wrap:wrap}
`;

function renderDashboard({ snap, users, message, ftpInfo, staleAfterMinutes }) {
  const staleMs = staleAfterMinutes * 60 * 1000;
  const statsBy = new Map(snap.cameras.map((c) => [c.username, c]));

  const rows = users.map((u) => {
    const c = statsBy.get(u.username) || {};
    const last = c.lastUploadAt ? new Date(c.lastUploadAt).getTime() : 0;
    const state = u.enabled === false
      ? ['kapali', 'Kapalı']
      : c.activeConnections > 0
        ? ['bagli', 'Bağlı']
        : !last
          ? ['yok', 'Hiç yüklemedi']
          : Date.now() - last > staleMs
            ? ['sessiz', 'Sessiz']
            : ['ok', 'Çalışıyor'];

    return `<tr>
  <td><strong>${esc(u.label || u.username)}</strong><br>
      <span class="dim">${esc(u.dir || '/')}${esc(snap.today)}/</span></td>
  <td><span class="pill ${state[0]}">${state[1]}</span></td>
  <td><code>${esc(u.username)}</code><br><code>${esc(u.password)}</code></td>
  <td>${ago(c.lastUploadAt)}<br><span class="dim">${esc(c.lastUploadPath || '—')}</span></td>
  <td>${c.uploadsToday || 0}<br><span class="dim">${humanBytes(c.bytesToday || 0)}</span></td>
  <td>${c.uploadsTotal || 0}<br><span class="dim">${humanBytes(c.bytesTotal || 0)}</span></td>
  <td>${esc(c.lastLoginIp || '—')}<br><span class="dim">${ago(c.lastLoginAt)}</span></td>
  <td>${c.lastError ? `<span class="err">${esc(c.lastError)}</span><br><span class="dim">${ago(c.lastErrorAt)}</span>` : '—'}</td>
  <td><div class="acts">
    <form class="inline" method="post" action="/kamera/parola">
      <input type="hidden" name="username" value="${esc(u.username)}">
      <button class="ghost" type="submit">Yeni parola</button></form>
    <form class="inline" method="post" action="/kamera/durum">
      <input type="hidden" name="username" value="${esc(u.username)}">
      <input type="hidden" name="enabled" value="${u.enabled === false ? '1' : '0'}">
      <button class="ghost" type="submit">${u.enabled === false ? 'Aç' : 'Kapat'}</button></form>
    <form class="inline" method="post" action="/kamera/sil"
          onsubmit="return confirm('${esc(u.username)} hesabı silinecek. GCS\\'teki dosyaları KALMAYA devam eder. Onaylıyor musunuz?')">
      <input type="hidden" name="username" value="${esc(u.username)}">
      <button class="danger" type="submit">Sil</button></form>
  </div></td>
</tr>`;
  }).join('');

  const msgBlock = message
    ? `<div class="msg ${message.kind === 'bad' ? 'bad' : 'good'}">${esc(message.text)}</div>`
    : '';

  return `<!doctype html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kamera FTP Paneli</title>
<style>${STYLE}</style></head><body><div class="wrap">

<div class="bar">
  <div>
    <h1>Kamera FTP Paneli</h1>
    <div class="dim">Bugünün klasörü: <code>${esc(snap.today)}</code> (${esc(snap.timezone)}) ·
      Sunucu ${ago(snap.startedAt)} başladı ·
      ${snap.unknownLoginAttempts} bilinmeyen giriş denemesi</div>
  </div>
  <div class="dim">FTP: <code>${esc(ftpInfo.host)}:${esc(ftpInfo.port)}</code> · Pasif mod ·
    <a href="/stats.json" style="color:#6bb8ff">JSON</a></div>
</div>

${msgBlock}

<div class="card">
  <h2 style="margin-top:0">Yeni kamera ekle</h2>
  <form method="post" action="/kamera/ekle" class="row">
    <input name="username" placeholder="kamera adı (ör. otopark)" required style="min-width:220px">
    <input name="label" placeholder="açıklama (isteğe bağlı)" style="min-width:220px">
    <input name="password" placeholder="parola (boş bırakırsanız üretilir)" style="min-width:260px">
    <button type="submit">Kamera oluştur</button>
  </form>
  <div class="dim" style="margin-top:10px">Kamera adı aynı zamanda GCS klasörü olur.
    Dosyalar <code>kameraadı/${esc(snap.today)}/</code> altına yazılır. Hesap anında geçerli olur,
    yeniden başlatma gerekmez.</div>
</div>

<h2>Kameralar (${users.length})</h2>
<div class="tablewrap"><table>
<thead><tr>
  <th>Kamera / Klasör</th><th>Durum</th><th>FTP bilgisi</th><th>Son yükleme</th>
  <th>Bugün</th><th>Toplam</th><th>Son bağlantı</th><th>Son hata</th><th>İşlem</th>
</tr></thead>
<tbody>${rows || '<tr><td colspan="9" class="dim">Henüz kamera eklenmemiş</td></tr>'}</tbody>
</table></div>

<div class="dim" style="margin-top:18px">
  "Sessiz" = ${staleAfterMinutes} dakikadır yükleme yok · Sayfa otomatik yenilenmez, güncellemek için
  <a href="/" style="color:#6bb8ff">yenileyin</a>
</div>

</div></body></html>`;
}

function startPanel({ stats, store, config }) {
  const { port, user, pass, staleAfterMinutes } = config.stats;
  const needsAuth = Boolean(user && pass);
  const expected = needsAuth
    ? 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')
    : null;
  const ftpInfo = { host: config.ftp.pasvUrl, port: config.ftp.port };

  const redirect = (res, kind, text) => {
    res.writeHead(303, { location: `/?${kind}=${encodeURIComponent(text)}` });
    res.end();
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('ok');
      }

      if (needsAuth && req.headers.authorization !== expected) {
        res.writeHead(401, {
          'www-authenticate': 'Basic realm="Kamera FTP Paneli"',
          'content-type': 'text/plain; charset=utf-8',
        });
        return res.end('Yetkisiz');
      }

      const url = new URL(req.url, 'http://localhost');

      if (req.method === 'POST') {
        const body = await readBody(req);
        const username = (body.get('username') || '').trim();
        try {
          if (url.pathname === '/kamera/ekle') {
            const created = await store.add({
              username,
              password: body.get('password'),
              label: body.get('label'),
            });
            stats.register(created.username, created.dir);
            console.log(`[panel] kamera eklendi: ${created.username}`);
            return redirect(res, 'ok',
              `"${created.username}" oluşturuldu. Kullanıcı: ${created.username} · Parola: ${created.password}`);
          }
          if (url.pathname === '/kamera/parola') {
            const newPass = await store.setPassword(username);
            console.log(`[panel] parola yenilendi: ${username}`);
            return redirect(res, 'ok', `"${username}" için yeni parola: ${newPass} — kameraya girmeyi unutmayın.`);
          }
          if (url.pathname === '/kamera/durum') {
            const enabled = body.get('enabled') === '1';
            await store.setEnabled(username, enabled);
            console.log(`[panel] ${username} -> ${enabled ? 'acik' : 'kapali'}`);
            return redirect(res, 'ok', `"${username}" ${enabled ? 'açıldı' : 'kapatıldı'}.`);
          }
          if (url.pathname === '/kamera/sil') {
            await store.remove(username);
            stats.forget(username);
            console.log(`[panel] kamera silindi: ${username}`);
            return redirect(res, 'ok', `"${username}" hesabı silindi. GCS'teki dosyaları duruyor.`);
          }
        } catch (err) {
          return redirect(res, 'hata', err.message);
        }
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('Bulunamadi');
      }

      const snap = stats.snapshot();

      if (url.pathname === '/stats.json') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({
          ...snap,
          users: store.list().map(({ password, ...rest }) => rest),
        }, null, 2));
      }

      if (url.pathname !== '/') {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('Bulunamadi');
      }

      const okMsg = url.searchParams.get('ok');
      const badMsg = url.searchParams.get('hata');
      const message = okMsg
        ? { kind: 'good', text: okMsg }
        : badMsg ? { kind: 'bad', text: badMsg } : null;

      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(renderDashboard({
        snap,
        users: store.list(),
        message,
        ftpInfo,
        staleAfterMinutes,
      }));
    } catch (err) {
      console.error('[panel] hata:', err.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      }
      return res.end('Sunucu hatasi');
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

module.exports = { startPanel, dateStamp };
