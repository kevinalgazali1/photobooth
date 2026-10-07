"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/supabase";
import { createReceiver, sendBlob, type PhotoMeta } from "@/lib/transfer";
import type {
  BoothMessage,
  ConnectionStatus,
  SignalEnvelope,
  SignalPayload,
} from "@/lib/types";

type Handlers = {
  onMessage: (message: BoothMessage) => void;
  onPhoto: (index: number, blob: Blob) => void;
};

type PresenceMeta = { id: string; joinedAt: number };

const FALLBACK_ICE: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
const MAX_MEMBERS = 2;

function describeMediaError(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError") return "Izin kamera/mikrofon ditolak. Izinkan lewat pengaturan browser lalu muat ulang.";
    if (err.name === "NotFoundError") return "Kamera atau mikrofon tidak ditemukan.";
    if (err.name === "NotReadableError") return "Kamera sedang dipakai aplikasi lain.";
  }
  if (typeof window !== "undefined" && !window.isSecureContext) {
    return "Kamera hanya bisa diakses lewat HTTPS (atau localhost).";
  }
  return err instanceof Error ? err.message : "Terjadi kesalahan yang tidak diketahui.";
}

/**
 * Mengatur seluruh koneksi untuk satu room:
 * kamera lokal → Supabase Realtime (presence + signaling) → RTCPeerConnection + data channel.
 */
export function usePeerRoom(roomId: string, handlers: Handlers) {
  const [status, setStatus] = useState<ConnectionStatus>("media");
  const [error, setError] = useState<string | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [isInitiator, setIsInitiator] = useState(false);
  const [channelOpen, setChannelOpen] = useState(false);
  const [micOn, setMicOn] = useState(true);

  const handlersRef = useRef(handlers);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const localRef = useRef<MediaStream | null>(null);
  const sendQueueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    let cancelled = false;
    const myId = crypto.randomUUID();

    let channel: RealtimeChannel | null = null;
    let pc: RTCPeerConnection | null = null;
    let peerId: string | null = null;
    let connected = false;
    let iceServers: RTCIceServer[] = FALLBACK_ICE;
    let pendingRemote: RTCIceCandidateInit[] = [];
    let outgoing: RTCIceCandidateInit[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const signal = (payload: SignalPayload) => {
      if (!channel) return;
      const envelope: SignalEnvelope = { ...payload, from: myId, to: peerId };
      void channel.send({ type: "broadcast", event: "signal", payload: envelope });
    };

    // Kandidat ICE dikumpulkan lalu dikirim per batch supaya tidak kena rate limit Realtime.
    const flushCandidates = () => {
      flushTimer = null;
      if (outgoing.length === 0) return;
      signal({ type: "candidates", candidates: outgoing });
      outgoing = [];
    };

    const setupDataChannel = (dc: RTCDataChannel) => {
      dc.binaryType = "arraybuffer";
      dcRef.current = dc;
      const receiver = createReceiver((index, blob) => handlersRef.current.onPhoto(index, blob));

      dc.onopen = () => setChannelOpen(true);
      dc.onclose = () => {
        if (dcRef.current === dc) {
          dcRef.current = null;
          setChannelOpen(false);
        }
      };
      dc.onmessage = (event) => {
        if (typeof event.data === "string") {
          const message = JSON.parse(event.data) as BoothMessage | PhotoMeta;
          if (message.type === "photo-meta") receiver.meta(message);
          else handlersRef.current.onMessage(message);
        } else {
          receiver.chunk(event.data as ArrayBuffer);
        }
      };
      if (dc.readyState === "open") setChannelOpen(true);
    };

    const closePeer = () => {
      if (pc) {
        pc.onicecandidate = null;
        pc.ontrack = null;
        pc.onconnectionstatechange = null;
        pc.ondatachannel = null;
        pc.close();
      }
      pc = null;
      peerId = null;
      connected = false;
      pendingRemote = [];
      outgoing = [];
      dcRef.current = null;
      setChannelOpen(false);
      setRemoteStream(null);
    };

    const makeOffer = async (iceRestart = false) => {
      const conn = pc;
      if (!conn) return;
      const offer = await conn.createOffer({ iceRestart });
      if (conn !== pc) return;
      await conn.setLocalDescription(offer);
      signal({ type: "offer", sdp: conn.localDescription!.toJSON() });
    };

    const createPeer = (otherId: string) => {
      closePeer();
      peerId = otherId;
      // Penentuan siapa yang membuat offer: id yang lebih kecil. Deterministik, jadi tidak ada tabrakan offer.
      const initiator = myId < otherId;
      setIsInitiator(initiator);
      setStatus("connecting");

      const conn = new RTCPeerConnection({ iceServers });
      pc = conn;

      const local = localRef.current;
      local?.getTracks().forEach((track) => conn.addTrack(track, local));

      conn.ontrack = (event) => {
        setRemoteStream(event.streams[0] ?? new MediaStream([event.track]));
      };
      conn.onicecandidate = (event) => {
        if (!event.candidate) return;
        outgoing.push(event.candidate.toJSON());
        if (!flushTimer) flushTimer = setTimeout(flushCandidates, 150);
      };
      conn.onconnectionstatechange = () => {
        const state = conn.connectionState;
        if (state === "connected") {
          connected = true;
          setStatus("connected");
        } else if (state === "failed") {
          connected = false;
          setStatus("connecting");
          if (initiator) void makeOffer(true); // coba ICE restart
        } else if (state === "disconnected") {
          setStatus("connecting");
        }
      };

      if (initiator) setupDataChannel(conn.createDataChannel("booth", { ordered: true }));
      else conn.ondatachannel = (event) => setupDataChannel(event.channel);

      return conn;
    };

    const drainCandidates = async () => {
      const conn = pc;
      if (!conn?.remoteDescription) return;
      const list = pendingRemote;
      pendingRemote = [];
      for (const candidate of list) {
        try {
          await conn.addIceCandidate(candidate);
        } catch {
          /* kandidat usang, abaikan */
        }
      }
    };

    const onSignal = async (msg: SignalEnvelope) => {
      if (msg.from === myId) return;
      if (msg.to && msg.to !== myId) return;
      // Jangan biarkan orang ketiga merusak sesi yang sudah tersambung.
      if (connected && peerId && msg.from !== peerId) return;

      try {
        if (msg.type === "offer") {
          if (!pc || peerId !== msg.from) {
            const early = pendingRemote; // kandidat yang mungkin datang lebih dulu dari offer
            createPeer(msg.from);
            pendingRemote = early;
          }
          const conn = pc!;
          await conn.setRemoteDescription(msg.sdp);
          const answer = await conn.createAnswer();
          await conn.setLocalDescription(answer);
          signal({ type: "answer", sdp: conn.localDescription!.toJSON() });
          await drainCandidates();
        } else if (msg.type === "answer") {
          if (!pc || peerId !== msg.from || pc.signalingState !== "have-local-offer") return;
          await pc.setRemoteDescription(msg.sdp);
          await drainCandidates();
        } else if (msg.type === "candidates") {
          if (peerId && peerId !== msg.from) return;
          pendingRemote.push(...msg.candidates);
          await drainCandidates();
        }
      } catch (err) {
        console.error("[signaling]", err);
      }
    };

    const leaveChannel = () => {
      if (!channel) return;
      const ch = channel;
      channel = null;
      void getSupabase().removeChannel(ch);
    };

    const handlePresence = () => {
      if (!channel) return;
      const state = channel.presenceState<PresenceMeta>();
      const byId = new Map<string, PresenceMeta>();
      Object.values(state)
        .flat()
        .forEach((p) => byId.set(p.id, { id: p.id, joinedAt: p.joinedAt }));
      const members = [...byId.values()].sort(
        (a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id),
      );

      // Sesi yang sudah tersambung dipertahankan selama pasangannya masih ada.
      if (connected && peerId && byId.has(peerId)) return;

      const myIndex = members.findIndex((m) => m.id === myId);
      if (myIndex >= MAX_MEMBERS) {
        closePeer();
        leaveChannel();
        setStatus("full");
        return;
      }

      const other = members.slice(0, MAX_MEMBERS).find((m) => m.id !== myId);
      if (!other) {
        if (pc) closePeer();
        setStatus("waiting");
        return;
      }
      if (pc && peerId === other.id) return;

      createPeer(other.id);
      if (myId < other.id) void makeOffer();
    };

    (async () => {
      try {
        setStatus("media");
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "user",
            width: { ideal: 1280 },
            height: { ideal: 960 },
            aspectRatio: { ideal: 4 / 3 },
          },
          audio: { echoCancellation: true, noiseSuppression: true },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        localRef.current = stream;
        setLocalStream(stream);

        setStatus("joining");
        try {
          const res = await fetch("/api/ice", { cache: "no-store" });
          const data = (await res.json()) as { iceServers?: RTCIceServer[] };
          if (data.iceServers?.length) iceServers = data.iceServers;
        } catch {
          /* tetap jalan dengan STUN publik */
        }
        if (cancelled) return;

        const supabase = getSupabase();
        const ch = supabase.channel(`photobooth:${roomId}`, {
          config: {
            broadcast: { self: false },
            presence: { key: myId },
          },
        });
        channel = ch;

        ch.on("broadcast", { event: "signal" }, ({ payload }) => {
          void onSignal(payload as SignalEnvelope);
        })
          .on("presence", { event: "sync" }, handlePresence)
          .subscribe(async (subStatus) => {
            if (cancelled) return;
            if (subStatus === "SUBSCRIBED") {
              setStatus((s) => (s === "joining" ? "waiting" : s));
              await ch.track({ id: myId, joinedAt: Date.now() } satisfies PresenceMeta);
            } else if (subStatus === "CHANNEL_ERROR" || subStatus === "TIMED_OUT") {
              setError("Gagal terhubung ke Supabase Realtime. Cek URL/key dan pengaturan Realtime.");
              setStatus("error");
            }
          });
      } catch (err) {
        if (cancelled) return;
        setError(describeMediaError(err));
        setStatus("error");
      }
    })();

    const onPageHide = () => {
      void channel?.untrack();
    };
    window.addEventListener("pagehide", onPageHide);

    return () => {
      cancelled = true;
      window.removeEventListener("pagehide", onPageHide);
      if (flushTimer) clearTimeout(flushTimer);
      closePeer();
      leaveChannel();
      localRef.current?.getTracks().forEach((t) => t.stop());
      localRef.current = null;
      setLocalStream(null);
    };
  }, [roomId]);

  const send = useCallback((message: BoothMessage) => {
    const dc = dcRef.current;
    if (dc?.readyState === "open") dc.send(JSON.stringify(message));
  }, []);

  /** Foto dikirim berurutan agar potongan data dua foto tidak tercampur. */
  const sendPhoto = useCallback((index: number, blob: Blob) => {
    sendQueueRef.current = sendQueueRef.current
      .then(() => {
        const dc = dcRef.current;
        return dc ? sendBlob(dc, index, blob) : undefined;
      })
      .catch((err) => console.error("[sendPhoto]", err));
  }, []);

  const toggleMic = useCallback(() => {
    const tracks = localRef.current?.getAudioTracks() ?? [];
    const next = !tracks.some((t) => t.enabled);
    tracks.forEach((t) => (t.enabled = next));
    setMicOn(next);
  }, []);

  return {
    status,
    error,
    localStream,
    remoteStream,
    isInitiator,
    channelOpen,
    micOn,
    send,
    sendPhoto,
    toggleMic,
  };
}
