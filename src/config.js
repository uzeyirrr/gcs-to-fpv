'use strict';

require('dotenv').config();

const { parseUsers } = require('./users');

function req(name) {
  const v = process.env[name];
  if (!v) throw new Error(`.env icinde ${name} tanimli degil`);
  return v;
}

function normalizePrefix(p) {
  if (!p) return '';
  return p.replace(/^\/+/, '').replace(/\/*$/, '/');
}

const config = {
  s3: {
    endpoint: req('S3_ENDPOINT'),
    region: process.env.S3_REGION || 'auto',
    bucket: req('S3_BUCKET'),
    accessKeyId: req('S3_ACCESS_KEY'),
    secretAccessKey: req('S3_SECRET'),
    forcePathStyle: (process.env.S3_FORCE_PATH_STYLE || 'true') !== 'false',
    prefix: normalizePrefix(process.env.S3_PREFIX),
  },
  ftp: {
    host: process.env.FTP_HOST || '127.0.0.1',
    port: parseInt(process.env.FTP_PORT || '2121', 10),
    // Pasif mod icin istemciye bildirilecek adres. Uzak sunucuda calistiriyorsaniz
    // buraya sunucunun disaridan erisilebilen IP'sini yazin.
    pasvUrl: process.env.FTP_PASV_URL || process.env.FTP_HOST || '127.0.0.1',
    pasvMin: parseInt(process.env.FTP_PASV_MIN || '50000', 10),
    pasvMax: parseInt(process.env.FTP_PASV_MAX || '50100', 10),
    anonymous: (process.env.FTP_ANONYMOUS || 'false') === 'true',
    user: process.env.FTP_USER || 'gcs',
    pass: process.env.FTP_PASS || 'gcs',
  },
  // Her kameraya ayri kullanici + kendi klasoru
  users: parseUsers(process.env.FTP_USERS, {
    fallbackUser: process.env.FTP_USER || 'gcs',
    fallbackPass: process.env.FTP_PASS || 'gcs',
  }),
  // Yuklemeleri kullanicinin kokunun altinda gun klasorune ayir
  autoDate: (process.env.AUTO_DATE_PATH || 'true') !== 'false',
  timezone: process.env.TIMEZONE || 'Europe/Istanbul',
  stats: {
    enabled: (process.env.STATS_ENABLED || 'true') !== 'false',
    port: parseInt(process.env.STATS_PORT || '8080', 10),
    user: process.env.STATS_USER || '',
    pass: process.env.STATS_PASS || '',
    staleAfterMinutes: parseInt(process.env.STATS_STALE_MINUTES || '30', 10),
  },
};

module.exports = config;
