'use strict';

const { FtpSrv } = require('ftp-srv');
const { S3Client, HeadBucketCommand } = require('@aws-sdk/client-s3');

const config = require('./config');
const { S3FileSystem } = require('./s3fs');

const client = new S3Client({
  endpoint: config.s3.endpoint,
  region: config.s3.region,
  forcePathStyle: config.s3.forcePathStyle,
  credentials: {
    accessKeyId: config.s3.accessKeyId,
    secretAccessKey: config.s3.secretAccessKey,
  },
});

const ftpServer = new FtpSrv({
  url: `ftp://${config.ftp.host}:${config.ftp.port}`,
  pasv_url: config.ftp.pasvUrl,
  pasv_min: config.ftp.pasvMin,
  pasv_max: config.ftp.pasvMax,
  anonymous: config.ftp.anonymous,
  greeting: [`GCS FTP koprusu - bucket: ${config.s3.bucket}`],
  file_format: 'ls',
});

ftpServer.on('login', ({ connection, username, password }, resolve, reject) => {
  const ok =
    config.ftp.anonymous && (username === 'anonymous' || username === 'ftp')
      ? true
      : username === config.ftp.user && password === config.ftp.pass;

  if (!ok) {
    console.warn(`[ftp] reddedildi: ${username} (${connection.ip})`);
    return reject(new Error('Kullanici adi veya parola hatali'));
  }

  console.log(`[ftp] giris: ${username} (${connection.ip})`);

  connection.on('STOR', (err, filePath) => {
    if (err) console.error(`[ftp] yukleme hatasi ${filePath}:`, err.message);
    else console.log(`[ftp] yuklendi: ${filePath}`);
  });
  connection.on('RETR', (err, filePath) => {
    if (err) console.error(`[ftp] indirme hatasi ${filePath}:`, err.message);
    else console.log(`[ftp] indirildi: ${filePath}`);
  });

  return resolve({
    fs: new S3FileSystem(connection, {
      client,
      bucket: config.s3.bucket,
      prefix: config.s3.prefix,
    }),
    cwd: '/',
  });
});

ftpServer.on('client-error', ({ connection, context, error }) => {
  console.error(`[ftp] istemci hatasi (${context}) ${connection && connection.ip}:`, error.message);
});

async function main() {
  try {
    await client.send(new HeadBucketCommand({ Bucket: config.s3.bucket }));
    console.log(`[gcs] bucket erisimi dogrulandi: ${config.s3.bucket}`);
  } catch (err) {
    console.error(`[gcs] bucket'a erisilemedi (${config.s3.bucket}): ${err.message}`);
    console.error('  .env icindeki S3_ACCESS_KEY / S3_SECRET / S3_BUCKET degerlerini kontrol edin.');
    process.exit(1);
  }

  await ftpServer.listen();
  console.log(`[ftp] dinleniyor: ftp://${config.ftp.host}:${config.ftp.port}`);
  console.log(`[ftp] pasif mod: ${config.ftp.pasvUrl}:${config.ftp.pasvMin}-${config.ftp.pasvMax}`);
  if (config.ftp.anonymous) {
    console.log('[ftp] anonim giris acik');
  } else {
    console.log(`[ftp] kullanici: ${config.ftp.user}`);
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\n[ftp] kapatiliyor...');
    ftpServer.close().finally(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error('Baslatilamadi:', err);
  process.exit(1);
});
