'use strict';

const path = require('path').posix;
const crypto = require('crypto');
const { Writable, PassThrough } = require('stream');
const { FileSystem } = require('ftp-srv');
const {
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
} = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { dateStamp } = require('./stats');

const DIR_MODE = 0o40755;
const FILE_MODE = 0o100644;

function enoent(p) {
  const err = new Error(`No such file or directory: ${p}`);
  err.code = 'ENOENT';
  return err;
}

function statLike({ name, size = 0, mtime = new Date(), isDir = false }) {
  return {
    name,
    size,
    mtime,
    atime: mtime,
    ctime: mtime,
    birthtime: mtime,
    mode: isDir ? DIR_MODE : FILE_MODE,
    nlink: 1,
    uid: 0,
    gid: 0,
    dev: 0,
    ino: 0,
    rdev: 0,
    blksize: 4096,
    blocks: Math.ceil(size / 512),
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

/**
 * S3 (GCS interoperability) destekli ftp-srv dosya sistemi.
 * Bucket icindeki "/" ile biten anahtarlar klasor olarak yorumlanir.
 */
class S3FileSystem extends FileSystem {
  constructor(connection, {
    client,
    bucket,
    prefix = '',
    autoDate = false,
    timezone = 'UTC',
    stats = null,
    username = '',
  }) {
    super(connection, { root: '/', cwd: '/' });
    this.client = client;
    this.bucket = bucket;
    // prefix = global S3_PREFIX + kullanicinin kendi klasoru; kullanici bunun disina cikamaz
    this.prefix = prefix;
    this.autoDate = autoDate;
    this.timezone = timezone;
    this.stats = stats;
    this.username = username;
    this.cwd = '/';
  }

  currentDirectory() {
    return this.cwd;
  }

  /** FTP yolunu mutlak sanal yola cevirir ("/a/b"). */
  _resolve(p) {
    const target = !p || p === '.' ? this.cwd : p;
    const abs = target.startsWith('/') ? target : path.join(this.cwd, target);
    let normalized = path.normalize(abs);
    if (!normalized.startsWith('/')) normalized = '/' + normalized;
    if (normalized.length > 1) normalized = normalized.replace(/\/+$/, '');
    return normalized;
  }

  /** Sanal yolu bucket anahtarina cevirir (bastaki "/" atilir, prefix eklenir). */
  _key(virtualPath) {
    return this.prefix + virtualPath.replace(/^\/+/, '');
  }

  /**
   * Yukleme anahtari: AUTO_DATE_PATH acikken kullanicinin kokunun hemen altina
   * gunun tarihi eklenir. "/x.jpg" -> "<kullanici>/2026-08-25/x.jpg"
   */
  _uploadKey(virtualPath) {
    if (!this.autoDate) return this._key(virtualPath);
    const rel = virtualPath.replace(/^\/+/, '');
    return this.prefix + dateStamp(this.timezone) + '/' + rel;
  }

  /** Klasor listelemesi icin kullanilacak anahtar oneki. */
  _dirPrefix(virtualPath) {
    if (virtualPath === '/') return this.prefix;
    return this._key(virtualPath) + '/';
  }

  async _headObject(key) {
    try {
      return await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key })
      );
    } catch (err) {
      const status = err.$metadata && err.$metadata.httpStatusCode;
      if (status === 404 || err.name === 'NotFound' || err.name === 'NoSuchKey') {
        return null;
      }
      throw err;
    }
  }

  async _hasChildren(prefix) {
    const res = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        MaxKeys: 1,
      })
    );
    return (res.KeyCount || 0) > 0;
  }

  async get(fileName) {
    const virtualPath = this._resolve(fileName);
    const name = virtualPath === '/' ? '/' : path.basename(virtualPath);

    if (virtualPath === '/') {
      return statLike({ name, isDir: true });
    }

    const key = this._key(virtualPath);

    const head = await this._headObject(key);
    if (head) {
      return statLike({
        name,
        size: Number(head.ContentLength || 0),
        mtime: head.LastModified || new Date(),
        isDir: false,
      });
    }

    // Acik klasor isaretcisi ("key/") ya da altinda nesne bulunan ortuk klasor
    if (await this._hasChildren(key + '/')) {
      return statLike({ name, isDir: true });
    }

    // AUTO_DATE_PATH acikken kamera dosyayi yazdigi yolda arar; gercek nesne
    // tarih klasorunun altindadir. SIZE/MDTM sorgulari bosa dusmesin diye
    // ayni yolu bir de tarihli haliyle deniyoruz.
    if (this.autoDate) {
      const datedHead = await this._headObject(this._uploadKey(virtualPath));
      if (datedHead) {
        return statLike({
          name,
          size: Number(datedHead.ContentLength || 0),
          mtime: datedHead.LastModified || new Date(),
          isDir: false,
        });
      }
    }

    throw enoent(virtualPath);
  }

  async list(dirPath = '.') {
    const virtualPath = this._resolve(dirPath);
    const prefix = this._dirPrefix(virtualPath);
    const results = [];
    let token;

    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          Delimiter: '/',
          ContinuationToken: token,
        })
      );

      for (const cp of res.CommonPrefixes || []) {
        const name = cp.Prefix.slice(prefix.length).replace(/\/$/, '');
        if (name) results.push(statLike({ name, isDir: true }));
      }

      for (const obj of res.Contents || []) {
        const name = obj.Key.slice(prefix.length);
        // Klasorun kendi isaretcisi ("dir/") listede gorunmesin
        if (!name || name.endsWith('/')) continue;
        results.push(
          statLike({
            name,
            size: Number(obj.Size || 0),
            mtime: obj.LastModified || new Date(),
            isDir: false,
          })
        );
      }

      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);

    results.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return results;
  }

  async chdir(dirPath = '.') {
    const virtualPath = this._resolve(dirPath);
    if (virtualPath !== '/') {
      const stat = await this.get(virtualPath);
      if (!stat.isDirectory()) {
        const err = new Error(`Not a directory: ${virtualPath}`);
        err.code = 'ENOTDIR';
        throw err;
      }
    }
    this.cwd = virtualPath;
    return this.cwd;
  }

  async read(fileName, { start = 0 } = {}) {
    const virtualPath = this._resolve(fileName);
    const key = this._key(virtualPath);

    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Range: start ? `bytes=${start}-` : undefined,
      })
    );

    return { stream: res.Body, clientPath: virtualPath };
  }

  async write(fileName, { append = false, start } = {}) {
    if (append || start) {
      // Nesne depolamada kismi yazma / devam ettirme yok.
      const err = new Error('Append/resume desteklenmiyor (nesne depolama)');
      err.code = 'EOPNOTSUPP';
      throw err;
    }

    const virtualPath = this._resolve(fileName);
    const key = this._uploadKey(virtualPath);
    const body = new PassThrough();
    const stats = this.stats;
    const username = this.username;
    let bytes = 0;

    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: key, Body: body },
      queueSize: 4,
      partSize: 8 * 1024 * 1024,
    });

    const uploadPromise = upload.done();
    // Hata _final icinde tekrar beklenecek; burada unhandled rejection olmasin.
    uploadPromise.catch(() => {});

    // 226 yanitini GCS'e yazma gercekten bitmeden gondermemek icin
    // 'finish' olayini upload tamamlanana kadar geciktiriyoruz.
    const stream = new Writable({
      write(chunk, encoding, callback) {
        bytes += chunk.length;
        if (!body.write(chunk, encoding)) {
          body.once('drain', callback);
        } else {
          callback();
        }
      },
      final(callback) {
        body.end();
        uploadPromise.then(
          () => {
            if (stats) stats.upload(username, key, bytes);
            callback();
          },
          (err) => {
            if (stats) stats.error(username, `Yukleme hatasi (${key}): ${err.message}`);
            callback(err);
          }
        );
      },
      destroy(err, callback) {
        if (err) body.destroy(err);
        callback(err);
      },
    });

    return { stream, clientPath: virtualPath };
  }

  async delete(filePath) {
    const virtualPath = this._resolve(filePath);
    const key = this._key(virtualPath);
    const stat = await this.get(virtualPath);

    if (stat.isDirectory()) {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: key + '/',
          MaxKeys: 2,
        })
      );
      const children = (res.Contents || []).filter((o) => o.Key !== key + '/');
      if (children.length > 0) {
        const err = new Error(`Directory not empty: ${virtualPath}`);
        err.code = 'ENOTEMPTY';
        throw err;
      }
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key + '/' })
      );
      return;
    }

    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key })
    );
  }

  async mkdir(dirPath) {
    const virtualPath = this._resolve(dirPath);
    const key = this._key(virtualPath) + '/';
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: '' })
    );
    return virtualPath;
  }

  async rename(from, to) {
    const fromPath = this._resolve(from);
    const toPath = this._resolve(to);
    const stat = await this.get(fromPath);

    if (stat.isDirectory()) {
      await this._renameDirectory(fromPath, toPath);
      return toPath;
    }

    const fromKey = this._key(fromPath);
    await this._copyObject(fromKey, this._key(toPath));
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: fromKey })
    );
    return toPath;
  }

  async _renameDirectory(fromPath, toPath) {
    const fromPrefix = this._key(fromPath) + '/';
    const toPrefix = this._key(toPath) + '/';
    let token;

    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: fromPrefix,
          ContinuationToken: token,
        })
      );

      for (const obj of res.Contents || []) {
        const destKey = toPrefix + obj.Key.slice(fromPrefix.length);
        await this._copyObject(obj.Key, destKey);
        await this.client.send(
          new DeleteObjectCommand({ Bucket: this.bucket, Key: obj.Key })
        );
      }

      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
  }

  async _copyObject(sourceKey, destKey) {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: destKey,
        CopySource: `/${this.bucket}/${sourceKey}`,
      })
    );
  }

  // Nesne depolamada izin kavrami yok; istemciler yine de SITE CHMOD gonderebiliyor.
  async chmod() {
    return true;
  }

  getUniqueName() {
    return crypto.randomBytes(16).toString('hex');
  }
}

module.exports = { S3FileSystem };
