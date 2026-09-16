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

/**
 * ftp-srv'nin pasif veri sunucusu yalnizca iki durumda kapanir: 30 sn icinde
 * kimse baglanmazsa, ya da baglanan veri soketi 'close' yayarsa. Karsi taraf
 * CGNAT kaymasiyla kaybolursa soket ne FIN ne RST alir; veri soketinde zaman
 * asimi ve keepalive olmadigi icin 'close' hic gelmez ve port sonsuza kadar
 * dinlemede kalir. Her kayma bir port goturur; havuz birkac gunde biter.
 *
 * Bu kanca her veri soketine bosta zaman asimi ve keepalive ekler (olu soket
 * yikilinca ftp-srv sunucuyu kendisi kapatir), dinleyiciye de mutlak bir omur
 * siniri koyar. Ayrica kontrol soketinin bosta sayacini yalnizca veri gercekten
 * akarken tazeler; olu bir veri soketi kontrol baglantisini olumsuz yapmasin.
 */
function veriKancasi(ftpServer, pool, {
  veriBostaSn = 120,
  dinleyiciOmruSn = 30 * 60,
  kontrolBostaSn = 0,
} = {}) {
  const Passive = require('ftp-srv/src/connector/passive');
  if (!Passive.prototype._gcsKancali) {
    const asil = Passive.prototype.setupServer;
    Passive.prototype.setupServer = function setupServer(...args) {
      return asil.apply(this, args).then((server) => {
        const kayit = pool._dinleyiciEkle(server);
        server.on('connection', (sock) => {
          sock.setKeepAlive(true, 30 * 1000);
          sock.setTimeout(veriBostaSn * 1000, () => {
            pool.olubVeri += 1;
            sock.destroy();
          });
        });
        const omur = setTimeout(() => {
          if (server.listening) {
            pool.zorlaKapatilan += 1;
            server.close();
          }
        }, dinleyiciOmruSn * 1000);
        if (omur.unref) omur.unref();
        server.once('close', () => {
          clearTimeout(omur);
          pool._dinleyiciSil(kayit);
        });
        return server;
      });
    };
    Passive.prototype._gcsKancali = true;
  }

  if (kontrolBostaSn > 0) {
    const sonBayt = new WeakMap();
    const tazele = setInterval(() => {
      for (const c of Object.values(ftpServer.connections || {})) {
        const veri = c && c.connector && c.connector.dataSocket;
        if (!veri || veri.destroyed || !c.commandSocket || c.commandSocket.destroyed) continue;
        const simdi = veri.bytesRead + veri.bytesWritten;
        if (simdi !== sonBayt.get(veri)) {
          sonBayt.set(veri, simdi);
          c.commandSocket.setTimeout(kontrolBostaSn * 1000);
        }
      }
    }, Math.max(2, Math.floor(kontrolBostaSn / 3)) * 1000);
    if (tazele.unref) tazele.unref();
  }
}

PasvPool.prototype._dinleyiciEkle = function _dinleyiciEkle(server) {
  if (!this.dinleyiciler) this.dinleyiciler = new Map();
  const kayit = {};
  this.dinleyiciler.set(kayit, { server, acilis: Date.now() });
  return kayit;
};

PasvPool.prototype._dinleyiciSil = function _dinleyiciSil(kayit) {
  if (this.dinleyiciler) this.dinleyiciler.delete(kayit);
};

PasvPool.prototype.olubVeri = 0;
PasvPool.prototype.zorlaKapatilan = 0;

const eskiSnapshot = PasvPool.prototype.snapshot;
PasvPool.prototype.snapshot = function snapshot() {
  const s = eskiSnapshot.call(this);
  let enEski = 0;
  let acik = 0;
  for (const { server, acilis } of (this.dinleyiciler || new Map()).values()) {
    if (!server.listening) continue;
    acik += 1;
    if (!enEski || acilis < enEski) enEski = acilis;
  }
  s.openListeners = acik;
  s.oldestListenerSec = enEski ? Math.round((Date.now() - enEski) / 1000) : 0;
  s.deadDataSockets = this.olubVeri;
  s.forceClosed = this.zorlaKapatilan;
  return s;
};

module.exports = { PasvPool, veriKancasi };
