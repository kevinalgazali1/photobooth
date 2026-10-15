# Booth Bareng

Photobooth online untuk 1 sampai 8 orang di lokasi yang berbeda. Pembuat room memilih jumlah orang, mengirim tautannya ke teman-teman, lalu semua berfoto bareng lewat kamera masing-masing. Hitung mundur berjalan bersamaan, dan hasilnya satu strip foto (satu panel per jepretan, berisi foto semua orang) yang identik dan bisa diunduh di setiap perangkat.

Tanpa database. Video, suara, dan foto dikirim langsung antar browser (WebRTC). Supabase hanya dipakai sebagai "perantara perkenalan" (signaling) lewat Realtime Broadcast dan Presence.

**Stack:** Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS 4 · Supabase Realtime · WebRTC

---

## Cara kerja

```
        1. presence + offer/answer/ICE (setiap pesan punya field `to`)
 A ─┐                                                   ┌─ C
 B ─┼──────────►  Supabase Realtime (tanpa tabel)  ◄────┼─ D

        2. mesh WebRTC: satu RTCPeerConnection + data channel per pasang orang
        A ◄══► B    A ◄══► C    A ◄══► D
        B ◄══► C    B ◄══► D    C ◄══► D
        • video + audio (live)
        • data channel: pengaturan, aba-aba mulai, foto resolusi penuh
```

1. **Kapasitas room** ikut di tautan, mis. `/room/abc123?n=4`. Orang yang masuk lewat kode saja (tanpa `?n`) memakai kapasitas yang tercatat di presence anggota yang sudah ada.
2. **Penerimaan anggota lewat presence** di channel `photobooth:<kode-room>`:
   - setiap orang melakukan `track({ id, joinedAt, capacity, admitted })`;
   - pendatang baru menunggu ±700 ms, lalu menghitung slot sisa = kapasitas − anggota lain yang sudah `admitted`. Pendatang yang bersamaan diurutkan berdasarkan `joinedAt` lalu `id`, jadi semua sepakat siapa yang dapat tempat;
   - kalau dapat slot, dia menjadi `admitted` (permanen, tidak bisa tertendang karena perbedaan jam antar perangkat). Kalau tidak, dia melihat layar "room penuh".
3. **Mesh:** setiap pasangan anggota punya satu `RTCPeerConnection` + data channel. Yang id-nya lebih kecil membuat **offer**, jadi tidak ada tabrakan. Kandidat ICE dikirim per batch dan pesan signaling diberi jeda supaya burst 8 orang tidak kena rate limit Realtime.
4. **Bandwidth:** setelah tersambung, bitrate video kirim dibatasi ≈ 1,5 Mbps ÷ jumlah teman (minimal 150 kbps, maksimal 1,2 Mbps), dan resolusi kirim dibagi dua untuk room ≥4 orang. Ini hanya memengaruhi video live; foto tetap diambil dari kamera lokal dalam resolusi penuh.
5. Setelah tersambung, semua komunikasi lewat **data channel**:
   - `settings`: bingkai, filter, jumlah foto, format hasil, dan tulisan. Hanya host yang mengirimnya, ke setiap data channel yang baru terbuka, jadi pendatang baru langsung ikut sinkron. Peserta juga bisa meminta ulang dengan pesan `sync`;
   - `start` / `reset`: hanya dari host. `start` membawa `order` (urutan peserta) supaya semua orang menyusun hasil dengan urutan yang sama;
   - tiap browser memotret **kamera lokalnya sendiri** lalu mengirim fotonya ke semua teman dalam potongan 16 KB (antrean terpisah per data channel). Kalau foto seseorang tidak datang dalam 12 detik, slotnya diisi kotak kosong, lalu diganti begitu fotonya datang.
6. Semua browser menyusun hasil di `<canvas>` dengan urutan dan pengaturan yang sama, jadi hasilnya identik.

Room 1 orang tidak membuat koneksi peer sama sekali; tombol "Mulai foto" langsung aktif. Untuk room lebih dari 1 orang, tombol aktif begitu minimal satu teman tersambung. Yang ikut di foto adalah host dan teman yang sudah tersambung dengannya saat tombol ditekan.

## Pembuat room (host)

Hanya pembuat room yang bisa mengubah bingkai, filter, jumlah foto, format, dan tulisan, serta menekan "Mulai foto" dan "Foto lagi". Peserta lain melihat ringkasan pengaturan (baca saja), tombol mikrofon, dan tombol unduh. Identitas host diverifikasi tanpa database, memakai Web Crypto (`src/lib/host.ts`):

1. Saat "Buat room baru", browser membuat pasangan kunci **ECDSA P-256**. Room id = 10 karakter pertama dari SHA-256(public key), memakai alfabet tanpa karakter mirip (tanpa `l 1 o 0 i`). Private key (JWK) disimpan di `localStorage` dengan kunci `host:<roomId>`, jadi host tetap host setelah refresh. Pengaturan terakhir host juga disimpan, supaya tidak kembali ke bawaan.
2. Host menaruh `hostPublicKey` dan `hostProof` di presence. `hostProof` adalah tanda tangan atas `<roomId>:<peerId>:<joinedAt>`.
3. Peserta menganggap seseorang host hanya bila hash public key-nya cocok dengan room id **dan** tanda tangannya valid untuk peerId orang itu. Klaim yang tidak valid diabaikan. Menyalin presence host tidak berguna karena tanda tangannya terikat ke peerId host.
4. Pesan `settings`, `start`, dan `reset` hanya diproses bila datang dari data channel milik host terverifikasi. Pengirim ditentukan dari data channel asal pesan, bukan dari isi pesan.
5. Satu kursi selalu disisakan untuk host, jadi host yang kembali tidak pernah mendapat "room penuh". Selama host tidak ada, peserta melihat "Pembuat room keluar. Sesi lanjut saat dia kembali." Host yang membuka tautan lagi di browser yang sama otomatis kembali menjadi host.

Room dengan kode format lama (6 karakter, tanpa kunci) tetap bisa dibuka. Di room seperti itu semua orang memegang kendali, dan booth menampilkan pesan bahwa room dibuat dengan versi lama, lengkap dengan tombol membuat room baru.

> Kunci host hanya ada di browser pembuatnya. Kalau pembuat room menghapus data situs atau pindah perangkat, room itu tidak punya host lagi. Buat room baru saja.

## Layout hasil

Satu jepretan = satu panel. Susunan panel berasal dari satu fungsi bersama `getLayout(n)` (`src/lib/layout.ts`) yang dipakai untuk tampilan kamera live **dan** canvas, jadi yang terlihat saat foto sama dengan hasilnya:

| Orang | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|-------|---|---|---|---|---|---|---|---|
| Grid | 1×1 | 2×1 | 3×1 | 2×2 | 3×2 | 3×2 | 4×2 | 4×2 |
| Tile hiasan | 0 | 0 | 0 | 0 | 1 | 0 | 1 | 0 |

- Rasio sel 4:3 untuk N ≤ 2 dan 1:1 untuk N ≥ 3 (crop tengah dari foto asli).
- **2 orang: tanpa celah.** Kedua foto menempel (di hasil dan di tampilan live), jadi satu panel terlihat seperti satu ruangan. Paling terasa bila dipadukan dengan background pengganti.
- Slot sisa di kanan bawah diisi **tile hiasan** dari bingkai terpilih: warna bingkai, caption, nomor jepretan ("2/3"), dan stiker bingkai bila ada. Tampilan live menampilkan tile yang sama.
- Lebar sel di canvas minimal 520 px. PNG lebih baik membesar (sampai ±4800 px di sisi terpanjang) daripada fotonya mengecil.
- **Format hasil** (diatur host): *Strip*, yaitu semua jepretan ditumpuk dalam satu gambar; atau *Per jepretan*, yaitu setiap jepretan menjadi gambar sendiri dengan bingkai lengkap. Di format Per jepretan ada tombol unduh per gambar dan tombol "Unduh semua" yang membuat ZIP di browser (`fflate`).
- Bawaan mengikuti N, dan host tetap bisa mengubahnya:

  | Orang | 1–2 | 3–4 | 5–8 |
  |-------|-----|-----|-----|
  | Jumlah jepretan | 4 | 3 | 2 |
  | Format | Strip | Strip | Per jepretan |

- Ukuran tile kamera live dihitung agar sebesar mungkin di lebar dan tinggi viewport, dan saat hitung mundur panggung digulir supaya semua tile terlihat tanpa scroll. Di HP portrait untuk N ≥ 5, tampilan live memakai 2 kolom; layout hasil tetap mengikuti tabel.

## Background pengganti

Host bisa memilih **Background** (Studio, Ruang tamu, Kafe, Pantai, Senja kota, atau Asli). Latar ruangan tiap orang diganti satu pemandangan yang membentang di seluruh area foto panel, jadi menyambung dari foto kiri ke kanan (jendela, untaian lampu, cakrawala, sofa, atau pagar balkon melintasi sambungan) dan semua orang terlihat berada di tempat yang sama.

Cara kerjanya:

1. Setiap orang memotret kamera lokalnya seperti biasa.
2. Perangkat pemilik foto memisahkan orang dari latarnya dengan **segmentasi selfie MediaPipe** (`src/lib/segment.ts`), langsung di browser tanpa server. Tepinya dihaluskan, lalu hasilnya disimpan sebagai **masker** PNG (lebar 640 px, ±20–60 KB).
3. Masker dikirim ke semua teman lewat data channel, sama seperti foto (`kind: "mask"`).
4. Semua browser menyusun hasil dari foto + masker yang sama persis, jadi hasilnya tetap identik. Masker tidak dihitung ulang di tiap perangkat karena GPU yang berbeda bisa memberi hasil yang sedikit berbeda.

Catatan:

- Model (±250 KB) ada di `public/models/selfie_segmenter.tflite`. Runtime WASM (±12 MB) dimuat dari jsDelivr **hanya** saat background dipilih, dan mulai diunduh begitu host memilihnya supaya siap saat memotret. Versi di `TASKS_VISION_VERSION` (`src/lib/segment.ts`) harus sama dengan versi paket `@mediapipe/tasks-vision` di `package.json`.
- Background bisa diganti di tahap review tanpa memotret ulang. Bila masker belum ada, perangkat masing-masing membuatnya saat itu juga.
- Kalau masker seseorang tidak datang dalam 12 detik (mis. model gagal dimuat di HP lama), fotonya ditampilkan dengan latar asli, lalu diganti begitu maskernya datang.
- Tampilan kamera live tetap menampilkan latar asli; penggantian background hanya pada hasil foto.

Menambah background: simpan SVG/PNG/JPG rasio ±8:3 (dua foto 4:3 berdampingan) di `public/backgrounds/`, lalu daftarkan di `src/lib/backgrounds.ts`. Letakkan hal menarik di pinggir, atas, dan melintasi tengah; bagian tengah bawah tiap separuh akan tertutup badan. Untuk SVG, hindari teks.

## Batas realistis

Mesh berarti setiap orang mengirim video ke **setiap** teman. Dengan 8 orang, satu HP meng-encode dan mengirim 7 video sekaligus, dan men-decode 7 video masuk.

- **2–4 orang:** nyaman di kebanyakan laptop dan HP.
- **5–8 orang:** bisa jalan, tetapi berat untuk HP (panas, baterai cepat habis, video patah-patah). Sarankan semua memakai **Wi-Fi** dan pasang **TURN server** (lihat di bawah). Di jaringan seluler dengan CGNAT, sebagian pasangan koneksi mungkin hanya bisa tersambung lewat TURN.
- **Lebih dari 8 orang:** jangan pakai mesh. Ganti ke **SFU** (Selective Forwarding Unit), mis. [LiveKit](https://livekit.io) (open source atau cloud), mediasoup, atau Cloudflare Calls. Dengan SFU setiap orang cukup mengirim satu video ke server yang meneruskannya ke yang lain. Alur foto lewat data channel dan penyusunan strip di canvas tetap bisa dipakai.

## Struktur folder

```
public/
├── backgrounds/              # pemandangan background pengganti (SVG 8:3)
├── frames/                   # gambar/stiker bingkai (PNG/SVG transparan)
└── models/                   # model segmentasi selfie MediaPipe
src/
├── app/
│   ├── page.tsx              # halaman depan: pilih jumlah orang, buat / masuk room
│   ├── room/[id]/page.tsx    # halaman booth (?n= kapasitas)
│   └── api/ice/route.ts      # daftar STUN/TURN (kredensial TURN tetap di server)
├── components/
│   ├── Booth.tsx             # UI booth: grid kamera, hitung mundur, pengaturan/ringkasan, hasil
│   ├── DecorTile.tsx         # tile hiasan di grid live (digambar oleh fungsi canvas yang sama)
│   ├── FramePicker.tsx       # pemilih bingkai dengan thumbnail hasil asli
│   ├── ResultGallery.tsx     # tampilan hasil, unduh per gambar, "Unduh semua" (ZIP)
│   ├── VideoTile.tsx
│   ├── StartForm.tsx         # pilih jumlah orang, buat room (+ kunci host), masuk room
│   └── SampleStrip.tsx
├── hooks/
│   ├── usePeerRoom.ts        # presence, penerimaan anggota, verifikasi host, mesh RTCPeerConnection
│   └── useBoxSize.ts         # ukuran panggung + viewport untuk grid live
└── lib/
    ├── supabase.ts           # client Supabase (Realtime saja)
    ├── host.ts               # kunci host (ECDSA P-256), room id, verifikasi, penyaring pesan
    ├── host.test.ts          # unit test verifikasi host (npm test)
    ├── layout.ts             # getLayout(n) + bawaan jumlah jepretan & format
    ├── backgrounds.ts        # daftar background pengganti
    ├── segment.ts            # segmentasi orang → masker PNG (MediaPipe)
    ├── capture.ts            # ambil frame kamera → JPEG 4:3
    ├── frames.ts             # definisi bingkai
    ├── strip.ts              # gambar hasil (pola, hiasan, stiker, tile hiasan, filter) → PNG
    ├── transfer.ts           # kirim/terima foto & masker lewat data channel
    ├── room.ts               # normalisasi kode room
    └── types.ts
```

Unit test memakai test runner bawaan Node (tanpa dependency tambahan):

```bash
npm test
```

## Menjalankan di lokal

1. **Buat project Supabase** di [supabase.com](https://supabase.com). Tidak perlu membuat tabel.
2. Buka **Project Settings → API Keys**, salin *Project URL* dan *Publishable key*.
3. Buka **Realtime → Settings** dan pastikan channel publik diizinkan (opsi seperti "Allow public access" aktif). Aplikasi ini memakai channel publik tanpa login.
4. Salin env:
   ```bash
   cp .env.example .env.local
   ```
   lalu isi `NEXT_PUBLIC_SUPABASE_URL` dan `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
5. Jalankan:
   ```bash
   npm install
   npm run dev
   ```
6. Buka `http://localhost:3000`, pilih jumlah orang, buat room, lalu buka tautan yang sama di beberapa tab (atau browser lain) untuk mencoba. Tab yang membuat room menjadi host; tab lain menjadi peserta.

> Kamera hanya bisa diakses lewat **HTTPS** atau `localhost`. Untuk mencoba dari HP, deploy dulu ke Vercel (lihat di bawah) lalu buka URL Vercel-nya.

## Deploy ke Vercel

1. Push repo ke GitHub.
2. Di Vercel: **Add New → Project**, pilih repo ini. Framework terdeteksi otomatis sebagai Next.js.
3. Di **Settings → Environment Variables**, isi variabel yang sama seperti `.env.local` (Supabase wajib, TURN disarankan).
4. Deploy. Selesai, tidak ada database atau storage yang perlu disiapkan.

## TURN server (penting untuk jaringan seluler)

STUN gratis dari Google sudah cukup untuk banyak jaringan Wi-Fi rumah. Namun banyak operator seluler di Indonesia memakai CGNAT, dan di jaringan seperti itu koneksi langsung sering gagal. Gejalanya: status berhenti di "Menyambungkan ke teman-temanmu…", atau hanya sebagian teman yang videonya muncul. TURN server menjadi jalur cadangan yang meneruskan video saat koneksi langsung tidak bisa dibuat. Di room besar, ingat bahwa setiap pasangan koneksi yang lewat TURN ikut memakai kuota TURN.

Pilihan gratis untuk mulai:
- **Metered.ca** (Open Relay): daftar, buat app, lalu isi `TURN_CREDENTIALS_URL` dengan endpoint credential dari dashboard.
- **Cloudflare Calls TURN**, atau server sendiri dengan **coturn**.

Kredensial TURN dibaca oleh route `/api/ice` di server, jadi tidak ikut masuk ke bundle JavaScript.

## Bingkai sendiri

Semua bingkai didefinisikan di `src/lib/frames.ts` dan digambar di canvas dengan urutan: latar → pola → hiasan & stiker → foto → tulisan dan tanggal. Hiasan dan stiker digambar sebelum foto, jadi hanya terlihat di margin dan footer.

```ts
{
  id: "ultah",
  label: "Ulang tahun",
  bg: "#FFF4D6",            // warna latar
  fg: "#7A2E00",            // warna tulisan, pola, dan hiasan
  pattern: "dots",          // opsional: "dots" | "stripes" | "gingham" | "grid"
  decor: "stars",           // opsional: "hearts" | "stars" | "sparkles" (bentuk path, bukan emoji)
  film: false,              // opsional: latar gelap + lubang sprocket kiri-kanan
  padding: 96,              // opsional: margin dalam px pada skala penuh (sel foto = 600 px). Bawaan 48
  stickers: [               // opsional
    { src: "/frames/topi.png", anchor: "top-left", size: 160 },
    { src: "/frames/kue.svg", anchor: "footer-right", size: 120 },
  ],
}
```

Membuat stiker dari Figma:

1. Buat frame dengan **latar transparan** (hapus fill frame-nya), lalu gambar stikernya.
2. Export sebagai **PNG 2x** atau **SVG**. Untuk SVG, pastikan atribut `width` dan `height` ada (Figma menambahkannya otomatis). Hindari teks: ubah menjadi outline (*Flatten* / *Outline stroke*) supaya hasilnya sama di semua perangkat.
3. Simpan ke `public/frames/`, mis. `public/frames/topi.png`.
4. Daftarkan di `FRAME_LIST` pada `src/lib/frames.ts`. `anchor` bisa `top-left`, `top-right`, `bottom-left`, `bottom-right`, `footer-left`, atau `footer-right`; `size` adalah sisi terpanjang stiker dalam px pada skala penuh. Perbesar `padding` kalau stikernya besar supaya tidak banyak tertutup foto.

Contohnya bingkai "Studio" yang memakai `public/frames/camera.svg`, `star.svg`, dan `heart.svg`. Thumbnail di pemilih bingkai otomatis ikut menampilkan bingkai baru.

## Hal yang perlu diketahui

- **Project Supabase gratis bisa di-pause** jika tidak dipakai beberapa waktu. Jika booth tiba-tiba gagal terhubung ke Supabase, cek dashboard dan aktifkan lagi project-nya.
- **Kapasitas room ditentukan pembuatnya (1–8).** Orang yang datang setelah room penuh melihat pesan "room penuh". Satu kursi selalu disisakan untuk host. Anggota yang sudah masuk tidak akan tertendang oleh pendatang baru. Kalau ada yang keluar, kirim ulang tautannya untuk mengisi tempat yang kosong.
- **Tidak ada yang tersimpan.** Begitu tab ditutup, foto hilang. Pastikan menekan "Unduh strip".
- **Kode room bersifat publik.** Siapa pun yang tahu kodenya bisa masuk selama room belum penuh. Kode acak 6 karakter cukup untuk pemakaian pribadi. Untuk produksi, pertimbangkan channel privat Supabase dengan token.
- **Safari iOS:** suara teman kadang baru menyala setelah layar disentuh. Booth akan menampilkan tombol "Ketuk untuk menyalakan suara" bila itu terjadi.

## Ide pengembangan

- Lebih banyak bingkai (tema ulang tahun, wisuda, lebaran) di `src/lib/frames.ts`.
- Layout strip vertikal klasik (2×6 inci) untuk dicetak.
- Rekam GIF/boomerang dari beberapa frame tiap jepretan.
- Lebih dari 8 orang lewat SFU (lihat "Batas realistis").
