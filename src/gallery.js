'use strict';

const path = require('path').posix;
const { ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');

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

/**
 * Gun klasorundeki dosyalar. Kamera saat gibi alt klasorler acmis olabilecegi icin
 * ozyinelemeli listelenir. Sayfa basina `limit` dosya dondurur.
 */
async function listFiles(client, bucket, dayPrefix, { limit = 120, token } = {}) {
  const files = [];
  let next = token;
  let truncated = false;

  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: dayPrefix,
      ContinuationToken: next,
      MaxKeys: Math.min(1000, limit * 2),
    }));

    for (const o of res.Contents || []) {
      if (o.Key.endsWith('/')) continue;
      const kind = kindOf(o.Key);
      if (kind === 'diger') continue;
      files.push({
        key: o.Key,
        name: o.Key.slice(dayPrefix.length),
        size: Number(o.Size || 0),
        mtime: o.LastModified,
        kind,
      });
      if (files.length >= limit) {
        truncated = true;
        break;
      }
    }

    next = res.IsTruncated ? res.NextContinuationToken : undefined;
    if (files.length >= limit) break;
  } while (next);

  files.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  return { files, nextToken: files.length >= limit ? next : undefined, truncated };
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

module.exports = { listDays, listFiles, streamObject, contentTypeFor, kindOf };
