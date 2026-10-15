/** Kode room baru dibuat dari kunci host, lihat `src/lib/host.ts`. */
export function normalizeRoomCode(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[?#].*$/, "") // buang ?n=… dan #…
    .replace(/^.*\/room\//, "") // boleh tempel tautan lengkap
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 32);
}
