'use strict';

const path = require('path').posix;
const {
  ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand,
} = require('@aws-sdk/client-s3');
const { dateStamp } = require('./stats');

const IMAGE_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

const VIDEO_TYPES = {
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
};

function contentTypeFor(key) {
  const ext = path.extname(key).toLowerCase();
  return IMAGE_TYPES[ext] || VIDEO_TYPES[ext] || 'application/octet-stream';
}

function kindOf(key) {
  const ext = path.extname(key).toLowerCase();
  if (IMAGE_TYPES[ext]) return 'resim';
  if (VIDEO_TYPES[ext]) return 'video';
  return 'diger';
}

/** Bir kameranin gun klasorlerini (yeniden eskiye) listeler. */
async function listDays(client, bucket, cameraPrefix) {
  const days = [];
  let token;
  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: cameraPrefix,
      Delimiter: '/',
      ContinuationToken: token,
    }));
    for (const cp of res.CommonPrefixes || []) {
      const name = cp.Prefix.slice(cameraPrefix.length).replace(/\/$/, '');
      if (name) days.push(name);
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);

  return days.sort().reverse();
}

/** Bir tarihi verilen saat diliminde "HH:mm" olarak dondurur. */
function timeStamp(timezone, when) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(when);
  } catch (err) {
    return when.toISOString().slice(11, 16);
  }
}

/** Bir tarihi verilen saat diliminde "HH" olarak dondurur. */
function hourStamp(timezone, when) {
  return timeStamp(timezone, when).slice(0, 2);
}

/**
 * Gun klasorundeki tum gosterilebilir dosyalar. Kamera saat gibi alt klasorler
 * acmis olabilecegi icin ozyinelemeli listelenir. Saat filtresinin dogru calismasi
 * icin gunun tamami taranir; `max` ile ust sinir konur.
 */
async function listDayFiles(client, bucket, dayPrefix, { timezone = 'UTC', max = 5000 } = {}) {
  const files = [];
  let token;
  let truncated = false;

  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: dayPrefix,
      ContinuationToken: token,
    }));

    for (const o of res.Contents || []) {
      if (o.Key.endsWith('/')) continue;
      const kind = kindOf(o.Key);
      if (kind === 'diger') continue;
      const mtime = o.LastModified || new Date(0);
      files.push({
        key: o.Key,
        name: o.Key.slice(dayPrefix.length),
        size: Number(o.Size || 0),
        mtime,
        time: timeStamp(timezone, mtime),
        hour: hourStamp(timezone, mtime),
        kind,
      });
      if (files.length >= max) {
        truncated = true;
        break;
      }
    }

    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token && !truncated);

  files.sort((a, b) => b.mtime - a.mtime);

  // Saat filtresi secenekleri: sadece dosyasi olan saatler
  const hours = new Map();
  for (const f of files) hours.set(f.hour, (hours.get(f.hour) || 0) + 1);

  return {
    files,
    truncated,
    hours: [...hours.entries()].sort((a, b) => b[0].localeCompare(a[0])),
  };
}

/**
 * Bir nesneyi istemciye aktarir. Anahtarin izinli kamera klasorlerinden birinin
 * altinda oldugu MUTLAKA dogrulanmali (users.json gibi dosyalar okunamasin).
 */
async function streamObject(client, bucket, key, req, res) {
  try {
    const range = req.headers.range;
    const obj = await client.send(new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      Range: range || undefined,
    }));

    const headers = {
      'content-type': contentTypeFor(key),
      'cache-control': 'private, max-age=86400',
    };
    if (obj.ContentLength != null) headers['content-length'] = String(obj.ContentLength);
    if (obj.ContentRange) headers['content-range'] = obj.ContentRange;
    headers['accept-ranges'] = 'bytes';

    res.writeHead(obj.ContentRange ? 206 : 200, headers);
    obj.Body.pipe(res);
    obj.Body.on('error', () => res.destroy());
  } catch (err) {
    const status = err.$metadata && err.$metadata.httpStatusCode;
    res.writeHead(status === 404 ? 404 : 500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(status === 404 ? 'Dosya bulunamadi' : 'Dosya okunamadi');
  }
}

/**
 * Verilen anahtarlari siler. GCS'in S3 uyumlulugu toplu silme (POST ?delete)
 * desteklemedigi icin nesneler tek tek, sinirli eszamanlilikla silinir.
 * Dondurulen `failed` listesi silinemeyen anahtarlari tasir.
 */
async function deleteObjects(client, bucket, keys, { concurrency = 8 } = {}) {
  const kalan = [...keys];
  const deleted = [];
  const failed = [];

  const worker = async () => {
    for (;;) {
      const key = kalan.shift();
      if (key === undefined) return;
      // Sayaclarin dusulebilmesi icin boyut silmeden once okunur; okunamazsa
      // silme yine de yapilir, yalnizca boyut 0 sayilir.
      let size = 0;
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        size = Number(head.ContentLength || 0);
      } catch (err) {
        size = 0;
      }
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        deleted.push({ key, size });
      } catch (err) {
        failed.push({ key, error: err.message });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, kalan.length) }, worker)
  );

  return { deleted, failed };
}

module.exports = {
  listDays, listDayFiles, streamObject, deleteObjects, contentTypeFor, kindOf,
  hourStamp, timeStamp,
};
