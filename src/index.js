'use strict';

const { FtpSrv } = require('ftp-srv');
const { S3Client, HeadBucketCommand } = require('@aws-sdk/client-s3');

const config = require('./config');
const { S3FileSystem } = require('./s3fs');
const { Stats, startStatsServer, dateStamp } = require('./stats');

const client = new S3Client({
  endpoint: config.s3.endpoint,
  region: config.s3.region,
  forcePathStyle: config.s3.forcePathStyle,
  credentials: {
    accessKeyId: config.s3.accessKeyId,
    secretAccessKey: config.s3.secretAccessKey,
  },
});

const stats = new Stats({ timezone: config.timezone });
for (const u of config.users.values()) {
  stats.register(u.username, config.s3.prefix + u.dir);
}

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
  const account = config.users.get(username);

  if (!account || account.password !== password) {
    stats.failedLogin(username);
    console.warn(`[ftp] reddedildi: ${username} (${connection.ip})`);
    return reject(new Error('Kullanici adi veya parola hatali'));
  }

  stats.login(account.username, connection.ip);
  console.log(`[ftp] giris: ${account.username} (${connection.ip})`);

  let loggedOut = false;
  const markLogout = () => {
    if (loggedOut) return;
    loggedOut = true;
    stats.logout(account.username);
    console.log(`[ftp] cikis: ${account.username} (${connection.ip})`);
  };
  connection.once('close', markLogout);
  connection.once('disconnect', markLogout);

  connection.on('STOR', (err, filePath) => {
    if (err) {
      stats.error(account.username, `STOR ${filePath}: ${err.message}`);
      console.error(`[ftp][${account.username}] yukleme hatasi ${filePath}:`, err.message);
    } else {
      console.log(`[ftp][${account.username}] yuklendi: ${filePath}`);
    }
  });
  connection.on('RETR', (err, filePath) => {
    if (err) {
      stats.error(account.username, `RETR ${filePath}: ${err.message}`);
      console.error(`[ftp][${account.username}] indirme hatasi ${filePath}:`, err.message);
    } else {
      console.log(`[ftp][${account.username}] indirildi: ${filePath}`);
    }
  });

  return resolve({
    fs: new S3FileSystem(connection, {
      client,
      bucket: config.s3.bucket,
      // Kullanici yalnizca kendi klasorunu gorur
      prefix: config.s3.prefix + account.dir,
      autoDate: config.autoDate,
      timezone: config.timezone,
      stats,
      username: account.username,
    }),
    cwd: '/',
  });
});

ftpServer.on('client-error', ({ connection, context, error }) => {
  console.error(
    `[ftp] istemci hatasi (${context}) ${connection && connection.ip}:`,
    error.message
  );
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
  console.log(
    `[ftp] gun klasoru: ${config.autoDate ? 'acik' : 'kapali'} (${config.timezone}, bugun ${dateStamp(config.timezone)})`
  );
  console.log(`[ftp] tanimli kamera sayisi: ${config.users.size}`);
  for (const u of config.users.values()) {
    const base = config.s3.prefix + u.dir;
    const shown = config.autoDate ? `${base}${dateStamp(config.timezone)}/` : base || '(kok)';
    console.log(`  - ${u.username} -> ${config.s3.bucket}/${shown}`);
  }

  if (config.stats.enabled) {
    await startStatsServer(stats, config.stats);
    const auth = config.stats.user && config.stats.pass ? 'parola korumali' : 'PAROLASIZ';
    console.log(`[stats] izleme paneli: http://0.0.0.0:${config.stats.port}/ (${auth})`);
    if (!config.stats.user || !config.stats.pass) {
      console.warn('[stats] STATS_USER/STATS_PASS tanimli degil - panel herkese acik.');
    }
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
