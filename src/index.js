'use strict';

const { FtpSrv } = require('ftp-srv');
const { S3Client, HeadBucketCommand } = require('@aws-sdk/client-s3');

const config = require('./config');
const { S3FileSystem } = require('./s3fs');
const { Stats, dateStamp } = require('./stats');
const { UserStore } = require('./store');
const { startPanel } = require('./panel');
const { LoginGuard } = require('./guard');

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
const store = new UserStore({ client, bucket: config.s3.bucket, prefix: config.s3.prefix });
const guard = new LoginGuard(config.guard);

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
  const ip = connection.ip;

  // Kameralar sabit IP'den gelmedigi icin port herkese acik; kaba kuvvet denemeleri
  // ayni IP'den ust uste basarisiz girisle engellenir.
  if (guard.isBanned(ip)) {
    stats.failedLogin(username);
    console.warn(`[ftp] engelli IP reddedildi: ${ip} (${username})`);
    return reject(new Error('Cok fazla basarisiz deneme, gecici olarak engellendiniz'));
  }

  const account = store.verify(username, password);

  if (!account) {
    stats.failedLogin(username);
    const yeniEngel = guard.fail(ip, username);
    console.warn(
      `[ftp] reddedildi: ${username} (${ip})` +
      (yeniEngel ? ` -> ${config.guard.banMinutes} dk engellendi` : '')
    );
    return reject(new Error('Kullanici adi veya parola hatali'));
  }

  guard.succeed(ip);
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

  const loaded = await store.load(config.users);
  console.log(
    `[kamera] ${loaded.count} kayit ${loaded.seeded ? 'env ayarindan olusturuldu' : "bucket'tan yuklendi"}`
  );
  for (const u of store.list()) stats.register(u.username, config.s3.prefix + u.dir);

  await ftpServer.listen();
  console.log(`[ftp] dinleniyor: ftp://${config.ftp.host}:${config.ftp.port}`);
  console.log(`[ftp] pasif mod: ${config.ftp.pasvUrl}:${config.ftp.pasvMin}-${config.ftp.pasvMax}`);
  console.log(
    `[ftp] gun klasoru: ${config.autoDate ? 'acik' : 'kapali'} (${config.timezone}, bugun ${dateStamp(config.timezone)})`
  );
  console.log(
    `[ftp] kaba kuvvet korumasi: ${config.guard.maxFailures} basarisiz deneme -> ` +
    `${config.guard.banMinutes} dk engel`
  );
  console.log(`[ftp] tanimli kamera sayisi: ${store.list().length}`);
  for (const u of store.list()) {
    const base = config.s3.prefix + u.dir;
    const shown = config.autoDate ? `${base}${dateStamp(config.timezone)}/` : base || '(kok)';
    const durum = u.enabled === false ? ' [kapali]' : '';
    console.log(`  - ${u.username} -> ${config.s3.bucket}/${shown}${durum}`);
  }

  if (config.stats.enabled) {
    await startPanel({
      stats,
      store,
      config,
      guard,
      s3: { client, bucket: config.s3.bucket },
    });
    const auth = config.stats.user && config.stats.pass ? 'parola korumali' : 'PAROLASIZ';
    console.log(`[panel] yonetim paneli: http://0.0.0.0:${config.stats.port}/ (${auth})`);
    if (!config.stats.user || !config.stats.pass) {
      console.warn('[panel] STATS_USER/STATS_PASS tanimli degil - panel herkese acik.');
    }
  }
}

// Engel kayitlari bellekte sinirsiz birikmesin
setInterval(() => guard.sweep(), 10 * 60 * 1000).unref();

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
