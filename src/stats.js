'use strict';

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
    deletesTotal: 0,
    deletedBytesTotal: 0,
    lastDeleteAt: null,
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

  forget(username) {
    this.cameras.delete(username);
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

  /**
   * Panelden silinen dosyalari sayaclara isler. Silinenler hem ayri bir sayacta
   * tutulur hem de yukleme toplamlarindan dusulur; boylece panelde gorunen
   * rakamlar bucket'ta duran dosyalari yansitir. Dosya bugunun klasorunden
   * silindiyse gunluk sayaclar da dusulur. Sunucu yeniden basladiginda sayaclar
   * zaten sifirlandigi icin negatife dusmemesi adina taban 0'da tutulur.
   */
  deleted(username, { count = 0, bytes = 0, day = null } = {}) {
    if (!count) return;
    const c = this._get(username);
    c.deletesTotal += count;
    c.deletedBytesTotal += bytes;
    c.lastDeleteAt = new Date().toISOString();

    c.uploadsTotal = Math.max(0, c.uploadsTotal - count);
    c.bytesTotal = Math.max(0, c.bytesTotal - bytes);

    if (day && day === dateStamp(this.timezone)) {
      c.uploadsToday = Math.max(0, c.uploadsToday - count);
      c.bytesToday = Math.max(0, c.bytesToday - bytes);
    }
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

module.exports = { Stats, dateStamp };
