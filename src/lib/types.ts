import type { ResultFormat } from "./layout";

/** Id bingkai, lihat `src/lib/frames.ts`. */
export type FrameId = string;
export type FilterId = "none" | "bw" | "vintage" | "warm";

/** Pengaturan booth. Hanya host yang mengubahnya; peserta lain menerima salinannya. */
export type BoothSettings = {
  frame: FrameId;
  filter: FilterId;
  shots: number;
  caption: string;
  /** "strip": semua jepretan dalam satu gambar. "single": satu gambar per jepretan. */
  format: ResultFormat;
  /** Background pengganti (`src/lib/backgrounds.ts`), atau "none" untuk latar asli. */
  background: string;
};

/**
 * Pesan aplikasi yang dikirim lewat data channel WebRTC.
 * `settings`, `start`, dan `reset` hanya diproses bila datang dari data channel milik host terverifikasi.
 */
export type BoothMessage =
  | { type: "settings"; settings: BoothSettings }
  /** `order`: id peserta sesuai urutan di strip, sama untuk semua orang. */
  | { type: "start"; shots: number; order: string[] }
  | { type: "reset" }
  /** Peserta meminta host mengirim ulang pengaturan (mis. setelah host baru terverifikasi). */
  | { type: "sync" };

/** Pesan signaling yang dikirim lewat Supabase Realtime Broadcast. */
export type SignalPayload =
  | { type: "offer"; sdp: RTCSessionDescriptionInit }
  | { type: "answer"; sdp: RTCSessionDescriptionInit }
  | { type: "candidates"; candidates: RTCIceCandidateInit[] };

/** Di topologi mesh setiap pesan signaling ditujukan ke satu peer tertentu. */
export type SignalEnvelope = SignalPayload & { from: string; to: string };

export type ConnectionStatus =
  | "media" // meminta izin kamera
  | "joining" // menghubungkan ke Supabase dan menunggu giliran masuk
  | "solo" // room untuk 1 orang
  | "waiting" // sudah masuk, belum ada teman lain
  | "connecting" // ada teman, negosiasi WebRTC belum selesai
  | "connected" // minimal satu teman tersambung
  | "full"
  | "error";

export const MIN_CAPACITY = 1;
export const MAX_CAPACITY = 8;
export const DEFAULT_CAPACITY = 2;

export function parseCapacity(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(n) || n < MIN_CAPACITY || n > MAX_CAPACITY) return null;
  return n;
}
