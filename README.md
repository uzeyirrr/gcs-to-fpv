# GCS → FTP köprüsü

Google Cloud Storage bucket'ınızı, S3 uyumlu (HMAC / interoperability) anahtarlar üzerinden
**gerçek bir FTP sunucusu** olarak yayınlar. FileZilla, WinSCP, Windows Explorer, `ftp` komutu
veya herhangi bir FTP istemcisi doğrudan bağlanabilir.

## Kurulum

```bash
npm install
npm start
```

## Yapılandırma (`.env`)

| Değişken | Açıklama |
|---|---|
| `S3_ENDPOINT` | `https://storage.googleapis.com` |
| `S3_BUCKET` | Yayınlanacak bucket |
| `S3_REGION` | Bucket bölgesi (ör. `europe-west3`) |
| `S3_ACCESS_KEY` / `S3_SECRET` | GCS HMAC anahtarı (`GOOG...` ile başlar) |
| `S3_FORCE_PATH_STYLE` | `true` bırakın |
| `S3_PREFIX` | *(opsiyonel)* FTP kökünü bucket içindeki bir klasöre sabitler |
| `FTP_HOST` | Dinlenecek arayüz (`0.0.0.0` = tümü) |
| `FTP_PORT` | Varsayılan `2121` (21 için yönetici hakkı gerekir) |
| `FTP_PASV_URL` | **Pasif mod için istemciye bildirilen IP.** Uzak sunucuda çalıştırıyorsanız sunucunun dış IP'sini yazın |
| `FTP_PASV_MIN` / `FTP_PASV_MAX` | Pasif veri portu aralığı — güvenlik duvarında açık olmalı |
| `FTP_USER` / `FTP_PASS` | FTP giriş bilgileri |
| `FTP_ANONYMOUS` | `true` ise parolasız giriş |

HMAC anahtarı yoksa: Google Cloud Console → Cloud Storage → **Settings → Interoperability →
Create a key for a service account**.

## Bağlanma

FileZilla:

```
Host: 127.0.0.1     Port: 2121
Protocol: FTP        Encryption: Only use plain FTP
Transfer mode: Passive
User: gcs            Password: (.env'deki FTP_PASS)
```

## Nasıl çalışıyor

- `src/index.js` — FTP sunucusu, kimlik doğrulama, GCS erişim ön kontrolü
- `src/s3fs.js` — `ftp-srv`'in dosya sistemi katmanının S3/GCS karşılığı
- `src/config.js` — `.env` okuma ve varsayılanlar

Nesne depolamada klasör kavramı yok; köprü bunu şöyle eşliyor:

| FTP | GCS |
|---|---|
| `LIST` | `ListObjectsV2` + `Delimiter: "/"` (ortak önekler = klasör) |
| `MKD` | `klasor/` adlı 0 baytlık nesne |
| `STOR` | Akış halinde `Upload` (8 MB'ın üstü otomatik multipart) |
| `RETR` | `GetObject` (REST ile aralık desteği) |
| `RNFR`/`RNTO` | `CopyObject` + `DeleteObject` (klasörde özyinelemeli) |
| `RMD` | Yalnızca klasör boşsa siler |

Altında nesne bulunan "örtük" klasörler de (`MKD` ile oluşturulmamış olanlar) listede görünür.

## Bilinen sınırlar

- **APPE / kaldığı yerden devam (REST ile yükleme)** desteklenmez — nesne depolamada kısmi
  yazma yoktur. Yarıda kesilen yükleme baştan başlar. İndirmede devam etme çalışır.
- **FTPS/TLS yok.** Sunucuyu makine dışına açacaksanız `ftp-srv`'in `tls` seçeneğini
  yapılandırın veya bir VPN/SSH tüneli arkasına alın; aksi halde parola düz metin gider.
- Aynı ada sahip hem dosya hem klasör bir arada tutulabilir (GCS buna izin verir); FTP tarafında
  dosya öncelikli görünür.
- Çok büyük klasör listelemeleri sayfalanarak tamamen çekilir; on binlerce nesneli klasörlerde
  `LIST` yavaşlayabilir.

## Doğrulanan testler

Gerçek `camera_ftp_lema` bucket'ı üzerinde uçtan uca: giriş, `LIST`, `MKD`, `STOR`, `SIZE`,
`RETR` (bayt bayt eşleşme), `RNFR/RNTO`, `DELE`, `RMD` ve 20 MB'lık multipart yükleme +
SHA-256 doğrulamalı geri indirme.

## Dokploy ile yayına alma

FTP, HTTP olmadığı için Dokploy'un Traefik reverse-proxy'sinden **geçmez**; portları doğrudan
host üzerinde yayınlamak gerekir. Bu yüzden repoda `docker-compose.yml` var.

1. Dokploy → **Create Service → Compose**, bu repoyu bağlayın (`docker-compose.yml`).
2. **Environment** sekmesine `.env.example` içeriğini doldurup yapıştırın. Kritik olanlar:
   - `FTP_PASV_URL` → **sunucunun genel IP adresi** (alan adı değil, IP).
   - `FTP_PASS` → güçlü bir parola.
   - `S3_ACCESS_KEY` / `S3_SECRET` → GCS HMAC anahtarınız.
3. Sunucunun güvenlik duvarında şu portları açın:
   - `21/tcp` (kontrol kanalı)
   - `50000-50099/tcp` (pasif veri kanalı)
4. Deploy edin. Logda `[gcs] bucket erisimi dogrulandi` ve `[ftp] dinleniyor` satırlarını görün.

Bağlantı: `ftp://SUNUCU_IP:21`, pasif mod, `.env`'deki kullanıcı/parola.

> **Uyarı:** Bu kurulumda FTP trafiği şifresizdir; parola ve dosyalar düz metin gider.
> İnternete açık çalıştıracaksanız `ftp-srv`'in `tls` seçeneğiyle FTPS ekleyin ya da erişimi
> güvenlik duvarında yalnızca bilinen IP'lere kısıtlayın.

### Port 21 yerine başka port

`FTP_PORT` değişkenini değiştirmeniz yeterli; compose dosyası aynı portu host'ta yayınlar.

## IP kamera bağlarken

Köprü, kameraların tipik akışıyla test edildi: aktif mod (`PORT`), `TYPE I`, seviye seviye
`MKD` + `CWD` ile tarih bazlı klasör oluşturma, `STOR`, `LIST`, `RETR`, `MDTM`, `SIZE`, `FEAT`.

**Kamerayı pasif moda alın.** Kameralar varsayılan olarak aktif mod kullanır; aktif modda
*sunucu kameraya* veri bağlantısı açar. Kamera bir NAT/router arkasındaysa (sahadaki kurulumların
neredeyse tamamı) bulut sunucusu kameraya ulaşamaz ve aktarım yarıda kalır. Kamerada
"Passive / PASV / Pasif mod" seçeneği varsa işaretleyin.

Kamera arayüzüne girilecekler:

```
Sunucu / Server IP : sunucunun genel IP'si (veya A kaydı verdiğiniz domain)
Port               : 21
Kullanıcı / Parola : FTP_USER / FTP_PASS
Dizin / Directory  : / (veya cam01 gibi bir alt klasör)
Mod                : Passive
```

Notlar:

- **Parolayı sade tutun** (harf + rakam). Bazı kamera firmware'leri `@ : / #` gibi karakterleri
  FTP alanında bozuk gönderiyor.
- **Port 21'i değiştirmeyin** mümkünse; çoğu kamera arayüzü farklı port kabul etse de bazıları
  yalnızca 21'e bağlanır.
- **Pasif port aralığı** `50000-50099` (100 port). Tek kamera için fazlasıyla yeterli; çok sayıda
  kamerayı aynı anda bağlayacaksanız aralığı genişletin.
- **Şifreleme yok.** Kamera parolası ve görüntüler düz metin gider. Kameranın sabit bir çıkış
  IP'si varsa güvenlik duvarında 21 ve 50000-50099 portlarını yalnızca o IP'ye açın.
- **Maliyet:** kameralar sürekli dosya üretir. GCS tarafında bucket'a bir **Lifecycle kuralı**
  ekleyip (ör. 30 günden eski nesneleri sil ya da Nearline'a taşı) depolama maliyetini sınırlayın.
- Kamera her yüklemeden önce klasörü `MKD` ile oluşturmaya çalışıp hata alabilir; bu normaldir,
  klasör zaten varsa köprü işlemi sorunsuz sürdürür.
