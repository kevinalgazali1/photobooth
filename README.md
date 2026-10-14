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
   - `settings`: bingkai, filter, jumlah foto, dan tulisan. Memakai aturan "yang terbaru menang" (`updatedAt`). Pengaturan dikirim ke setiap data channel yang baru terbuka, jadi pendatang baru langsung ikut sinkron;
   - `start`: hitung mundur dimulai bersamaan, membawa `order` (urutan peserta) supaya semua orang menyusun strip dengan urutan yang sama;
   - tiap browser memotret **kamera lokalnya sendiri** lalu mengirim fotonya ke semua teman dalam potongan 16 KB (antrean terpisah per data channel). Kalau foto seseorang tidak datang dalam 12 detik, slotnya diisi kotak kosong, lalu diganti begitu fotonya datang.
6. Semua browser menyusun strip di `<canvas>` dengan urutan dan pengaturan yang sama, jadi hasilnya identik.

Room 1 orang tidak membuat koneksi peer sama sekali; tombol "Mulai foto" langsung aktif. Untuk room lebih dari 1 orang, tombol aktif begitu minimal satu teman tersambung. Yang ikut di strip adalah kamu dan teman yang sudah tersambung saat tombol ditekan.

## Layout strip

Satu jepretan = satu panel berisi N foto 4:3. Jumlah kolom per panel:

| Orang | 1 | 2 | 3 | 4 | 5–6 | 7–8 |
|-------|---|---|---|---|-----|-----|
| Kolom | 1 | 2 | 3 | 2 | 3   | 4   |

Baris terakhir yang tidak penuh diletakkan di tengah. Panel ditumpuk ke bawah sesuai jumlah jepretan (1–4). Untuk N besar ukuran sel diperkecil supaya sisi terpanjang PNG ≤ ±4000 px. Tampilan kamera di booth memakai susunan kolom yang sama, dengan urutan tile yang sama di semua layar.

## Batas realistis

Mesh berarti setiap orang mengirim video ke **setiap** teman. Dengan 8 orang, satu HP meng-encode dan mengirim 7 video sekaligus, dan men-decode 7 video masuk.

- **2–4 orang:** nyaman di kebanyakan laptop dan HP.
- **5–8 orang:** bisa jalan, tetapi berat untuk HP (panas, baterai cepat habis, video patah-patah). Sarankan semua memakai **Wi-Fi** dan pasang **TURN server** (lihat di bawah). Di jaringan seluler dengan CGNAT, sebagian pasangan koneksi mungkin hanya bisa tersambung lewat TURN.
- **Lebih dari 8 orang:** jangan pakai mesh. Ganti ke **SFU** (Selective Forwarding Unit), mis. [LiveKit](https://livekit.io) (open source atau cloud), mediasoup, atau Cloudflare Calls. Dengan SFU setiap orang cukup mengirim satu video ke server yang meneruskannya ke yang lain. Alur foto lewat data channel dan penyusunan strip di canvas tetap bisa dipakai.

## Struktur folder

```
public/
└── frames/                   # gambar/stiker bingkai (PNG/SVG transparan)
src/
├── app/
│   ├── page.tsx              # halaman depan: pilih jumlah orang, buat / masuk room
│   ├── room/[id]/page.tsx    # halaman booth (?n= kapasitas)
│   └── api/ice/route.ts      # daftar STUN/TURN (kredensial TURN tetap di server)
├── components/
│   ├── Booth.tsx             # UI booth: grid kamera, hitung mundur, pengaturan, hasil
│   ├── FramePicker.tsx       # pemilih bingkai dengan thumbnail strip asli
│   ├── VideoTile.tsx
│   ├── StartForm.tsx
│   └── SampleStrip.tsx
├── hooks/
│   └── usePeerRoom.ts        # presence + penerimaan anggota, signaling, mesh RTCPeerConnection
└── lib/
    ├── supabase.ts           # client Supabase (Realtime saja)
    ├── capture.ts            # ambil frame kamera → JPEG 4:3
    ├── frames.ts             # definisi bingkai
    ├── strip.ts              # layout + gambar strip (pola, hiasan, stiker, filter) → PNG
    ├── transfer.ts           # kirim/terima file lewat data channel
    ├── room.ts               # kode room
    └── types.ts
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
6. Buka `http://localhost:3000`, pilih jumlah orang, buat room, lalu buka tautan yang sama di beberapa tab (atau browser lain) untuk mencoba.

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
- **Kapasitas room ditentukan pembuatnya (1–8).** Orang yang datang setelah room penuh melihat pesan "room penuh". Anggota yang sudah masuk tidak akan tertendang oleh pendatang baru. Kalau ada yang keluar, kirim ulang tautannya untuk mengisi tempat yang kosong.
- **Tidak ada yang tersimpan.** Begitu tab ditutup, foto hilang. Pastikan menekan "Unduh strip".
- **Kode room bersifat publik.** Siapa pun yang tahu kodenya bisa masuk selama room belum penuh. Kode acak 6 karakter cukup untuk pemakaian pribadi. Untuk produksi, pertimbangkan channel privat Supabase dengan token.
- **Safari iOS:** suara teman kadang baru menyala setelah layar disentuh. Booth akan menampilkan tombol "Ketuk untuk menyalakan suara" bila itu terjadi.

## Ide pengembangan

- Lebih banyak bingkai (tema ulang tahun, wisuda, lebaran) di `src/lib/frames.ts`.
- Layout strip vertikal klasik (2×6 inci) untuk dicetak.
- Rekam GIF/boomerang dari beberapa frame tiap jepretan.
- Lebih dari 8 orang lewat SFU (lihat "Batas realistis").
