export type FrameId = "paper" | "ink" | "rose" | "sage" | "sky";
export type FilterId = "none" | "bw" | "vintage" | "warm";

export type BoothSettings = {
  frame: FrameId;
  filter: FilterId;
  shots: number;
  caption: string;
};

/** Pesan aplikasi yang dikirim lewat data channel WebRTC. */
export type BoothMessage =
  | { type: "settings"; settings: BoothSettings }
  | { type: "start"; shots: number }
  | { type: "reset" };

/** Pesan signaling yang dikirim lewat Supabase Realtime Broadcast. */
export type SignalPayload =
  | { type: "offer"; sdp: RTCSessionDescriptionInit }
  | { type: "answer"; sdp: RTCSessionDescriptionInit }
  | { type: "candidates"; candidates: RTCIceCandidateInit[] };

export type SignalEnvelope = SignalPayload & { from: string; to: string | null };

export type ConnectionStatus =
  | "media" // meminta izin kamera
  | "joining" // menghubungkan ke Supabase
  | "waiting" // menunggu pasangan masuk
  | "connecting" // negosiasi WebRTC
  | "connected"
  | "full"
  | "error";
