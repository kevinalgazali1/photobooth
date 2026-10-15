/**
 * Identitas pembuat room (host) tanpa database, memakai Web Crypto.
 *
 * - Pembuat room membuat pasangan kunci ECDSA P-256. Room id = 10 karakter pertama dari
 *   SHA-256(public key), jadi room id sekaligus "sidik jari" kunci host.
 * - Host menaruh public key + tanda tangan atas `<roomId>:<peerId>:<joinedAt>` di presence.
 * - Peserta lain hanya menganggap seseorang host bila hash public key-nya cocok dengan room id
 *   DAN tanda tangannya valid untuk peerId orang itu.
 *
 * File ini sengaja tidak memakai alias `@/` supaya bisa diuji langsung dengan `node --test`.
 */

/** Tanpa karakter yang mirip (l, 1, o, 0, i). */
export const ROOM_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const KEYED_ROOM_LENGTH = 10;

const KEY_ALGO: EcKeyGenParams = { name: "ECDSA", namedCurve: "P-256" };
const SIGN_ALGO: EcdsaParams = { name: "ECDSA", hash: "SHA-256" };
const STORAGE_PREFIX = "host:";
const KEYED_ROOM_RE = new RegExp(`^[${ROOM_ALPHABET}]{${KEYED_ROOM_LENGTH}}$`);

export type HostKey = { privateKey: CryptoKey; publicJwk: JsonWebKey };

/** Data host yang ditaruh di presence meta. */
export type HostClaim = {
  id: string;
  joinedAt: number;
  hostPublicKey?: unknown;
  hostProof?: unknown;
};

/** Room dengan format lama (tanpa kunci host) tetap bisa dibuka, tapi semua orang memegang kendali. */
export function isKeyedRoomId(roomId: string): boolean {
  return KEYED_ROOM_RE.test(roomId);
}

export function publicPart(jwk: JsonWebKey): JsonWebKey {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}

/** Bentuk baku public key supaya hash-nya sama di semua browser. */
function canonicalPublicKey(jwk: JsonWebKey): string {
  return JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
}

export async function roomIdFromPublicKey(jwk: JsonWebKey): Promise<string> {
  const data = new TextEncoder().encode(canonicalPublicKey(jwk));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(digest.slice(0, KEYED_ROOM_LENGTH), (b) => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join("");
}

export function proofMessage(roomId: string, peerId: string, joinedAt: number): string {
  return `${roomId}:${peerId}:${joinedAt}`;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Membuat kunci host baru dan room id yang terikat padanya. */
export async function createHostKey(): Promise<{ roomId: string; privateJwk: JsonWebKey }> {
  const pair = await crypto.subtle.generateKey(KEY_ALGO, true, ["sign", "verify"]);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { roomId: await roomIdFromPublicKey(privateJwk), privateJwk };
}

/** Memuat kunci host; null bila kunci rusak atau bukan milik room ini. */
export async function importHostKey(roomId: string, privateJwk: JsonWebKey | null): Promise<HostKey | null> {
  if (!privateJwk?.d || !isKeyedRoomId(roomId)) return null;
  try {
    if ((await roomIdFromPublicKey(privateJwk)) !== roomId) return null;
    const privateKey = await crypto.subtle.importKey("jwk", { ...privateJwk, key_ops: ["sign"] }, KEY_ALGO, false, [
      "sign",
    ]);
    return { privateKey, publicJwk: publicPart(privateJwk) };
  } catch {
    return null;
  }
}

export async function signHostProof(key: HostKey, roomId: string, peerId: string, joinedAt: number): Promise<string> {
  const data = new TextEncoder().encode(proofMessage(roomId, peerId, joinedAt));
  const signature = await crypto.subtle.sign(SIGN_ALGO, key.privateKey, data);
  return toBase64Url(new Uint8Array(signature));
}

/** True hanya bila public key cocok dengan room id DAN tanda tangan valid untuk peerId + joinedAt pengklaim. */
export async function verifyHostClaim(roomId: string, claim: HostClaim): Promise<boolean> {
  try {
    if (!isKeyedRoomId(roomId)) return false;
    const jwk = claim.hostPublicKey as JsonWebKey | undefined;
    if (!jwk || typeof jwk !== "object" || typeof claim.hostProof !== "string") return false;
    if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") return false;
    if ((await roomIdFromPublicKey(jwk)) !== roomId) return false;
    const publicKey = await crypto.subtle.importKey("jwk", publicPart(jwk), KEY_ALGO, false, ["verify"]);
    const data = new TextEncoder().encode(proofMessage(roomId, claim.id, claim.joinedAt));
    return await crypto.subtle.verify(SIGN_ALGO, publicKey, fromBase64Url(claim.hostProof), data);
  } catch {
    return false;
  }
}

/**
 * Pesan kendali (`settings`, `start`, `reset`) hanya diterima dari host terverifikasi.
 * `from` adalah peer id pemilik data channel asal pesan, bukan isi pesan.
 * Di room format lama semua orang memegang kendali.
 */
export function acceptsControlMessage(from: string, hostId: string | null, legacyRoom: boolean): boolean {
  if (legacyRoom) return true;
  return hostId !== null && from === hostId;
}

// ── localStorage (selalu dibungkus try/catch: bisa diblokir di mode privat) ──

/** Cadangan bila localStorage diblokir: tetap host selama tab tidak di-refresh. */
const memoryKeys = new Map<string, JsonWebKey>();

/** False bila kunci hanya tersimpan di memori (host hilang setelah refresh). */
export function saveHostKey(roomId: string, privateJwk: JsonWebKey): boolean {
  memoryKeys.set(roomId, privateJwk);
  try {
    localStorage.setItem(STORAGE_PREFIX + roomId, JSON.stringify(privateJwk));
    return true;
  } catch {
    return false;
  }
}

export function readHostKey(roomId: string): JsonWebKey | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + roomId);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (parsed && typeof parsed === "object") return parsed as JsonWebKey;
  } catch {
    /* pakai cadangan di memori */
  }
  return memoryKeys.get(roomId) ?? null;
}

/** Pengaturan terakhir host, supaya tidak kembali ke bawaan setelah refresh. */
export function saveHostSettings(roomId: string, settings: unknown) {
  try {
    localStorage.setItem(`host-settings:${roomId}`, JSON.stringify(settings));
  } catch {
    /* tidak masalah: pengaturan kembali ke bawaan setelah refresh */
  }
}

export function readHostSettings(roomId: string): unknown {
  try {
    const raw = localStorage.getItem(`host-settings:${roomId}`);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

/** Memuat kunci host untuk room ini dari localStorage, bila browser ini pembuatnya. */
export async function loadHostKey(roomId: string): Promise<HostKey | null> {
  return importHostKey(roomId, readHostKey(roomId));
}
