'use strict';

const crypto = require('crypto');
const {
  GetObjectCommand,
  PutObjectCommand,
} = require('@aws-sdk/client-s3');

/**
 * Kamera (FTP kullanicisi) kayitlari. Bucket icinde tek bir JSON nesnesinde tutulur,
 * boylece Dokploy'da yeniden deploy edilse de kayitlar kalir ve panelden yapilan
 * degisiklikler aninda gecerli olur.
 *
 * FTP parolalari duz metin saklanir: FTP protokolu parolayi zaten sifresiz tasiyor
 * ve kamera kurulumunda parolanin tekrar okunabilmesi gerekiyor. Bucket'a erisebilen
 * zaten tum kamera dosyalarina erisebiliyor.
 */
const CONFIG_SUFFIX = '_system/users.json';

function slugify(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[ğ]/g, 'g').replace(/[ü]/g, 'u').replace(/[ş]/g, 's')
    .replace(/[ı]/g, 'i').replace(/[ö]/g, 'o').replace(/[ç]/g, 'c')
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function generatePassword(length = 12) {
  // Kamera arayuzleri ozel karakterlerde sorun cikardigi icin sadece harf+rakam
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = crypto.randomBytes(length * 2);
  for (let i = 0; out.length < length; i++) {
    out += alphabet[bytes[i % bytes.length] % alphabet.length];
  }
  return out;
}

class UserStore {
  constructor({ client, bucket, prefix = '', key }) {
    this.client = client;
    this.bucket = bucket;
    // S3_PREFIX'e saygi duy: ayni bucket'i farkli prefix'lerle kullanan kurulumlar
    // birbirinin kullanici kayitlarinin uzerine yazmasin.
    this.key = key || prefix + CONFIG_SUFFIX;
    this.users = new Map();
  }

  async _read() {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.key })
      );
      const text = await res.Body.transformToString();
      const parsed = JSON.parse(text);
      return Array.isArray(parsed.users) ? parsed.users : [];
    } catch (err) {
      const status = err.$metadata && err.$metadata.httpStatusCode;
      if (status === 404 || err.name === 'NoSuchKey' || err.name === 'NotFound') return null;
      throw err;
    }
  }

  async _write() {
    const body = JSON.stringify(
      { updatedAt: new Date().toISOString(), users: [...this.users.values()] },
      null,
      2
    );
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key,
        Body: body,
        ContentType: 'application/json',
      })
    );
  }

  /** Kayitli kullanicilari yukler; hic yoksa .env'deki tanimlarla tohumlar. */
  async load(seedUsers) {
    const stored = await this._read();

    if (stored) {
      this.users = new Map(stored.map((u) => [u.username, u]));
      return { seeded: false, count: this.users.size };
    }

    this.users = new Map(
      [...seedUsers.values()].map((u) => [
        u.username,
        {
          username: u.username,
          password: u.password,
          dir: u.dir,
          label: u.username,
          enabled: true,
          createdAt: new Date().toISOString(),
        },
      ])
    );
    await this._write();
    return { seeded: true, count: this.users.size };
  }

  list() {
    return [...this.users.values()].sort((a, b) => a.username.localeCompare(b.username));
  }

  get(username) {
    return this.users.get(username);
  }

  /** Girisi dogrular; devre disi birakilmis hesaplar reddedilir. */
  verify(username, password) {
    const u = this.users.get(username);
    if (!u || u.enabled === false) return null;
    // Sabit sureli karsilastirma
    const a = Buffer.from(String(u.password));
    const b = Buffer.from(String(password));
    if (a.length !== b.length) return null;
    return crypto.timingSafeEqual(a, b) ? u : null;
  }

  async add({ username, password, label }) {
    const name = slugify(username);
    if (!name) throw new Error('Gecerli bir kamera adi girin');
    if (name.length > 40) throw new Error('Kamera adi en fazla 40 karakter olabilir');
    if (this.users.has(name)) throw new Error(`"${name}" adinda bir kamera zaten var`);

    const pass = (password || '').trim() || generatePassword();
    if (!/^[A-Za-z0-9]{6,}$/.test(pass)) {
      throw new Error('Parola en az 6 karakter, sadece harf ve rakam olmali');
    }

    const user = {
      username: name,
      password: pass,
      dir: name + '/',
      label: (label || '').trim() || name,
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    this.users.set(name, user);
    await this._write();
    return user;
  }

  async remove(username) {
    if (!this.users.has(username)) throw new Error('Kamera bulunamadi');
    if (this.users.size === 1) throw new Error('Son kamerayi silemezsiniz');
    this.users.delete(username);
    await this._write();
  }

  async setPassword(username, password) {
    const u = this.users.get(username);
    if (!u) throw new Error('Kamera bulunamadi');
    const pass = (password || '').trim() || generatePassword();
    if (!/^[A-Za-z0-9]{6,}$/.test(pass)) {
      throw new Error('Parola en az 6 karakter, sadece harf ve rakam olmali');
    }
    u.password = pass;
    await this._write();
    return pass;
  }

  async setEnabled(username, enabled) {
    const u = this.users.get(username);
    if (!u) throw new Error('Kamera bulunamadi');
    u.enabled = Boolean(enabled);
    await this._write();
    return u;
  }
}

module.exports = { UserStore, generatePassword, slugify, CONFIG_SUFFIX };
