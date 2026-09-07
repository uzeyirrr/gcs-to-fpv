'use strict';

const net = require('net');

/**
 * Pasif mod veri portu havuzu.
 *
 * ftp-srv'nin kendi port bulucusu (helpers/find-port.js) aralikta yalnizca 5
 * port dener ve pes eder; aralikta bos port varken bile "Unable to find valid
 * port" hatasi verebilir. Ayrica acilan her veri sunucusu, kamera baglanmazsa
 * 30 sn boyunca portu tutar (connector/passive.js CONNECT_TIMEOUT); hizli
 * yeniden baglanan tek bir kamera 100 portluk araligi tamamen yiyebilir ve
 * diger kameralari da disarida birakir.
 *
 * Bu modul araligin tamamini sirayla dener ve sonucu panelde gosterilebilecek
 * sayaclarla birlikte tutar.
 */
class PasvPool {
  constructor({ host = '0.0.0.0', min, max } = {}) {
    this.host = host;
    this.min = min;
    this.max = Math.max(min, max);
    this.size = this.max - this.min + 1;
    this.imlec = this.min;
    this.verilen = 0;
    this.tukendi = 0;
    this.sonTukenme = 0;
    this.sonPort = 0;
    // Son aramada kac portun dolu bulundugu; havuzun ne kadar sikisik oldugunu
    // panelde gostermek icin tutulur.
    this.sonDolu = 0;
  }

  _ilerle() {
    const port = this.imlec;
    this.imlec = port >= this.max ? this.min : port + 1;
    return port;
  }

  /**
   * Portu gercekten baglayarak bos olup olmadigini dener. Bind edilemeyen her
   * durum (EADDRINUSE dahil) dolu sayilir; asil veri sunucusu birazdan ayni
   * portu bagladigi icin buradaki dinleyici hemen kapatilir.
   */
  _bosMu(port) {
    return new Promise((resolve) => {
      const deneme = net.createServer();
      deneme.maxConnections = 0;
      deneme.once('error', () => resolve(false));
      deneme.once('listening', () => deneme.close(() => resolve(true)));
      try {
        deneme.listen(port, this.host);
      } catch (err) {
        resolve(false);
      }
    });
  }

  /** ftp-srv'nin bekledigi sozlesme: bos bir port numarasina cozulen soz. */
  async al() {
    let dolu = 0;
    for (let i = 0; i < this.size; i += 1) {
      const port = this._ilerle();
      // eslint-disable-next-line no-await-in-loop
      if (await this._bosMu(port)) {
        this.verilen += 1;
        this.sonPort = port;
        this.sonDolu = dolu;
        return port;
      }
      dolu += 1;
    }

    this.tukendi += 1;
    this.sonTukenme = Date.now();
    this.sonDolu = dolu;
    const err = new Error(
      `Pasif mod portu bulunamadi: ${this.min}-${this.max} araliginin tamami dolu`
    );
    err.code = 'PASV_POOL_EMPTY';
    throw err;
  }

  /** Panelde gostermek icin havuz durumu. */
  snapshot() {
    return {
      min: this.min,
      max: this.max,
      size: this.size,
      granted: this.verilen,
      exhausted: this.tukendi,
      lastExhaustedAt: this.sonTukenme ? new Date(this.sonTukenme).toISOString() : null,
      lastPort: this.sonPort || null,
      lastBusy: this.sonDolu,
    };
  }
}

module.exports = { PasvPool };
