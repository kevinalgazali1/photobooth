# Booth Berdua

Photobooth online untuk dua orang di lokasi yang berbeda. Salah satu membuat room, mengirim tautannya, lalu keduanya berfoto bareng lewat kamera masing-masing. Hitung mundur berjalan bersamaan, dan hasilnya satu strip foto (kiri: orang pertama, kanan: orang kedua) yang bisa diunduh di kedua perangkat.

Tanpa database. Video, suara, dan foto dikirim langsung antar browser (WebRTC). Supabase hanya dipakai sebagai "perantara perkenalan" (signaling) lewat Realtime Broadcast.

**Stack:** Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS 4 · Supabase Realtime · WebRTC

---

## Cara kerja

```
Browser A ──┐                                   ┌── Browser B
            │  1. presence + offer/answer/ICE   │
            └──────► Supabase Realtime ◄────────┘
                     (Broadcast, tanpa tabel)

Browser A ◄════════ 2. WebRTC peer-to-peer ════════► Browser B
                    • video + audio (live)
                    • data channel: pengaturan, aba-aba mulai, foto resolusi penuh
```

1. **Presence** di channel `photobooth:<kode-room>` menentukan siapa saja yang ada di room (maksimal 2; orang ketiga mendapat pesan "room penuh").
2. Peserta dengan id terkecil membuat **offer**, yang lain membalas **answer**. Kandidat ICE dikirim per batch agar tidak kena rate limit.
3. Setelah tersambung, semua komunikasi berpindah ke **data channel** WebRTC:
   - `settings`: bingkai, filter, jumlah foto, dan tulisan selalu sinkron di kedua layar.
   - `start`: hitung mundur dimulai bersamaan.
   - Tiap browser memotret **kamera lokalnya sendiri** (resolusi asli, bukan stream yang sudah dikompres), lalu mengirim fotonya ke pasangan dalam potongan 16 KB.
4. Kedua browser menyusun strip di `<canvas>` dengan urutan yang sama, jadi hasilnya identik.

## Struktur folder

```
src/
├── app/
│   ├── page.tsx              # halaman depan: buat / masuk room
│   ├── room/[id]/page.tsx    # halaman booth
│   └── api/ice/route.ts      # daftar STUN/TURN (kredensial TURN tetap di server)
├── components/
│   ├── Booth.tsx             # UI booth: kamera, hitung mundur, pengaturan, hasil
│   ├── VideoTile.tsx
│   ├── StartForm.tsx
│   └── SampleStrip.tsx
├── hooks/
│   └── usePeerRoom.ts        # presence, signaling, RTCPeerConnection, data channel
└── lib/
    ├── supabase.ts           # client Supabase (Realtime saja)
    ├── capture.ts            # ambil frame kamera → JPEG 4:3
    ├── strip.ts              # susun strip + bingkai + filter → PNG
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
6. Buka `http://localhost:3000`, buat room, lalu buka tautan yang sama di tab lain (atau browser lain) untuk mencoba.

> Kamera hanya bisa diakses lewat **HTTPS** atau `localhost`. Untuk mencoba dari HP, deploy dulu ke Vercel (lihat di bawah) lalu buka URL Vercel-nya.

## Deploy ke Vercel

1. Push repo ke GitHub.
2. Di Vercel: **Add New → Project**, pilih repo ini. Framework terdeteksi otomatis sebagai Next.js.
3. Di **Settings → Environment Variables**, isi variabel yang sama seperti `.env.local` (Supabase wajib, TURN disarankan).
4. Deploy. Selesai, tidak ada database atau storage yang perlu disiapkan.

## TURN server (penting untuk jaringan seluler)

STUN gratis dari Google sudah cukup untuk banyak jaringan Wi-Fi rumah. Namun banyak operator seluler di Indonesia memakai CGNAT, dan di jaringan seperti itu koneksi langsung sering gagal. Gejalanya: status berhenti di "Menyambungkan ke pasanganmu…". TURN server menjadi jalur cadangan yang meneruskan video saat koneksi langsung tidak bisa dibuat.

Pilihan gratis untuk mulai:
- **Metered.ca** (Open Relay): daftar, buat app, lalu isi `TURN_CREDENTIALS_URL` dengan endpoint credential dari dashboard.
- **Cloudflare Calls TURN**, atau server sendiri dengan **coturn**.

Kredensial TURN dibaca oleh route `/api/ice` di server, jadi tidak ikut masuk ke bundle JavaScript.

## Hal yang perlu diketahui

- **Project Supabase gratis bisa di-pause** jika tidak dipakai beberapa waktu. Jika booth tiba-tiba gagal terhubung ke Supabase, cek dashboard dan aktifkan lagi project-nya.
- **Satu room untuk dua orang.** Orang ketiga melihat pesan "room penuh". Sesi yang sudah tersambung tidak akan terganggu oleh pendatang baru.
- **Tidak ada yang tersimpan.** Begitu tab ditutup, foto hilang. Pastikan menekan "Unduh strip".
- **Kode room bersifat publik.** Siapa pun yang tahu kodenya bisa masuk selama room belum penuh. Kode acak 6 karakter cukup untuk pemakaian pribadi. Untuk produksi, pertimbangkan channel privat Supabase dengan token.
- **Safari iOS:** suara pasangan kadang baru menyala setelah layar disentuh. Booth akan menampilkan tombol "Ketuk untuk menyalakan suara" bila itu terjadi.

## Ide pengembangan

- Lebih banyak bingkai (stiker, tema ulang tahun/anniversary) di `src/lib/strip.ts`.
- Layout strip vertikal klasik (2×6 inci) untuk dicetak.
- Rekam GIF/boomerang dari beberapa frame tiap jepretan.
- Mode lebih dari dua orang (perlu topologi mesh atau SFU).
