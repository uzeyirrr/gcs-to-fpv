'use strict';

const http = require('http');
const crypto = require('crypto');
const { dateStamp } = require('./stats');
const { listDays, listDayFiles, streamObject, deleteObjects } = require('./gallery');

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
a{color:#6bb8ff}
.nav{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0 4px}
.nav a,.chip{display:inline-block;padding:6px 12px;border-radius:999px;font-size:13px;
  border:1px solid #2b3145;color:#c9cfdd;text-decoration:none;background:#0b0d12}
.nav a:hover{background:#1b1f2b}
.nav a.sel,.chip.sel{background:#1f6feb;border-color:#1f6feb;color:#fff}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px;margin-top:14px}
.tile{background:#161923;border:1px solid #232838;border-radius:9px;overflow:hidden}
.tile a{display:block;line-height:0}
.tile img{width:100%;height:140px;object-fit:cover;background:#0b0d12}
.tile .meta{padding:7px 9px;line-height:1.35}
.tile .meta b{font-size:12px;font-weight:600;display:block;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.vid{display:flex;align-items:center;justify-content:center;height:140px;
  background:#0b0d12;color:#6bb8ff;font-size:13px}
.tile .pick{display:flex;align-items:center;gap:6px;padding:6px 9px 0;font-size:12px;
  color:#8b93a7;cursor:pointer}
.tile .pick input{width:15px;height:15px;padding:0;accent-color:#1f6feb}
`;

function renderDashboard({ snap, users, message, ftpInfo, staleAfterMinutes, guardRows = [] }) {
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
  <td>${c.uploadsTotal || 0}<br><span class="dim">${humanBytes(c.bytesTotal || 0)}</span>${
    c.deletesTotal
      ? `<br><span class="dim">${c.deletesTotal} silindi · ${humanBytes(c.deletedBytesTotal || 0)}</span>`
      : ''}</td>
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

<div class="nav" style="margin:18px 0 0"><a href="/galeri" class="sel">Galeriyi aç →</a></div>

<h2>Kameralar (${users.length})</h2>
<div class="tablewrap"><table>
<thead><tr>
  <th>Kamera / Klasör</th><th>Durum</th><th>FTP bilgisi</th><th>Son yükleme</th>
  <th>Bugün</th><th>Toplam</th><th>Son bağlantı</th><th>Son hata</th><th>İşlem</th>
</tr></thead>
<tbody>${rows || '<tr><td colspan="9" class="dim">Henüz kamera eklenmemiş</td></tr>'}</tbody>
</table></div>

${guardRows.length ? `<h2>Başarısız giriş denemeleri</h2>
<div class="tablewrap"><table style="min-width:640px">
<thead><tr><th>IP</th><th>Durum</th><th>Deneme</th><th>Son deneme</th><th>Denenen kullanıcı</th><th></th></tr></thead>
<tbody>${guardRows.map((g) => `<tr>
  <td><code>${esc(g.ip)}</code></td>
  <td>${g.banned ? '<span class="pill kapali">Engelli</span>' : '<span class="pill yok">İzleniyor</span>'}</td>
  <td>${g.failures}</td>
  <td>${ago(g.lastAt)}</td>
  <td class="dim">${esc(g.lastUser || '—')}</td>
  <td><form class="inline" method="post" action="/ip/kaldir">
    <input type="hidden" name="ip" value="${esc(g.ip)}">
    <button class="ghost" type="submit">Engeli kaldır</button></form></td>
</tr>`).join('')}</tbody></table></div>` : ''}

<div class="dim" style="margin-top:18px">
  "Sessiz" = ${staleAfterMinutes} dakikadır yükleme yok · "Toplam" sayaçlarından galeriden silinenler
  düşülür · Sayfa otomatik yenilenmez, güncellemek için
  <a href="/" style="color:#6bb8ff">yenileyin</a>
</div>

</div></body></html>`;
}


function renderGallery({ cameras, selected, days, day, files, hours, hour,
                        offset, pageSize, total, truncated, message }) {
  const camNav = cameras.map((c) =>
    `<a href="/galeri?kamera=${encodeURIComponent(c.username)}"
        class="${c.username === selected ? 'sel' : ''}">${esc(c.label || c.username)}</a>`
  ).join('');

  const dayNav = days.map((d) =>
    `<a href="/galeri?kamera=${encodeURIComponent(selected)}&gun=${encodeURIComponent(d)}"
        class="${d === day ? 'sel' : ''}">${esc(d)}</a>`
  ).join('');

  const base = `/galeri?kamera=${encodeURIComponent(selected)}&gun=${encodeURIComponent(day)}`;
  const hourNav = (hours || []).length
    ? `<a href="${base}" class="${hour ? '' : 'sel'}">Tümü (${total})</a>` +
      hours.map(([h, n]) =>
        `<a href="${base}&saat=${encodeURIComponent(h)}"
            class="${h === hour ? 'sel' : ''}">${esc(h)}:00 <span class="dim">(${n})</span></a>`
      ).join('')
    : '';

  const tiles = files.map((f) => {
    const src = `/dosya?k=${encodeURIComponent(f.key)}`;
    const inner = f.kind === 'resim'
      ? `<img loading="lazy" src="${src}" alt="${esc(f.name)}">`
      : `<div class="vid">▶ video</div>`;
    const when = f.time || '';
    return `<div class="tile">
  <label class="pick"><input type="checkbox" name="k" value="${esc(f.key)}"> seç</label>
  <a href="${src}" target="_blank" rel="noopener">${inner}</a>
  <div class="meta"><b title="${esc(f.name)}">${esc(f.name)}</b>
    <span class="dim">${esc(when)} · ${humanBytes(f.size)}</span></div>
</div>`;
  }).join('');

  const saatQ = hour ? `&saat=${encodeURIComponent(hour)}` : '';
  const sayfa = [];
  if (offset > 0) {
    sayfa.push(`<a href="${base}${saatQ}&s=${Math.max(0, offset - pageSize)}">← Önceki</a>`);
  }
  if (offset + pageSize < total) {
    sayfa.push(`<a href="${base}${saatQ}&s=${offset + pageSize}">Sonraki →</a>`);
  }
  const more = sayfa.length
    ? `<div class="nav" style="margin-top:16px">${sayfa.join('')}
         <span class="chip">${offset + 1}–${Math.min(offset + pageSize, total)} / ${total}</span></div>`
    : '';
  const prev = truncated
    ? `<div class="dim" style="margin-top:12px">Bu günde çok fazla dosya var; yalnızca en yeni
         ${total} tanesi tarandı. Saat filtresiyle daraltın.</div>`
    : '';

  let body;
  if (!cameras.length) {
    body = '<div class="dim">Henüz kamera yok.</div>';
  } else if (!days.length) {
    body = '<div class="dim">Bu kamera henüz dosya yüklememiş.</div>';
  } else if (!files.length) {
    body = '<div class="dim">Bu günde görüntülenebilir dosya yok.</div>';
  } else {
    const geri = `${base}${saatQ}${offset ? `&s=${offset}` : ''}`;
    body = `<form method="post" action="/galeri/sil" id="silForm"
      onsubmit="return galeriOnayla(this)">
  <input type="hidden" name="geri" value="${esc(geri)}">
  <div class="row" style="margin-top:14px">
    <label class="chip" style="cursor:pointer">
      <input type="checkbox" onchange="galeriTumu(this.checked)"> Bu sayfada tümünü seç</label>
    <button class="danger" type="submit">Seçilenleri sil</button>
    <span class="dim" id="silSayac">0 dosya seçili</span>
  </div>
  <div class="grid">${tiles}</div>
</form>${more}${prev}
<script>
function galeriKutular(){return document.querySelectorAll('#silForm input[name=k]')}
function galeriSayac(){
  var n=document.querySelectorAll('#silForm input[name=k]:checked').length;
  document.getElementById('silSayac').textContent=n+' dosya seçili';
}
function galeriTumu(v){galeriKutular().forEach(function(c){c.checked=v});galeriSayac()}
function galeriOnayla(f){
  var n=f.querySelectorAll('input[name=k]:checked').length;
  if(!n){alert('Önce silinecek dosyaları seçin.');return false}
  return confirm(n+' dosya GCS'ten kalıcı olarak silinecek. Onaylıyor musunuz?');
}
document.addEventListener('change',function(e){
  if(e.target && e.target.name==='k') galeriSayac();
});
</script>`;
  }

  return `<!doctype html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Galeri — Kamera FTP</title>
<style>${STYLE}</style></head><body><div class="wrap">
${message ? `<div class="msg ${message.kind === 'bad' ? 'bad' : 'good'}">${esc(message.text)}</div>` : ''}
<div class="bar">
  <div><h1>Galeri</h1>
    <div class="dim">${esc(selected || '')}${day ? ' · ' + esc(day) : ''}${hour ? ' · ' + esc(hour) + ':00' : ''}${total ? ' · ' + total + ' dosya' : ''}</div>
  </div>
  <div class="dim"><a href="/">← Panele dön</a></div>
</div>
<h2 style="margin-top:20px">Kamera</h2>
<div class="nav">${camNav}</div>
${days.length ? '<h2>Gün</h2><div class="nav">' + dayNav + '</div>' : ''}
${hourNav ? '<h2>Saat</h2><div class="nav">' + hourNav + '</div>' : ''}
${body}
</div></body></html>`;
}

const PAGE = 120; // galeride sayfa basina dosya

/**
 * Islem sonucu mesajlari. Yeni uretilen FTP parolasi kullaniciya gosterilmek
 * zorunda; sorgu dizesine konursa tarayici gecmisine ve arada duran Cloudflare /
 * Traefik erisim kayitlarina duser. Bu yuzden mesaj sunucuda tutulur ve
 * yonlendirmede yalnizca tahmin edilemez, tek kullanimlik bir kimlik tasinir.
 */
class FlashStore {
  constructor({ ttlMs = 5 * 60 * 1000 } = {}) {
    this.ttlMs = ttlMs;
    this.items = new Map();
  }

  put(kind, text) {
    this._sweep();
    const id = crypto.randomBytes(16).toString('hex');
    this.items.set(id, { kind, text, expiresAt: Date.now() + this.ttlMs });
    return id;
  }

  take(id) {
    const item = this.items.get(id);
    if (!item) return null;
    this.items.delete(id); // tek kullanimlik
    return item.expiresAt > Date.now() ? item : null;
  }

  _sweep() {
    const now = Date.now();
    for (const [id, item] of this.items) {
      if (item.expiresAt <= now) this.items.delete(id);
    }
  }
}

/**
 * CSRF kontrolu. Basic auth cerez olmadigi icin SameSite korumasi devreye girmez:
 * tarayici, kimlik bilgilerini istegi kim baslatirsa baslatsin o origin'e ekler.
 * Bu yuzden durum degistiren her istekte kaynagin kendi sayfamiz oldugunu
 * dogruluyoruz.
 */
function sameOrigin(req) {
  const host = req.headers.host;
  if (!host) return false;

  const kaynak = req.headers.origin || req.headers.referer;
  if (!kaynak) return false; // basligi olmayan istek kabul edilmez

  try {
    return new URL(kaynak).host === host;
  } catch (err) {
    return false;
  }
}

function startPanel({ stats, store, config, s3, guard }) {
  const { port, user, pass, staleAfterMinutes } = config.stats;
  const needsAuth = Boolean(user && pass);
  const expected = needsAuth
    ? 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')
    : null;
  const ftpInfo = { host: config.ftp.pasvUrl, port: config.ftp.port };
  const flash = new FlashStore();

  const redirect = (res, kind, text) => {
    const id = flash.put(kind === 'ok' ? 'good' : 'bad', text);
    res.writeHead(303, { location: `/?m=${id}` });
    res.end();
  };

  /**
   * Galeriye geri doner. `geri` istemciden geldigi icin acik yonlendirmeye
   * donusmemesi adina yalnizca kendi galeri yolumuz kabul edilir.
   */
  const galeriDon = (res, geri, kind, text) => {
    const id = flash.put(kind === 'ok' ? 'good' : 'bad', text);
    const hedef = typeof geri === 'string' && /^\/galeri(\?|$)/.test(geri) ? geri : '/galeri';
    res.writeHead(303, { location: `${hedef}${hedef.includes('?') ? '&' : '?'}m=${id}` });
    res.end();
  };

  /**
   * Bir bucket anahtarina panel uzerinden dokunulabilir mi? Yalnizca tanimli
   * kamera klasorlerinin altindaki dosyalar okunabilir/silinebilir;
   * _system/users.json gibi kayitlar (parolalar dahil) hicbir kosulda gecemez.
   * Tek kullanicili modda kullanicinin kokü prefix'in kendisidir, bu yuzden
   * store.key acik olarak disarida birakilir.
   */
  const anahtarIzinli = (key) => {
    if (!key || key.includes('..') || key === store.key) return false;
    if (key.endsWith('/')) return false;
    return store.list().some((u) => key.startsWith(config.s3.prefix + u.dir));
  };

  /**
   * Bir anahtarin hangi kameraya ve hangi gun klasorune ait oldugunu bulur.
   * Tek kullanicili modda kullanicinin dir'i bos olabilecegi icin en uzun
   * eslesen klasor secilir.
   */
  const anahtarSahibi = (key) => {
    let sahip = null;
    let base = '';
    for (const u of store.list()) {
      const kok = config.s3.prefix + u.dir;
      if (key.startsWith(kok) && kok.length >= base.length) {
        sahip = u;
        base = kok;
      }
    }
    if (!sahip) return null;
    const gun = key.slice(base.length).split('/')[0] || null;
    return { username: sahip.username, day: /^\d{4}-\d{2}-\d{2}$/.test(gun) ? gun : null };
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
        if (!sameOrigin(req)) {
          console.warn(
            `[panel] CSRF reddedildi: ${url.pathname} ` +
            `(origin=${req.headers.origin || req.headers.referer || 'yok'})`
          );
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          return res.end('Istek reddedildi: gecersiz kaynak');
        }

        if (url.pathname === '/galeri/sil') {
          try {
            // Bir sayfa dolusu anahtar tasindigi icin govde siniri genis tutuluyor.
            const body = await readBody(req, 512 * 1024);
            const istenen = body.getAll('k').filter(Boolean);
            const gecerli = istenen.filter(anahtarIzinli);

            if (!istenen.length) {
              return galeriDon(res, body.get('geri'), 'hata', 'Silinecek dosya seçilmedi.');
            }
            if (gecerli.length !== istenen.length) {
              console.warn(`[panel] galeri silme: ${istenen.length - gecerli.length} izinsiz anahtar reddedildi`);
              return galeriDon(res, body.get('geri'), 'hata',
                'İstek reddedildi: erişilemeyen dosya anahtarı var.');
            }

            const { deleted, failed } = await deleteObjects(s3.client, s3.bucket, gecerli);

            // Sayaclar kamera ve gun bazinda toplanip tek seferde islenir.
            const gruplar = new Map();
            for (const { key, size } of deleted) {
              const sahip = anahtarSahibi(key);
              if (!sahip) continue;
              const id = `${sahip.username} ${sahip.day || ''}`;
              const g = gruplar.get(id) || { username: sahip.username, day: sahip.day, count: 0, bytes: 0 };
              g.count += 1;
              g.bytes += size;
              gruplar.set(id, g);
            }
            for (const g of gruplar.values()) {
              stats.deleted(g.username, { count: g.count, bytes: g.bytes, day: g.day });
            }

            const toplamBayt = deleted.reduce((n, d) => n + d.size, 0);
            console.log(`[panel] galeriden silindi: ${deleted.length} dosya / ${humanBytes(toplamBayt)}` +
              (failed.length ? `, ${failed.length} basarisiz` : ''));

            return failed.length
              ? galeriDon(res, body.get('geri'), 'hata',
                  `${deleted.length} dosya silindi (${humanBytes(toplamBayt)}), ` +
                  `${failed.length} tanesi silinemedi (${failed[0].error}).`)
              : galeriDon(res, body.get('geri'), 'ok',
                  `${deleted.length} dosya silindi (${humanBytes(toplamBayt)}).`);
          } catch (err) {
            return galeriDon(res, null, 'hata', err.message);
          }
        }

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
          if (url.pathname === '/ip/kaldir') {
            const ip = (body.get('ip') || '').trim();
            guard.unban(ip);
            console.log(`[panel] IP engeli kaldirildi: ${ip}`);
            return redirect(res, 'ok', `${ip} engeli kaldirildi.`);
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

      if (url.pathname === '/dosya') {
        const key = url.searchParams.get('k') || '';
        if (!anahtarIzinli(key)) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          return res.end('Bu dosyaya erisim yok');
        }
        return streamObject(s3.client, s3.bucket, key, req, res);
      }

      if (url.pathname === '/galeri') {
        const galeriMesajId = url.searchParams.get('m');
        const galeriMesaj = galeriMesajId ? flash.take(galeriMesajId) : null;
        const cameras = store.list();
        const istenen = url.searchParams.get('kamera');
        const secili = cameras.find((c) => c.username === istenen) || cameras[0];

        if (!secili) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          return res.end(renderGallery({
            cameras: [], selected: '', days: [], day: '', files: [],
            hours: [], hour: '', offset: 0, pageSize: PAGE, total: 0, truncated: false,
            message: galeriMesaj,
          }));
        }

        const camPrefix = config.s3.prefix + secili.dir;
        const days = await listDays(s3.client, s3.bucket, camPrefix);
        const istenenGun = url.searchParams.get('gun');
        const gun = days.includes(istenenGun) ? istenenGun : days[0] || '';

        let tumu = [];
        let hours = [];
        let truncated = false;
        if (gun) {
          const sonuc = await listDayFiles(s3.client, s3.bucket, `${camPrefix}${gun}/`, {
            timezone: config.timezone,
          });
          tumu = sonuc.files;
          hours = sonuc.hours;
          truncated = sonuc.truncated;
        }

        const istenenSaat = url.searchParams.get('saat') || '';
        const saat = hours.some(([h]) => h === istenenSaat) ? istenenSaat : '';
        const suzulmus = saat ? tumu.filter((f) => f.hour === saat) : tumu;

        // Silme sonrasi dosya sayisi azalmis olabilir; bos sayfada kalinmasin.
        const istenenOffset = Math.max(0, parseInt(url.searchParams.get('s') || '0', 10) || 0);
        const offset = istenenOffset < suzulmus.length
          ? istenenOffset
          : Math.max(0, (Math.ceil(suzulmus.length / PAGE) - 1) * PAGE);
        const sayfa = suzulmus.slice(offset, offset + PAGE);

        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(renderGallery({
          cameras,
          selected: secili.username,
          days,
          day: gun,
          files: sayfa,
          hours,
          hour: saat,
          offset,
          pageSize: PAGE,
          total: suzulmus.length,
          truncated,
          message: galeriMesaj,
        }));
      }

      if (url.pathname === '/stats.json') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({
          ...snap,
          users: store.list().map(({ password, ...rest }) => rest),
          loginGuard: guard.snapshot(),
        }, null, 2));
      }

      if (url.pathname !== '/') {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('Bulunamadi');
      }

      const flashId = url.searchParams.get('m');
      const message = flashId ? flash.take(flashId) : null;

      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(renderDashboard({
        snap,
        users: store.list(),
        message,
        ftpInfo,
        staleAfterMinutes,
        guardRows: guard.snapshot(),
      }));
    } catch (err) {
      console.error('[panel] hata:', err.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      }
      return res.end('Sunucu hatasi');
    }
  });

  if (!needsAuth) {
    // Panelden FTP hesabi acilabiliyor ve tum kamera goruntuleri gezilebiliyor.
    // Kimlik bilgisi tanimli degilse panel ACILMAZ; sessizce herkese acik
    // hale gelmesindense hic calismamasi tercih edilir. FTP sunucusu etkilenmez.
    const err = new Error(
      'STATS_USER/STATS_PASS tanimli degil - yonetim paneli baslatilmadi. ' +
      'Paneli kullanmak icin bu iki degeri ayarlayin, ya da STATS_ENABLED=false yapin.'
    );
    err.code = 'PANEL_AUTH_MISSING';
    return Promise.reject(err);
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

module.exports = { startPanel, dateStamp };
