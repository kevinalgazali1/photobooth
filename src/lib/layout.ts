/**
 * Susunan satu jepretan (panel) untuk N orang. Dipakai oleh grid kamera live DAN canvas strip,
 * supaya yang terlihat saat foto sama persis dengan hasilnya.
 *
 * Slot terisi berurutan dari kiri atas. Slot sisa (kanan bawah) menjadi tile hiasan.
 */

export type GridLayout = {
  cols: number;
  rows: number;
  /** Rasio lebar/tinggi sel: 4:3 untuk N ≤ 2, 1:1 untuk N ≥ 3. */
  aspect: number;
  /** Jumlah tile hiasan di akhir grid. */
  decorSlots: number;
  /** cols × rows */
  slots: number;
  /**
   * Tanpa celah antar sel. Untuk 2 orang kedua foto menempel, jadi satu panel terlihat
   * seperti satu ruangan (apalagi dengan background pengganti yang menyambung).
   */
  seamless: boolean;
};

const GRID: Record<number, [cols: number, rows: number]> = {
  1: [1, 1],
  2: [2, 1],
  3: [3, 1],
  4: [2, 2],
  5: [3, 2],
  6: [3, 2],
  7: [4, 2],
  8: [4, 2],
};

export function getLayout(people: number): GridLayout {
  const n = Math.min(8, Math.max(1, Math.round(people) || 1));
  const [cols, rows] = GRID[n];
  const slots = cols * rows;
  return { cols, rows, aspect: n <= 2 ? 4 / 3 : 1, decorSlots: slots - n, slots, seamless: n === 2 };
}

export type ResultFormat = "strip" | "single";

/** Bawaan berdasarkan jumlah orang; host tetap bisa mengubahnya. */
export function defaultShotsFor(people: number): number {
  if (people <= 2) return 4;
  if (people <= 4) return 3;
  return 2;
}

export function defaultFormatFor(people: number): ResultFormat {
  return people <= 4 ? "strip" : "single";
}
