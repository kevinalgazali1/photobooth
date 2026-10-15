/**
 * Background pengganti. Setiap gambar membentang di seluruh area foto satu panel
 * (untuk 2 orang: dua foto 4:3 berdampingan = 8:3), jadi pemandangannya menyambung
 * dari foto kiri ke kanan dan semua orang terlihat berada di tempat yang sama.
 *
 * Menambah background: simpan SVG/PNG/JPG rasio ±8:3 di `public/backgrounds/`, lalu daftarkan di sini.
 * Untuk SVG, hindari teks (font tiap perangkat bisa berbeda).
 */

export type BackgroundDef = { id: string; label: string; src: string };

export const NO_BACKGROUND = "none";

export const BACKGROUND_LIST: BackgroundDef[] = [
  { id: "studio", label: "Studio", src: "/backgrounds/studio.svg" },
  { id: "ruang-tamu", label: "Ruang tamu", src: "/backgrounds/ruang-tamu.svg" },
  { id: "kafe", label: "Kafe", src: "/backgrounds/kafe.svg" },
  { id: "pantai", label: "Pantai", src: "/backgrounds/pantai.svg" },
  { id: "senja-kota", label: "Senja kota", src: "/backgrounds/senja-kota.svg" },
];

export const BACKGROUNDS: Record<string, BackgroundDef> = Object.fromEntries(BACKGROUND_LIST.map((b) => [b.id, b]));

export function getBackground(id: string | undefined): BackgroundDef | null {
  return id && id !== NO_BACKGROUND ? (BACKGROUNDS[id] ?? null) : null;
}
