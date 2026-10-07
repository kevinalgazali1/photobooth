const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // tanpa huruf/angka yang mirip (l, 1, o, 0, i)

export function generateRoomCode(length = 6): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

export function normalizeRoomCode(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^.*\/room\//, "") // boleh tempel tautan lengkap
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 32);
}
