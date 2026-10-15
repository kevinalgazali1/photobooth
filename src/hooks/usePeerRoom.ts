"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { isKeyedRoomId, loadHostKey, signHostProof, verifyHostClaim, type HostKey } from "@/lib/host";
import { getSupabase } from "@/lib/supabase";
import { createReceiver, sendBlob, type BlobKind, type PhotoMeta } from "@/lib/transfer";
import {
  DEFAULT_CAPACITY,
  MAX_CAPACITY,
  parseCapacity,
  type BoothMessage,
  type ConnectionStatus,
  type SignalEnvelope,
  type SignalPayload,
} from "@/lib/types";

type Handlers = {
  onMessage: (from: string, message: BoothMessage) => void;
  onPhoto: (from: string, index: number, blob: Blob, kind: BlobKind) => void;
  /** Data channel ke `peerId` baru terbuka (tempat yang pas untuk mengirim pengaturan). */
  onChannelOpen: (peerId: string) => void;
  /** Kunci host termuat (browser ini pembuat room), sebelum masuk ke channel. */
  onHostKey?: () => void;
};

type PresenceMeta = {
  id: string;
  joinedAt: number;
  capacity?: number;
  admitted: boolean;
  /** Hanya pada host: public key (JWK) dan tanda tangan atas `<roomId>:<id>:<joinedAt>`. */
  hostPublicKey?: JsonWebKey;
  hostProof?: string;
};

/** Ringkasan satu peer untuk UI. */
export type PeerView = { id: string; stream: MediaStream | null; connected: boolean; channelOpen: boolean };

/** State per pasangan (aku ↔ peer) di topologi mesh. */
type Peer = {
  id: string;
  pc: RTCPeerConnection;
  /** Yang id-nya lebih kecil membuat offer. */
  initiator: boolean;
  dc: RTCDataChannel | null;
  /** Kandidat ICE masuk yang menunggu remote description. */
  pendingRemote: RTCIceCandidateInit[];
  /** Kandidat ICE keluar yang menunggu dikirim per batch. */
  outgoing: RTCIceCandidateInit[];
  flushTimer: ReturnType<typeof setTimeout> | null;
  stream: MediaStream | null;
  connected: boolean;
  /** Sudah pernah terlihat di presence (supaya peer yang offer-nya datang lebih dulu tidak langsung ditutup). */
  seen: boolean;
  /** Antrean kirim foto, agar potongan dua foto tidak tercampur di satu data channel. */
  sendQueue: Promise<void>;
};

type Stage = "media" | "joining" | "admitted" | "full" | "error";

const FALLBACK_ICE: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
/** Waktu tunggu setelah subscribe sebelum menghitung slot, supaya presence anggota lain sudah terlihat. */
const ADMIT_DELAY_MS = 700;
/** Jarak antar pesan broadcast agar burst signaling 8 orang tidak kena rate limit Realtime. */
const SIGNAL_SPACING_MS = 40;
const CANDIDATE_BATCH_MS = 200;
/** Peer yang hilang dari presence tapi koneksinya masih hidup diberi waktu sebentar (mungkin cuma reconnect). */
const LEAVE_GRACE_MS = 4000;

const BITRATE_BUDGET = 1_500_000;
const BITRATE_MIN = 150_000;
const BITRATE_MAX = 1_200_000;

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

const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    facingMode: "user",
    width: { ideal: 1280 },
    height: { ideal: 960 },
    aspectRatio: { ideal: 4 / 3 },
  },
  audio: { echoCancellation: true, noiseSuppression: true },
};

let cameraQueue: Promise<unknown> = Promise.resolve();

/**
 * Permintaan kamera dijalankan satu per satu. Dua getUserMedia yang tumpang tindih
 * (mis. effect yang dipasang dua kali di Strict Mode) bisa membuat yang kedua gagal.
 * Permintaan yang sudah dibatalkan dilewati, dan kamera yang telanjur terbuka langsung dimatikan.
 * Kegagalan sementara (kamera masih dilepas) dicoba lagi sebentar.
 */
function openCamera(isCancelled: () => boolean): Promise<MediaStream | null> {
  const run = cameraQueue.then(async () => {
    for (let attempt = 0; ; attempt++) {
      if (isCancelled()) return null;
      try {
        const stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
        if (isCancelled()) {
          stream.getTracks().forEach((t) => t.stop());
          return null;
        }
        return stream;
      } catch (err) {
        const transient = err instanceof DOMException && ["NotReadableError", "AbortError"].includes(err.name);
        if (!transient || attempt >= 2) throw err;
        await new Promise((r) => setTimeout(r, 600));
      }
    }
  });
  cameraQueue = run.catch(() => undefined);
  return run;
}

const byJoin =(a: { joinedAt: number; id: string }, b: { joinedAt: number; id: string }) =>
  a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Mengatur seluruh koneksi untuk satu room:
 * kamera lokal → Supabase Realtime (presence + signaling) → satu RTCPeerConnection + data channel per teman.
 *
 * @param capacityParam kapasitas dari tautan (`?n=`), null bila masuk lewat kode saja.
 */
export function usePeerRoom(roomId: string, capacityParam: number | null, handlers: Handlers) {
  const [stage, setStage] = useState<Stage>("media");
  const [error, setError] = useState<string | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [myId, setMyId] = useState<string | null>(null);
  const [capacity, setCapacity] = useState<number | null>(null);
  /** Anggota yang sudah admitted (termasuk aku), urut joinedAt lalu id. Sama di semua layar. */
  const [members, setMembers] = useState<string[]>([]);
  const [peers, setPeers] = useState<Record<string, PeerView>>({});
  const [micOn, setMicOn] = useState(true);
  /** Browser ini memegang kunci host untuk room ini. */
  const [amHost, setAmHost] = useState(false);
  /** Peer id host terverifikasi yang sedang ada di room. */
  const [hostId, setHostId] = useState<string | null>(null);
  const [hostSeen, setHostSeen] = useState(false);

  const handlersRef = useRef(handlers);
  const peersRef = useRef<Map<string, Peer>>(new Map());
  const localRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    let cancelled = false;
    const id = crypto.randomUUID();
    const joinedAt = Date.now();
    const peerMap = new Map<string, Peer>();
    peersRef.current = peerMap;

    let channel: RealtimeChannel | null = null;
    let iceServers: RTCIceServer[] = FALLBACK_ICE;
    let admitted = false;
    let admitReady = false;
    let finished = false; // full / unmount
    let roomCapacity: number | null = null;
    let present = new Set<string>();
    let membersKey = "";
    const legacyRoom = !isKeyedRoomId(roomId);
    let hostKey: HostKey | null = null;
    let hostProof: string | null = null;
    let currentHost: string | null = null;
    /** Hasil verifikasi klaim host per (id, joinedAt, proof): true/false, null = sedang diperiksa. */
    const hostChecks = new Map<string, boolean | null>();
    const earlyCandidates = new Map<string, RTCIceCandidateInit[]>();
    const timers = new Set<ReturnType<typeof setTimeout>>();

    const later = (fn: () => void, ms: number) => {
      const t = setTimeout(() => {
        timers.delete(t);
        fn();
      }, ms);
      timers.add(t);
    };

    // ── Signaling keluar (dibatasi lajunya) ─────────────────────
    const outbox: SignalEnvelope[] = [];
    let outboxTimer: ReturnType<typeof setTimeout> | null = null;

    const pumpOutbox = () => {
      const next = outbox.shift();
      if (!next) {
        outboxTimer = null;
        return;
      }
      if (channel) void channel.send({ type: "broadcast", event: "signal", payload: next });
      outboxTimer = setTimeout(pumpOutbox, SIGNAL_SPACING_MS);
    };

    const signal = (to: string, payload: SignalPayload) => {
      outbox.push({ ...payload, from: id, to });
      if (!outboxTimer) pumpOutbox();
    };

    // ── State untuk UI ──────────────────────────────────────────
    const publish = () => {
      if (cancelled) return;
      const views: Record<string, PeerView> = {};
      for (const p of peerMap.values()) {
        views[p.id] = {
          id: p.id,
          stream: p.stream,
          connected: p.connected,
          channelOpen: p.dc?.readyState === "open",
        };
      }
      setPeers(views);
    };

    /** Bitrate video dibagi rata ke semua peer; resolusi kirim diturunkan untuk ≥4 orang. */
    const tuneVideo = () => {
      const count = Math.max(1, peerMap.size);
      const maxBitrate = Math.round(Math.min(BITRATE_MAX, Math.max(BITRATE_MIN, BITRATE_BUDGET / count)));
      const scaleResolutionDownBy = peerMap.size + 1 >= 4 ? 2 : 1;
      for (const p of peerMap.values()) {
        if (p.pc.connectionState !== "connected") continue;
        for (const sender of p.pc.getSenders()) {
          if (sender.track?.kind !== "video") continue;
          const params = sender.getParameters();
          if (!params.encodings?.length) continue;
          params.encodings[0].maxBitrate = maxBitrate;
          params.encodings[0].scaleResolutionDownBy = scaleResolutionDownBy;
          sender.setParameters(params).catch((err) => console.warn("[bitrate]", err));
        }
      }
    };

    // ── Per peer ────────────────────────────────────────────────
    const closePeer = (peerId: string) => {
      const peer = peerMap.get(peerId);
      if (!peer) return;
      peerMap.delete(peerId);
      if (peer.flushTimer) clearTimeout(peer.flushTimer);
      if (peer.dc) {
        peer.dc.onopen = null;
        peer.dc.onclose = null;
        peer.dc.onmessage = null;
      }
      peer.pc.onicecandidate = null;
      peer.pc.ontrack = null;
      peer.pc.onconnectionstatechange = null;
      peer.pc.ondatachannel = null;
      peer.pc.close();
      for (let i = outbox.length - 1; i >= 0; i--) if (outbox[i].to === peerId) outbox.splice(i, 1);
      earlyCandidates.delete(peerId);
      publish();
      tuneVideo();
    };

    /** Tutup peer yang sudah keluar dari presence, kecuali koneksinya masih hidup (beri waktu sebentar). */
    const closeIfGone = (peerId: string) => {
      const peer = peerMap.get(peerId);
      if (!peer || present.has(peerId)) return;
      if (!peer.connected) closePeer(peerId);
      else
        later(() => {
          if (!present.has(peerId)) closePeer(peerId);
        }, LEAVE_GRACE_MS);
    };

    const setupDataChannel = (peer: Peer, dc: RTCDataChannel) => {
      dc.binaryType = "arraybuffer";
      peer.dc = dc;
      const receiver = createReceiver((index, blob, kind) => handlersRef.current.onPhoto(peer.id, index, blob, kind));

      const onOpen = () => {
        publish();
        handlersRef.current.onChannelOpen(peer.id);
      };
      dc.onopen = onOpen;
      dc.onclose = () => {
        if (peer.dc !== dc) return;
        peer.dc = null;
        publish();
        if (!present.has(peer.id)) closePeer(peer.id);
      };
      dc.onmessage = (event) => {
        if (typeof event.data === "string") {
          let message: BoothMessage | PhotoMeta;
          try {
            message = JSON.parse(event.data);
          } catch {
            return;
          }
          if (message.type === "photo-meta") receiver.meta(message);
          else handlersRef.current.onMessage(peer.id, message);
        } else {
          receiver.chunk(event.data as ArrayBuffer);
        }
      };
      if (dc.readyState === "open") onOpen();
    };

    const makeOffer = async (peer: Peer, iceRestart = false) => {
      try {
        const offer = await peer.pc.createOffer({ iceRestart });
        if (peerMap.get(peer.id) !== peer) return;
        await peer.pc.setLocalDescription(offer);
        if (peerMap.get(peer.id) !== peer) return;
        signal(peer.id, { type: "offer", sdp: peer.pc.localDescription!.toJSON() });
      } catch (err) {
        console.error("[offer]", err);
      }
    };

    const createPeer = (otherId: string): Peer => {
      const pc = new RTCPeerConnection({ iceServers });
      const peer: Peer = {
        id: otherId,
        pc,
        // Deterministik, jadi tidak ada tabrakan offer di pasangan mana pun.
        initiator: id < otherId,
        dc: null,
        pendingRemote: earlyCandidates.get(otherId) ?? [],
        outgoing: [],
        flushTimer: null,
        stream: null,
        connected: false,
        seen: false,
        sendQueue: Promise.resolve(),
      };
      earlyCandidates.delete(otherId);
      peerMap.set(otherId, peer);

      const local = localRef.current;
      local?.getTracks().forEach((track) => pc.addTrack(track, local));

      pc.ontrack = (event) => {
        const stream = event.streams[0];
        if (stream) peer.stream = stream;
        else {
          peer.stream ??= new MediaStream();
          peer.stream.addTrack(event.track);
        }
        publish();
      };
      // Kandidat ICE dikumpulkan lalu dikirim per batch supaya tidak kena rate limit Realtime.
      pc.onicecandidate = (event) => {
        if (!event.candidate) return;
        peer.outgoing.push(event.candidate.toJSON());
        if (peer.flushTimer) return;
        peer.flushTimer = setTimeout(() => {
          peer.flushTimer = null;
          if (peerMap.get(otherId) !== peer || peer.outgoing.length === 0) return;
          signal(otherId, { type: "candidates", candidates: peer.outgoing });
          peer.outgoing = [];
        }, CANDIDATE_BATCH_MS);
      };
      pc.onconnectionstatechange = () => {
        if (peerMap.get(otherId) !== peer) return;
        const state = pc.connectionState;
        if (state === "connected") {
          peer.connected = true;
          tuneVideo();
        } else if (state === "failed") {
          peer.connected = false;
          if (!present.has(otherId)) return closePeer(otherId);
          if (peer.initiator) void makeOffer(peer, true); // coba ICE restart
        } else if (state === "disconnected" || state === "closed") {
          peer.connected = false;
          if (!present.has(otherId)) return closePeer(otherId);
        }
        publish();
      };

      if (peer.initiator) setupDataChannel(peer, pc.createDataChannel("booth", { ordered: true }));
      else pc.ondatachannel = (event) => setupDataChannel(peer, event.channel);

      return peer;
    };

    const drainCandidates = async (peer: Peer) => {
      if (!peer.pc.remoteDescription) return;
      const list = peer.pendingRemote;
      peer.pendingRemote = [];
      for (const candidate of list) {
        try {
          await peer.pc.addIceCandidate(candidate);
        } catch {
          /* kandidat usang, abaikan */
        }
      }
    };

    const onSignal = async (msg: SignalEnvelope) => {
      if (!admitted || msg.from === id || msg.to !== id) return;
      let peer = peerMap.get(msg.from);

      try {
        if (msg.type === "offer") {
          if (!peer) {
            // Offer bisa datang sebelum presence pengirimnya terlihat di sini.
            if (peerMap.size >= MAX_CAPACITY - 1) return;
            peer = createPeer(msg.from);
            publish();
          }
          if (peer.initiator) return; // aku yang seharusnya membuat offer
          await peer.pc.setRemoteDescription(msg.sdp);
          const answer = await peer.pc.createAnswer();
          await peer.pc.setLocalDescription(answer);
          if (peerMap.get(msg.from) !== peer) return;
          signal(msg.from, { type: "answer", sdp: peer.pc.localDescription!.toJSON() });
          await drainCandidates(peer);
        } else if (msg.type === "answer") {
          if (!peer?.initiator || peer.pc.signalingState !== "have-local-offer") return;
          await peer.pc.setRemoteDescription(msg.sdp);
          await drainCandidates(peer);
        } else if (msg.type === "candidates") {
          if (!peer) {
            const list = earlyCandidates.get(msg.from) ?? [];
            if (list.length < 100) list.push(...msg.candidates);
            earlyCandidates.set(msg.from, list);
            return;
          }
          peer.pendingRemote.push(...msg.candidates);
          await drainCandidates(peer);
        }
      } catch (err) {
        console.error("[signaling]", err);
      }
    };

    // ── Presence & penerimaan anggota ───────────────────────────
    const leaveChannel = () => {
      if (!channel) return;
      const ch = channel;
      channel = null;
      void getSupabase().removeChannel(ch);
    };

    const readPresence = (): PresenceMeta[] => {
      if (!channel) return [];
      const state = channel.presenceState<PresenceMeta>();
      const byId = new Map<string, PresenceMeta>();
      for (const p of Object.values(state).flat()) {
        if (typeof p.id !== "string") continue;
        const prev = byId.get(p.id);
        byId.set(p.id, {
          id: p.id,
          joinedAt: Number(p.joinedAt) || 0,
          capacity: parseCapacity(p.capacity) ?? prev?.capacity,
          // Status admitted bersifat permanen.
          admitted: p.admitted === true || prev?.admitted === true,
          hostPublicKey: p.hostPublicKey ?? prev?.hostPublicKey,
          hostProof: p.hostProof ?? prev?.hostProof,
        });
      }
      return [...byId.values()].sort(byJoin);
    };

    /** Metadata presence-ku; host menambahkan public key + bukti tanda tangan. */
    const myMeta = (isAdmitted: boolean, cap: number | null): PresenceMeta => ({
      id,
      joinedAt,
      capacity: cap ?? undefined,
      admitted: isAdmitted,
      ...(hostKey && hostProof ? { hostPublicKey: hostKey.publicJwk, hostProof } : {}),
    });

    /**
     * Status klaim host seseorang: true = terverifikasi, false = bukan host / klaim palsu,
     * null = sedang diverifikasi (hasilnya memicu handlePresence lagi).
     */
    const hostStatus = (m: PresenceMeta): boolean | null => {
      if (legacyRoom || !m.hostProof) return false;
      const key = `${m.id}|${m.joinedAt}|${m.hostProof}`;
      if (!hostChecks.has(key)) {
        hostChecks.set(key, null);
        void verifyHostClaim(roomId, m).then((ok) => {
          hostChecks.set(key, ok);
          if (!ok) console.warn("[host] klaim host tidak valid diabaikan", m.id);
          handlePresence();
        });
      }
      return hostChecks.get(key) ?? null;
    };

    /** Host = anggota terverifikasi yang paling baru masuk (host yang refresh langsung mengambil alih). */
    const updateHost = (all: PresenceMeta[]) => {
      const verified = all.filter((m) => hostStatus(m) === true);
      const next = verified.length ? verified[verified.length - 1].id : null;
      if (next === currentHost) return;
      currentHost = next;
      setHostId(next);
      if (next) setHostSeen(true);
    };

    const becomeFull = (cap: number) => {
      finished = true;
      roomCapacity = cap;
      setCapacity(cap);
      setStage("full");
      for (const peerId of [...peerMap.keys()]) closePeer(peerId);
      leaveChannel();
      localRef.current?.getTracks().forEach((t) => t.stop());
    };

    /**
     * Pendatang baru menghitung slot sisa = kapasitas − anggota lain yang sudah admitted.
     * Pendatang yang bersamaan diurutkan berdasarkan joinedAt lalu id, jadi semua sepakat siapa yang masuk.
     * Di room berkunci satu kursi selalu disisakan untuk host, jadi host yang kembali tidak pernah ditolak.
     */
    const tryAdmit = (all: PresenceMeta[]) => {
      if (admitted || finished || !admitReady || !channel) return;
      const others = all.filter((m) => m.id !== id);
      const admittedOthers = others.filter((m) => m.admitted);
      const cap =
        admittedOthers.find((m) => m.capacity)?.capacity ??
        capacityParam ??
        others.find((m) => m.capacity)?.capacity ??
        DEFAULT_CAPACITY;

      if (!hostKey) {
        // Klaim yang masih diverifikasi dihitung sebagai host (paling lama beberapa milidetik).
        const isHostLike = (m: PresenceMeta) => hostStatus(m) !== false;
        const reserved = legacyRoom ? 0 : 1;
        const slots = cap - reserved - admittedOthers.filter((m) => !isHostLike(m)).length;
        const pending = all.filter((m) => m.id === id || (!m.admitted && !isHostLike(m)));
        const rank = pending.findIndex((m) => m.id === id);
        if (rank === -1) return; // presence-ku belum terlihat, tunggu sync berikutnya
        if (rank >= slots) {
          becomeFull(cap);
          return;
        }
      }
      admitted = true;
      roomCapacity = cap;
      setCapacity(cap);
      setStage("admitted");
      void channel.track(myMeta(true, cap));
    };

    const syncPeers = (all: PresenceMeta[]) => {
      if (!admitted || finished) return;
      const list = all.filter((m) => m.admitted && m.id !== id);
      const ordered = [...list, { id, joinedAt }].sort(byJoin).map((m) => m.id);
      const key = ordered.join(",");
      if (key !== membersKey) {
        membersKey = key;
        setMembers(ordered);
      }

      if (roomCapacity !== 1) {
        for (const m of list) {
          const existing = peerMap.get(m.id);
          if (existing) {
            existing.seen = true;
            continue;
          }
          const peer = createPeer(m.id);
          peer.seen = true;
          if (peer.initiator) void makeOffer(peer);
        }
      }
      for (const peer of [...peerMap.values()]) if (peer.seen) closeIfGone(peer.id);
      publish();
      tuneVideo();
    };

    const handlePresence = () => {
      if (!channel || finished) return;
      const all = readPresence();
      present = new Set(all.map((m) => m.id));
      updateHost(all);
      tryAdmit(all);
      syncPeers(all);
    };

    (async () => {
      try {
        setMyId(id);
        setStage("media");
        const stream = await openCamera(() => cancelled);
        if (!stream || cancelled) {
          stream?.getTracks().forEach((t) => t.stop());
          return;
        }
        localRef.current = stream;
        setLocalStream(stream);

        setStage("joining");
        try {
          const res = await fetch("/api/ice", { cache: "no-store" });
          const data = (await res.json()) as { iceServers?: RTCIceServer[] };
          if (data.iceServers?.length) iceServers = data.iceServers;
        } catch {
          /* tetap jalan dengan STUN publik */
        }
        if (cancelled) return;

        // Browser pembuat room menyimpan kunci host di localStorage, jadi tetap host setelah refresh.
        hostKey = await loadHostKey(roomId);
        if (hostKey) hostProof = await signHostProof(hostKey, roomId, id, joinedAt);
        if (cancelled) return;
        setAmHost(!!hostKey);
        if (hostKey) handlersRef.current.onHostKey?.();

        const supabase = getSupabase();
        const ch = supabase.channel(`photobooth:${roomId}`, {
          config: {
            broadcast: { self: false },
            presence: { key: id },
          },
        });
        channel = ch;

        ch.on("broadcast", { event: "signal" }, ({ payload }) => {
          void onSignal(payload as SignalEnvelope);
        })
          .on("presence", { event: "sync" }, handlePresence)
          .subscribe(async (subStatus) => {
            if (cancelled || finished) return;
            if (subStatus === "SUBSCRIBED") {
              await ch.track(admitted ? myMeta(true, roomCapacity) : myMeta(false, capacityParam));
              if (!admitted && !admitReady) {
                later(() => {
                  admitReady = true;
                  handlePresence();
                }, ADMIT_DELAY_MS);
              }
            } else if (subStatus === "CHANNEL_ERROR" || subStatus === "TIMED_OUT") {
              if (admitted) return; // sudah masuk: koneksi peer tetap jalan, Realtime akan mencoba lagi
              setError("Gagal terhubung ke Supabase Realtime. Cek URL/key dan pengaturan Realtime.");
              setStage("error");
            }
          });
      } catch (err) {
        if (cancelled) return;
        setError(describeMediaError(err));
        setStage("error");
      }
    })();

    const onPageHide = () => {
      void channel?.untrack();
    };
    window.addEventListener("pagehide", onPageHide);

    return () => {
      cancelled = true;
      finished = true;
      window.removeEventListener("pagehide", onPageHide);
      timers.forEach(clearTimeout);
      if (outboxTimer) clearTimeout(outboxTimer);
      for (const peerId of [...peerMap.keys()]) closePeer(peerId);
      leaveChannel();
      localRef.current?.getTracks().forEach((t) => t.stop());
      localRef.current = null;
      setLocalStream(null);
    };
  }, [roomId, capacityParam]);

  const send = useCallback((message: BoothMessage) => {
    const data = JSON.stringify(message);
    for (const peer of peersRef.current.values()) {
      if (peer.dc?.readyState === "open") peer.dc.send(data);
    }
  }, []);

  const sendTo = useCallback((peerId: string, message: BoothMessage) => {
    const dc = peersRef.current.get(peerId)?.dc;
    if (dc?.readyState === "open") dc.send(JSON.stringify(message));
  }, []);

  /** Foto (atau maskernya) dikirim ke semua teman; tiap data channel punya antreannya sendiri. */
  const sendPhoto = useCallback((index: number, blob: Blob, kind: BlobKind = "photo") => {
    for (const peer of peersRef.current.values()) {
      peer.sendQueue = peer.sendQueue
        .then(() => (peer.dc ? sendBlob(peer.dc, index, blob, kind) : undefined))
        .catch((err) => console.error("[sendPhoto]", err));
    }
  }, []);

  const toggleMic = useCallback(() => {
    const tracks = localRef.current?.getAudioTracks() ?? [];
    const next = !tracks.some((t) => t.enabled);
    tracks.forEach((t) => (t.enabled = next));
    setMicOn(next);
  }, []);

  const peerList = Object.values(peers);
  let status: ConnectionStatus;
  if (stage !== "admitted") status = stage;
  else if (capacity === 1) status = "solo";
  else if (members.length <= 1) status = "waiting";
  else if (peerList.some((p) => p.connected)) status = "connected";
  else status = "connecting";

  return {
    status,
    error,
    myId,
    capacity,
    members,
    /** Room format lama (tanpa kunci host): semua orang memegang kendali. */
    legacyRoom: !isKeyedRoomId(roomId),
    amHost,
    hostId,
    hostSeen,
    peers,
    openCount: peerList.filter((p) => p.channelOpen).length,
    localStream,
    micOn,
    send,
    sendTo,
    sendPhoto,
    toggleMic,
  };
}
