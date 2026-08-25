'use strict';

/**
 * FTP_USERS formati:  kullanici:parola[:klasor]  virgul veya yeni satirla ayrilir.
 *
 *   FTP_USERS=cam01:parola1,cam02:parola2
 *   FTP_USERS=cam01:parola1:giris-kamerasi,cam02:parola2
 *
 * Klasor verilmezse kullanici adi klasor olarak kullanilir. Her kullanici yalnizca
 * kendi klasorunu gorur (kok dizini o klasordur).
 */
function parseUsers(raw, { fallbackUser, fallbackPass } = {}) {
  const users = new Map();

  if (raw && raw.trim()) {
    const entries = raw
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);

    for (const entry of entries) {
      const [name, pass, dir] = entry.split(':').map((s) => (s || '').trim());
      if (!name || !pass) {
        throw new Error(`FTP_USERS icinde gecersiz kayit: "${entry}" (kullanici:parola bekleniyor)`);
      }
      if (users.has(name)) {
        throw new Error(`FTP_USERS icinde tekrar eden kullanici: "${name}"`);
      }
      users.set(name, { username: name, password: pass, dir: normalizeDir(dir || name) });
    }
  }

  // Tek kullanicili eski yapilandirmayla uyumluluk
  if (users.size === 0 && fallbackUser && fallbackPass) {
    users.set(fallbackUser, {
      username: fallbackUser,
      password: fallbackPass,
      dir: '', // bucket kokune (S3_PREFIX altina) yazar
    });
  }

  if (users.size === 0) {
    throw new Error('Hic FTP kullanicisi tanimli degil (FTP_USERS ya da FTP_USER/FTP_PASS gerekli)');
  }

  return users;
}

function normalizeDir(dir) {
  const cleaned = String(dir).replace(/^\/+|\/+$/g, '').trim();
  if (!cleaned) return '';
  if (cleaned.includes('..')) {
    throw new Error(`FTP_USERS klasor adinda ".." kullanilamaz: "${dir}"`);
  }
  return cleaned + '/';
}

module.exports = { parseUsers };
