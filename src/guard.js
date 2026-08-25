'use strict';

/**
 * Basit kaba kuvvet korumasi. Kameralar sabit IP'den baglanmadigi icin FTP portu
 * herkese acik kalmak zorunda; bu yuzden ayni IP'den ust uste basarisiz giris
 * yapanlar gecici olarak engellenir.
 *
 * Basarili girisde o IP'nin sayaci sifirlanir, boylece parolasini bir kez yanlis
 * giren kamera cezalandirilmaz.
 */
class LoginGuard {
  constructor({ maxFailures = 10, banMinutes = 15 } = {}) {
    this.maxFailures = maxFailures;
    this.banMs = banMinutes * 60 * 1000;
    this.entries = new Map(); // ip -> {failures, bannedUntil, lastAt, lastUser}
  }

  _entry(ip) {
    if (!this.entries.has(ip)) {
      this.entries.set(ip, { failures: 0, bannedUntil: 0, lastAt: 0, lastUser: null });
    }
    return this.entries.get(ip);
  }

  /** Engelli mi? Engel suresi dolduysa kayit temizlenir. */
  isBanned(ip) {
    const e = this.entries.get(ip);
    if (!e) return false;
    if (e.bannedUntil && e.bannedUntil > Date.now()) return true;
    if (e.bannedUntil) {
      // Ceza doldu, temiz sayfa
      e.bannedUntil = 0;
      e.failures = 0;
    }
    return false;
  }

  bannedUntil(ip) {
    const e = this.entries.get(ip);
    return e && e.bannedUntil > Date.now() ? e.bannedUntil : 0;
  }

  fail(ip, username) {
    const e = this._entry(ip);
    e.failures += 1;
    e.lastAt = Date.now();
    e.lastUser = username || null;
    if (e.failures >= this.maxFailures) {
      e.bannedUntil = Date.now() + this.banMs;
      return true; // yeni engel
    }
    return false;
  }

  succeed(ip) {
    const e = this.entries.get(ip);
    if (e) {
      e.failures = 0;
      e.bannedUntil = 0;
    }
  }

  unban(ip) {
    this.entries.delete(ip);
  }

  /** Panelde gostermek icin: aktif engeller ve son basarisiz denemeler. */
  snapshot() {
    const now = Date.now();
    const rows = [];
    for (const [ip, e] of this.entries) {
      if (!e.failures && !e.bannedUntil) continue;
      rows.push({
        ip,
        failures: e.failures,
        banned: e.bannedUntil > now,
        bannedUntil: e.bannedUntil > now ? new Date(e.bannedUntil).toISOString() : null,
        lastAt: e.lastAt ? new Date(e.lastAt).toISOString() : null,
        lastUser: e.lastUser,
      });
    }
    return rows.sort((a, b) => b.failures - a.failures).slice(0, 50);
  }

  /** Suresi dolmus kayitlari atar; bellek sinirsiz buyumesin. */
  sweep() {
    const cutoff = Date.now() - Math.max(this.banMs, 60 * 60 * 1000);
    for (const [ip, e] of this.entries) {
      if (e.bannedUntil > Date.now()) continue;
      if (e.lastAt < cutoff) this.entries.delete(ip);
    }
  }
}

module.exports = { LoginGuard };
