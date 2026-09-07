'use strict';

/**
 * Basit kaba kuvvet korumasi. Kameralar sabit IP'den baglanmadigi icin FTP portu
 * herkese acik kalmak zorunda; bu yuzden ayni IP'den ust uste basarisiz giris
 * yapanlar gecici olarak engellenir.
 *
 * Basarili girisde o IP'nin sayaci sifirlanir, boylece parolasini bir kez yanlis
 * giren kamera cezalandirilmaz.
 *
 * Ayrica IP basina yuk sinirlanir: dogru parolayla da olsa saniyede birkac kez
 * yeniden baglanan tek bir kamera, her baglantida pasif mod portu tuttugu icin
 * (bkz. pasv.js) tum port araligini yiyip diger kameralari disarida birakabilir.
 */
class LoginGuard {
  constructor({
    maxFailures = 10,
    banMinutes = 15,
    maxPerIp = 20,
    maxLoginsPerMinute = 120,
    sessionTtlMinutes = 30,
  } = {}) {
    this.maxFailures = maxFailures;
    this.banMs = banMinutes * 60 * 1000;
    this.maxPerIp = maxPerIp;
    this.maxLoginsPerMinute = maxLoginsPerMinute;
    // Guvenlik agi: bir oturum kapanisi kacirilirsa sayac sonsuza kadar dolu
    // kalir ve saglikli bir kamerayi kalici olarak disarida birakirdi. Bu
    // sureden eski oturumlar sayima katilmaz.
    this.sessionTtlMs = sessionTtlMinutes * 60 * 1000;
    this.entries = new Map();
  }

  _entry(ip) {
    if (!this.entries.has(ip)) {
      this.entries.set(ip, {
        failures: 0,
        bannedUntil: 0,
        lastAt: 0,
        lastUser: null,
        // Yuk sinirlama: acik oturumlarin baslangic zamanlari, son bir
        // dakikanin giris zamanlari ve yuk yuzunden reddedilen istek sayaci.
        sessions: [],
        logins: [],
        throttled: 0,
        lastThrottleAt: 0,
      });
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

  /**
   * IP su an yeni bir oturum acabilir mi? Kimlik dogrulamadan once cagrilir;
   * cagri basina bir giris denemesi kaydedilir.
   *
   * Doner: {ok:true} veya {ok:false, reason, limit, current}
   */
  checkLoad(ip) {
    const e = this._entry(ip);
    const now = Date.now();

    const acik = this._acikOturum(e, now);
    if (this.maxPerIp > 0 && acik >= this.maxPerIp) {
      e.throttled += 1;
      e.lastThrottleAt = now;
      return { ok: false, reason: 'concurrent', limit: this.maxPerIp, current: acik };
    }

    const pencere = now - 60 * 1000;
    e.logins = e.logins.filter((t) => t > pencere);
    if (this.maxLoginsPerMinute > 0 && e.logins.length >= this.maxLoginsPerMinute) {
      e.throttled += 1;
      e.lastThrottleAt = now;
      return {
        ok: false, reason: 'rate', limit: this.maxLoginsPerMinute, current: e.logins.length,
      };
    }

    e.logins.push(now);
    e.lastAt = now;
    return { ok: true };
  }

  /** Suresi gecmis oturumlari atar ve gercekten acik olanlarin sayisini verir. */
  _acikOturum(e, now = Date.now()) {
    if (this.sessionTtlMs > 0) {
      const sinir = now - this.sessionTtlMs;
      e.sessions = e.sessions.filter((t) => t > sinir);
    }
    return e.sessions.length;
  }

  /** Basarili girisin ardindan oturumu kaydeder. */
  openSession(ip) {
    this._entry(ip).sessions.push(Date.now());
  }

  /** Oturum kapandiginda en eski kaydi duser. Ayni kapanis iki kez bildirilmemeli. */
  closeSession(ip) {
    const e = this.entries.get(ip);
    if (e && e.sessions.length) e.sessions.shift();
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
    const pencere = now - 60 * 1000;
    const rows = [];
    for (const [ip, e] of this.entries) {
      const acik = this._acikOturum(e, now);
      if (!e.failures && !e.bannedUntil && !e.throttled && !acik) continue;
      rows.push({
        ip,
        failures: e.failures,
        banned: e.bannedUntil > now,
        bannedUntil: e.bannedUntil > now ? new Date(e.bannedUntil).toISOString() : null,
        lastAt: e.lastAt ? new Date(e.lastAt).toISOString() : null,
        lastUser: e.lastUser,
        open: acik,
        loginsPerMinute: e.logins.filter((t) => t > pencere).length,
        throttled: e.throttled,
        lastThrottleAt: e.lastThrottleAt ? new Date(e.lastThrottleAt).toISOString() : null,
      });
    }
    return rows
      .sort((a, b) => (b.throttled - a.throttled) || (b.open - a.open) || (b.failures - a.failures))
      .slice(0, 50);
  }

  /** Uygulanan yuk sinirlari; panelde basliklarda gosterilir. */
  limits() {
    return {
      maxPerIp: this.maxPerIp,
      maxLoginsPerMinute: this.maxLoginsPerMinute,
      sessionTtlMinutes: Math.round(this.sessionTtlMs / 60000),
    };
  }

  /** Suresi dolmus kayitlari atar; bellek sinirsiz buyumesin. */
  sweep() {
    const cutoff = Date.now() - Math.max(this.banMs, 60 * 60 * 1000);
    for (const [ip, e] of this.entries) {
      if (e.bannedUntil > Date.now()) continue;
      // Acik oturumu olan IP'nin sayaci silinirse oturum sayimi bozulur.
      if (this._acikOturum(e) > 0) continue;
      if (e.lastAt < cutoff) this.entries.delete(ip);
    }
  }
}

module.exports = { LoginGuard };
