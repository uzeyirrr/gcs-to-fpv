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

## Her kameraya ayrı kullanıcı ve gün klasörü

### Kullanıcılar

`FTP_USERS` ile her kameraya ayrı hesap tanımlanır:

```
FTP_USERS=cam01:parola1,cam02:parola2,giris:parola3:giris-kamerasi
```

Biçim `kullanıcı:parola[:klasör]`. Klasör verilmezse kullanıcı adı klasör olur. **Her kullanıcı
yalnızca kendi klasörünü görür** — `..` ile üst dizine çıkma reddedilir, diğer kameraların
dosyaları listelenemez.

`FTP_USERS` boş bırakılırsa eski tek kullanıcılı davranış (`FTP_USER`/`FTP_PASS`) geçerli kalır.

### Gün klasörleri

`AUTO_DATE_PATH=true` (varsayılan) iken yüklemeler kullanıcının klasörü altında güne göre ayrılır.
Bunu **sunucu** yapar, kameranın ayarına bakmaz:

| Kamera ne yaparsa | GCS'te nereye yazılır |
|---|---|
| `STOR snap.jpg` (düz) | `cam01/2026-08-25/snap.jpg` |
| `MKD kapi` + `STOR snap.jpg` | `cam01/2026-08-25/kapi/snap.jpg` |

Tarih `TIMEZONE` (varsayılan `Europe/Istanbul`) saat dilimine göre hesaplanır, gece yarısı
kendiliğinden yeni klasöre geçer. Kamera dosyayı yazdığı yolda `SIZE`/`MDTM` ile arasa bile
köprü tarihli karşılığına düşerek doğru cevap verir.

Kameranın kendisi zaten tarih klasörü oluşturuyorsa iç içe tarih (`2026-08-25/2026-08-25/`)
oluşmaması için ya kameranın klasör şablonunu kapatın ya da `AUTO_DATE_PATH=false` yapın.

### İzleme paneli

Sunucu, 8080 portunda kamera başına durum sayfası yayınlar:

- Durum: Bağlı / Çalışıyor / **Sessiz** (`STATS_STALE_MINUTES` dakikadır yükleme yok) / Hiç yüklemedi
- Son yükleme zamanı ve dosya yolu
- Bugünkü ve toplam dosya sayısı + boyut
- Son bağlanan IP, başarısız giriş denemeleri, son hata

`/stats.json` aynı veriyi JSON verir (izleme sistemine bağlamak için), `/health` sağlık kontrolü.
`STATS_USER`/`STATS_PASS` verilmezse panel **parolasızdır** — mutlaka doldurun.

Panel HTTP olduğu için Dokploy'da bu Compose servisine domain tanımlayabilirsiniz; Traefik
8080'e yönlendirir ve HTTPS/Cloudflare sorunsuz çalışır (FTP'nin aksine).

## Yönetim paneli

Panel 8080 portunda çalışır ve **tüm kamera işlemleri buradan yapılır** — sunucuya girmeye,
`.env` düzenlemeye veya yeniden deploy etmeye gerek yok. Değişiklikler anında geçerli olur.

| İşlem | Ne yapar |
|---|---|
| **Kamera oluştur** | FTP hesabı açar, adına göre GCS klasörünü belirler, parolayı üretir |
| **Yeni parola** | Parolayı döndürür; eski parola anında geçersiz olur |
| **Kapat / Aç** | Hesabı geçici olarak devre dışı bırakır (dosyalar durur) |
| **Sil** | Hesabı siler; **GCS'teki dosyalar silinmez** |

Her satırda kameranın durumu, son yükleme zamanı ve yolu, bugünkü/toplam dosya sayısı ve boyutu,
son bağlanan IP ve son hata görünür. Kamera adı Türkçe girilebilir (`Otopark Kamerası` →
`otopark-kamerasi`); üretilen parolalar kamera uyumluluğu için yalnızca harf ve rakam içerir.

### Kayıtlar nerede tutuluyor

Kamera kayıtları bucket içinde `_system/users.json` dosyasındadır (`S3_PREFIX` verilmişse onun
altında). Böylece konteyner yeniden kurulsa da kayıtlar kalır, ayrı bir veritabanı veya kalıcı
disk gerekmez. Dosya ilk açılışta `FTP_USERS`/`FTP_USER` ayarından tohumlanır; **dosya bir kez
oluştuktan sonra bu ortam değişkenleri artık okunmaz**, yönetim panele geçer.

FTP parolaları bu dosyada düz metin durur. FTP protokolü parolayı zaten şifresiz taşıdığı ve
kamera kurulumunda parolanın tekrar okunabilmesi gerektiği için bilinçli bir tercihtir; bucket'a
erişebilen zaten tüm kamera görüntülerine erişebilmektedir.

`STATS_USER`/`STATS_PASS` paneli korur — panelden FTP hesabı açılabildiği için bu **zorunlu**
sayılmalıdır. Panel HTTP olduğundan Dokploy'da bu Compose servisine domain tanımlanabilir.

## Galeri

Panelde **Galeriyi aç** ile kamera → gün → görüntü şeklinde gezilir. Görseller GCS'ten panel
üzerinden akıtılır; bucket herkese açık hale getirilmez ve paylaşılabilir kalıcı bağlantı oluşmaz —
galeriye erişim panelin kendi parolasıyla korunur.

- **Saat filtresi**: gün seçilince o gün dosya gelen saatler, yanlarında dosya sayısıyla listelenir;
  bir saate tıklayınca yalnızca o saatin görüntüleri gösterilir. Saat, dosyanın sunucuya ulaştığı
  ana göre ve `TIMEZONE` saat dilimine göre hesaplanır — kameranın klasör adlandırmasına bağlı değil
- Kamera saat gibi alt klasörler açtıysa onlar da aynı günün içinde listelenir
- Sayfa başına 120 dosya; "Önceki / Sonraki" ile gezilir, kaçıncı aralıkta olduğunuz görünür
- Bir günde 5000'den fazla dosya varsa en yenileri taranır ve uyarı gösterilir
- Küçük resme tıklayınca tam boy açılır; videolar için aralıklı (range) indirme desteklenir
- `/dosya` yalnızca tanımlı kamera klasörlerinin altındaki dosyaları verir; `_system/users.json`
  gibi dosyalar ve `..` içeren yollar reddedilir

## Kaba kuvvet koruması

Kameralar sabit IP'den bağlanmadığı için FTP portu herkese açık kalmak zorunda. Bu yüzden aynı
IP'den üst üste başarısız giriş yapanlar geçici olarak engellenir:

| Ayar | Varsayılan | Anlamı |
|---|---|---|
| `FTP_MAX_FAILED` | 10 | Kaç başarısız denemeden sonra engel |
| `FTP_BAN_MINUTES` | 15 | Engel süresi (dakika) |

Başarılı giriş sayacı sıfırlar; parolasını bir kez yanlış giren kamera cezalandırılmaz. Engelliyken
doğru parola da kabul edilmez. Panelde "Başarısız giriş denemeleri" tablosunda hangi IP'nin hangi
kullanıcı adını denediği görünür ve engel elle kaldırılabilir.

Bu bir güvenlik duvarı yerine geçmez, sadece parola denemesini yavaşlatır. Şifrelemeyi (FTPS) ve
mümkünse IP kısıtlamasını hâlâ değerlendirin.

## Güvenlik notları

Uygulama bir güvenlik denetiminden geçti; bulunanlar ve alınan önlemler:

- **CSRF:** Panel HTTP Basic auth kullanıyor ve Basic auth çerez olmadığı için `SameSite`
  koruması devreye girmez — tarayıcı kimlik bilgilerini o origin'e giden her isteğe, isteği kim
  başlatırsa başlatsın ekler. Bu yüzden durum değiştiren tüm POST işlemlerinde `Origin`
  (yoksa `Referer`) başlığı kendi host'umuzla karşılaştırılır; eşleşmezse 403 döner. Başlığın hiç
  gönderilmediği istekler de reddedilir.
- **Panel kimlik doğrulaması fail-closed:** `STATS_USER`/`STATS_PASS` tanımlı değilse panel
  **başlatılmaz**. Panelden FTP hesabı açılabildiği ve tüm kamera görüntüleri gezilebildiği için,
  sessizce herkese açık hale gelmesindense hiç çalışmaması tercih edilir. FTP sunucusu bu durumda
  normal çalışmaya devam eder; sebep loga açıkça yazılır.
- **Parolalar URL'de taşınmaz:** Yeni üretilen FTP parolası, yönlendirmenin sorgu dizesine
  konsaydı tarayıcı geçmişine ve arada duran Cloudflare/Traefik erişim kayıtlarına düşerdi.
  Mesaj sunucuda tutulur; yönlendirmede yalnızca tahmin edilemez, **tek kullanımlık** bir kimlik
  taşınır ve 5 dakika sonra düşer.
- **Kullanıcı kayıtları asla servis edilmez:** `/dosya` yalnızca tanımlı kamera klasörlerinin
  altını verir ve `_system/users.json` açıkça dışarıdadır — tek kullanıcılı modda kullanıcının
  kökü prefix'in kendisi olduğu için bu kontrol gereklidir.

Kalan bilinen risk: **FTP trafiği şifresizdir.** Kameralar sabit IP'den bağlanmadığı için port
kısıtlanamıyor; kaba kuvvet koruması parola denemesini yavaşlatır ama şifrelemenin yerini tutmaz.
Kameralarınız FTPS destekliyorsa TLS eklemek en etkili iyileştirme olur.
