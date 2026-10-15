"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useBoxSize } from "@/hooks/useBoxSize";
import { usePeerRoom } from "@/hooks/usePeerRoom";
import { BACKGROUND_LIST, BACKGROUNDS, getBackground, NO_BACKGROUND } from "@/lib/backgrounds";
import { captureFrame } from "@/lib/capture";
import { DEFAULT_FRAME_ID, FRAMES, getFrame } from "@/lib/frames";
import { acceptsControlMessage, readHostSettings, saveHostSettings } from "@/lib/host";
import { defaultFormatFor, defaultShotsFor, getLayout, type ResultFormat } from "@/lib/layout";
import { makePersonMask, preloadSegmenter } from "@/lib/segment";
import { composeStrip, FILTERS } from "@/lib/strip";
import type { BlobKind } from "@/lib/transfer";
import {
  DEFAULT_CAPACITY,
  MAX_CAPACITY,
  type BoothMessage,
  type BoothSettings,
  type ConnectionStatus,
  type FilterId,
} from "@/lib/types";
import { DecorTile } from "./DecorTile";
import { FramePicker } from "./FramePicker";
import { ResultGallery, type ResultImage } from "./ResultGallery";
import { VideoTile } from "./VideoTile";

type Phase = "idle" | "shooting" | "review";
type Session = { order: string[]; shots: number };
type Photos = Map<string, (Blob | null)[]>;

const SHOT_OPTIONS = [1, 2, 3, 4];
const FORMATS: Record<ResultFormat, string> = { strip: "Strip", single: "Per jepretan" };
const PHOTO_TIMEOUT_MS = 12_000;
const CAPTION_MAX = 28;
const TILE_GAP = 12;
const STAGE_PAD = 12;

function defaultsFor(people: number): BoothSettings {
  return {
    frame: DEFAULT_FRAME_ID,
    filter: "none",
    shots: defaultShotsFor(people),
    caption: "kita",
    format: defaultFormatFor(people),
    background: NO_BACKGROUND,
  };
}

function statusText(status: ConnectionStatus, canControl: boolean): string {
  const ready = canControl ? "Atur bingkai, lalu mulai foto." : "Menunggu pembuat room memulai foto.";
  const texts: Record<ConnectionStatus, string> = {
    media: "Meminta izin kamera dan mikrofon…",
    joining: "Masuk ke room…",
    solo: `Mode sendiri. ${ready}`,
    waiting: "Belum ada teman yang masuk. Kirim tautan room ini ke mereka.",
    connecting: "Menyambungkan ke teman-temanmu…",
    connected: `Tersambung. ${ready}`,
    full: "",
    error: "",
  };
  return texts[status];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const emptyShots = (n: number) => Array<Blob | null>(n).fill(null);
const hasOwn = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);
const revokeAll = (prev: ResultImage[]) => {
  prev.forEach((r) => URL.revokeObjectURL(r.url));
  return [];
};

function withPhoto(prev: Photos, id: string, index: number, blob: Blob, shots: number): Photos {
  const next = new Map(prev);
  const list = (next.get(id) ?? emptyShots(Math.max(shots, index + 1))).slice();
  list[index] = blob;
  next.set(id, list);
  return next;
}

/** Pengaturan dari host bisa berasal dari versi aplikasi berbeda, jadi diperiksa dulu. */
function sanitizeSettings(value: unknown): BoothSettings | null {
  if (!value || typeof value !== "object") return null;
  const s = value as Partial<Record<keyof BoothSettings, unknown>>;
  if (typeof s.frame !== "string" || !hasOwn(FRAMES, s.frame)) return null;
  if (typeof s.filter !== "string" || !hasOwn(FILTERS, s.filter)) return null;
  const shots = Number(s.shots);
  if (!SHOT_OPTIONS.includes(shots)) return null;
  return {
    frame: s.frame,
    filter: s.filter as FilterId,
    shots,
    caption: String(s.caption ?? "").slice(0, CAPTION_MAX),
    format: s.format === "single" ? "single" : "strip",
    background: typeof s.background === "string" && hasOwn(BACKGROUNDS, s.background) ? s.background : NO_BACKGROUND,
  };
}

/** Semua orang di `order` punya item untuk setiap jepretan. */
function complete(map: Photos, order: string[], shots: number) {
  return order.every((id) => {
    const list = map.get(id);
    return !!list && list.length >= shots && list.slice(0, shots).every(Boolean);
  });
}

export function Booth({ roomId, capacityParam }: { roomId: string; capacityParam: number | null }) {
  /** Pilihan host (atau salinan lengkap dari host); sisanya mengikuti bawaan untuk N orang. */
  const [choices, setChoices] = useState<Partial<BoothSettings>>({});
  const [phase, setPhase] = useState<Phase>("idle");
  const [count, setCount] = useState<number | null>(null);
  const [shotIndex, setShotIndex] = useState(0);
  const [flashKey, setFlashKey] = useState(0);
  const [session, setSession] = useState<Session | null>(null);
  const [photos, setPhotos] = useState<Photos>(() => new Map());
  /** Masker orang per peserta per jepretan, untuk background pengganti. */
  const [masks, setMasks] = useState<Photos>(() => new Map());
  const [timedOut, setTimedOut] = useState(false);
  const [results, setResults] = useState<ResultImage[]>([]);
  const [shareNote, setShareNote] = useState<string | null>(null);

  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const stageBoxRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLElement | null>(null);
  const runningRef = useRef(false);
  const sessionRef = useRef<Session | null>(null);
  /** Masker fotoku yang sedang/sudah dibuat di sesi ini (kunci: indeks jepretan). */
  const maskJobsRef = useRef(new Set<number>());
  const ctxRef = useRef<{
    myId: string | null;
    hostId: string | null;
    legacy: boolean;
    canControl: boolean;
    settings: BoothSettings;
    sendTo: (peerId: string, message: BoothMessage) => void;
    sendPhoto: (index: number, blob: Blob, kind?: BlobKind) => void;
  }>({
    myId: null,
    hostId: null,
    legacy: false,
    canControl: false,
    settings: defaultsFor(DEFAULT_CAPACITY),
    sendTo: () => undefined,
    sendPhoto: () => undefined,
  });

  const box = useBoxSize(stageBoxRef);

  const resetSession = useCallback(() => {
    if (runningRef.current) return;
    sessionRef.current = null;
    setSession(null);
    setPhase("idle");
    setPhotos(new Map());
    setMasks(new Map());
    maskJobsRef.current = new Set();
    setTimedOut(false);
    setResults(revokeAll);
  }, []);

  const runSession = useCallback(async (shots: number, order: string[]) => {
    if (runningRef.current) return;
    runningRef.current = true;
    const next = { shots, order };
    sessionRef.current = next;
    setSession(next);
    setPhotos(new Map(order.map((id) => [id, emptyShots(shots)])));
    setMasks(new Map());
    maskJobsRef.current = new Set();
    setTimedOut(false);
    setResults(revokeAll);
    setPhase("shooting");

    try {
      for (let i = 0; i < shots; i++) {
        setShotIndex(i);
        for (const n of [3, 2, 1]) {
          setCount(n);
          await sleep(1000);
        }
        setCount(null);
        setFlashKey((k) => k + 1);

        // Foto selalu diambil dari kamera lokal dalam resolusi penuh, bukan dari stream WebRTC.
        const video = localVideoRef.current;
        const myId = ctxRef.current.myId;
        if (video && myId) {
          try {
            const blob = await captureFrame(video);
            setPhotos((prev) => withPhoto(prev, myId, i, blob, shots));
            ctxRef.current.sendPhoto(i, blob);
          } catch (err) {
            console.error("[capture]", err);
          }
        }
        await sleep(900);
      }
    } finally {
      runningRef.current = false;
      setCount(null);
      setPhase("review");
    }
  }, []);

  const onMessage = useCallback(
    (from: string, message: BoothMessage) => {
      const ctx = ctxRef.current;
      if (message.type === "sync") {
        // Peserta meminta pengaturan terkini; hanya host yang menjawab.
        if (ctx.canControl) ctx.sendTo(from, { type: "settings", settings: ctx.settings });
        return;
      }
      // Pengirim ditentukan dari data channel asal pesan, bukan dari isi pesan.
      if (!acceptsControlMessage(from, ctx.hostId, ctx.legacy)) {
        console.warn(`[booth] pesan "${message.type}" dari non-host diabaikan`, from);
        return;
      }
      if (message.type === "settings") {
        const incoming = sanitizeSettings(message.settings);
        if (incoming) setChoices(incoming);
      } else if (message.type === "start") {
        const shots = SHOT_OPTIONS.includes(message.shots) ? message.shots : ctx.settings.shots;
        const order = Array.isArray(message.order)
          ? message.order.filter((id): id is string => typeof id === "string").slice(0, MAX_CAPACITY)
          : [];
        if (order.length) void runSession(shots, order);
      } else if (message.type === "reset") {
        resetSession();
      }
    },
    [runSession, resetSession],
  );

  const onPhoto = useCallback((from: string, index: number, blob: Blob, kind: BlobKind) => {
    if (!Number.isInteger(index) || index < 0 || index >= SHOT_OPTIONS.length) return;
    const shots = sessionRef.current?.shots ?? index + 1;
    if (kind === "mask") setMasks((prev) => withPhoto(prev, from, index, blob, shots));
    else setPhotos((prev) => withPhoto(prev, from, index, blob, shots));
  }, []);

  // Host mengirim pengaturan terkini ke setiap data channel yang baru terbuka.
  const onChannelOpen = useCallback((peerId: string) => {
    const ctx = ctxRef.current;
    if (ctx.canControl) ctx.sendTo(peerId, { type: "settings", settings: ctx.settings });
  }, []);

  // Host yang refresh memulihkan pengaturan terakhirnya sebelum data channel ke peserta terbuka.
  const onHostKey = useCallback(() => {
    const saved = sanitizeSettings(readHostSettings(roomId));
    if (saved) setChoices(saved);
  }, [roomId]);

  const room = usePeerRoom(roomId, capacityParam, { onMessage, onPhoto, onChannelOpen, onHostKey });
  const { send, sendTo, sendPhoto } = room;

  const canControl = room.legacyRoom || room.amHost;
  const people = Math.max(room.capacity ?? capacityParam ?? DEFAULT_CAPACITY, 1);
  const settings: BoothSettings = { ...defaultsFor(people), ...choices };

  useEffect(() => {
    ctxRef.current = {
      myId: room.myId,
      hostId: room.hostId,
      legacy: room.legacyRoom,
      canControl,
      settings,
      sendTo: room.sendTo,
      sendPhoto: room.sendPhoto,
    };
  });

  // Peserta meminta pengaturan begitu host terverifikasi dan data channel ke host terbuka,
  // untuk berjaga-jaga bila pengaturan host datang sebelum verifikasi selesai.
  const hostChannelOpen = !!room.hostId && !!room.peers[room.hostId]?.channelOpen;
  useEffect(() => {
    if (!room.amHost && room.hostId && hostChannelOpen) sendTo(room.hostId, { type: "sync" });
  }, [room.amHost, room.hostId, hostChannelOpen, sendTo]);

  // Saat hitung mundur, panggung digulir ke atas supaya semua tile terlihat tanpa scroll.
  useEffect(() => {
    if (phase !== "shooting") return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    stageRef.current?.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
  }, [phase]);

  const background = settings.background;
  const useBackground = !!getBackground(background);

  // Model segmentasi mulai diunduh begitu host memilih background, supaya siap saat memotret.
  useEffect(() => {
    if (useBackground) preloadSegmenter();
  }, [useBackground]);

  // Masker untuk fotoku sendiri dibuat di perangkat ini, lalu dikirim ke semua teman.
  const myPhotos = room.myId ? photos.get(room.myId) : undefined;
  useEffect(() => {
    const myId = room.myId;
    if (!useBackground || !session || phase === "idle" || !myId || !myPhotos) return;
    myPhotos.forEach((photo, index) => {
      if (!photo || maskJobsRef.current.has(index)) return;
      maskJobsRef.current.add(index);
      const jobs = maskJobsRef.current;
      makePersonMask(photo)
        .then((mask) => {
          if (maskJobsRef.current !== jobs) return; // sesi sudah berganti
          setMasks((prev) => withPhoto(prev, myId, index, mask, session.shots));
          sendPhoto(index, mask, "mask");
        })
        .catch((err) => {
          console.error("[segment]", err);
          if (maskJobsRef.current === jobs) jobs.delete(index); // coba lagi saat foto/pengaturan berubah
        });
    });
  }, [useBackground, session, phase, room.myId, myPhotos, sendPhoto]);

  const allArrived =
    !!session &&
    complete(photos, session.order, session.shots) &&
    (!useBackground || complete(masks, session.order, session.shots));

  useEffect(() => {
    if (phase !== "review" || allArrived) return;
    const timer = setTimeout(() => setTimedOut(true), PHOTO_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [phase, allArrived]);

  // Susun ulang hasil setiap kali foto atau pengaturan berubah di tahap review.
  const { frame, filter, caption, format } = settings;
  useEffect(() => {
    if (phase !== "review" || !session || !(allArrived || timedOut)) return;
    let cancelled = false;
    const people = session.order.length;
    const columns = session.order.map((id) => photos.get(id) ?? []);
    const maskColumns = session.order.map((id) => masks.get(id) ?? []);
    const jobs =
      format === "strip"
        ? [
            composeStrip({
              people,
              shots: session.shots,
              photos: columns,
              masks: maskColumns,
              background,
              frame,
              filter,
              caption,
            }).then((blob) => ({
              blob,
              name: `booth-bareng-${roomId}.png`,
              label: "Strip foto kalian",
            })),
          ]
        : Array.from({ length: session.shots }, (_, s) =>
            composeStrip({
              people,
              shots: 1,
              photos: columns.map((list) => [list[s]]),
              masks: maskColumns.map((list) => [list[s]]),
              background,
              frame,
              filter,
              caption,
              shotOffset: s,
              totalShots: session.shots,
            }).then((blob) => ({ blob, name: `booth-bareng-${roomId}-${s + 1}.png`, label: `Foto ${s + 1}` })),
          );

    Promise.all(jobs)
      .then((list) => {
        if (cancelled) return;
        setResults((prev) => {
          prev.forEach((r) => URL.revokeObjectURL(r.url));
          return list.map((r) => ({ ...r, url: URL.createObjectURL(r.blob) }));
        });
      })
      .catch((err) => console.error("[strip]", err));
    return () => {
      cancelled = true;
    };
  }, [phase, session, allArrived, timedOut, photos, masks, background, frame, filter, caption, format, roomId]);

  const updateSettings = (patch: Partial<BoothSettings>) => {
    if (!canControl) return;
    const next = { ...settings, ...patch };
    setChoices(next);
    if (room.amHost) saveHostSettings(roomId, next);
    send({ type: "settings", settings: next });
  };

  const solo = room.status === "solo";
  const canStart = canControl && phase === "idle" && !!room.myId && (solo || room.openCount > 0);

  const start = () => {
    if (!canStart || !room.myId) return;
    // Hanya peserta yang tersambung denganku yang ikut, urutannya sama dengan urutan anggota.
    const order = room.members.filter((id) => id === room.myId || room.peers[id]?.channelOpen);
    if (!order.includes(room.myId)) order.push(room.myId);
    send({ type: "start", shots: settings.shots, order });
    void runSession(settings.shots, order);
  };

  const again = () => {
    if (!canControl) return;
    send({ type: "reset" });
    resetSession();
  };

  const shareLink = async () => {
    const url = window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title: "Booth Bareng", text: "Ayo foto bareng!", url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setShareNote("Tautan disalin");
    } catch {
      setShareNote(url);
    }
  };

  if (room.status === "full") {
    return (
      <Notice
        title="Room ini sudah penuh."
        body={`Room ini untuk ${room.capacity ?? "beberapa"} orang dan semua tempat sudah terisi. Buat room baru untuk berfoto.`}
      />
    );
  }

  if (room.status === "error") {
    return (
      <Notice title="Booth belum bisa dibuka." body={room.error ?? "Coba muat ulang halaman."} reload />
    );
  }

  const theme = getFrame(settings.frame);
  const filterCss = FILTERS[settings.filter].css;
  const shooting = phase === "shooting";

  // ── Grid kamera: susunan sama dengan satu panel hasil (getLayout), ukuran tile dihitung dari viewport ──
  const inSession = !!session && phase !== "idle";
  const tileIds = inSession ? session.order : room.members;
  const slotCount = inSession ? session.order.length : Math.max(people, room.members.length, 1);
  const layout = getLayout(slotCount);
  const portraitPhone = box.viewportWidth > 0 && box.viewportWidth < 640 && box.viewportHeight > box.viewportWidth;
  const liveCols = portraitPhone && slotCount >= 5 ? 2 : layout.cols;
  const liveRows = Math.ceil(layout.slots / liveCols);
  // 2 orang: tile menempel tanpa celah, sama seperti hasilnya.
  const tileGap = layout.seamless && liveCols === layout.cols ? 0 : TILE_GAP;
  const availW = box.width - STAGE_PAD * 2;
  const availH = box.viewportHeight - (shooting ? 24 : 190) - STAGE_PAD * 2;
  const tileWidth =
    box.width > 0
      ? Math.max(
          72,
          Math.floor(
            Math.min(
              (availW - tileGap * (liveCols - 1)) / liveCols,
              ((availH - tileGap * (liveRows - 1)) / liveRows) * layout.aspect,
            ),
          ),
        )
      : 240;
  const shotsForLabel = inSession ? session.shots : settings.shots;
  const decorLabel = `${(shooting ? shotIndex : 0) + 1}/${shotsForLabel}`;

  const localTile = (label: string) => (
    <VideoTile
      key="local"
      stream={room.localStream}
      label={label}
      muted
      filterCss={filterCss}
      videoRef={localVideoRef}
      emptyText="Menyalakan kamera…"
      aspect={layout.aspect}
      style={{ width: tileWidth }}
    />
  );

  const tiles = Array.from({ length: slotCount }, (_, i) => {
    const id = tileIds[i];
    const position = i + 1;
    const isHostTile = !!id && id === room.hostId;
    if (id && id === room.myId) return localTile(isHostTile ? "Kamu · Pembuat room" : "Kamu");
    const peer = id ? room.peers[id] : undefined;
    return (
      <VideoTile
        key={id ?? `slot-${i}`}
        stream={peer?.stream ?? null}
        label={isHostTile ? "Pembuat room" : `Orang ke-${position}`}
        filterCss={filterCss}
        emptyText={id ? (peer ? "Menyambungkan…" : "Terputus") : `Menunggu orang ke-${position}…`}
        aspect={layout.aspect}
        style={{ width: tileWidth }}
      />
    );
  });
  // Kamera lokal harus selalu terpasang supaya bisa dipotret, walau aku belum muncul di daftar anggota.
  if (!tileIds.includes(room.myId ?? "")) {
    tiles[Math.min(tileIds.length, slotCount - 1)] = localTile(room.amHost ? "Kamu · Pembuat room" : "Kamu");
  }
  for (let d = 0; d < layout.decorSlots; d++) {
    tiles.push(
      <DecorTile
        key={`decor-${d}`}
        frameId={settings.frame}
        caption={settings.caption}
        label={decorLabel}
        width={tileWidth}
        aspect={layout.aspect}
      />,
    );
  }

  const joinedText =
    room.capacity && room.capacity > 1 && room.members.length > 0
      ? `${room.members.length} dari ${room.capacity} orang sudah masuk. `
      : "";
  const admitted = !["media", "joining"].includes(room.status);
  const hostGone = !room.legacyRoom && !room.amHost && admitted && room.hostSeen && !room.hostId;
  const hostNotYet = !room.legacyRoom && !room.amHost && admitted && !room.hostSeen;
  const status = hostGone
    ? "Pembuat room keluar. Sesi lanjut saat dia kembali."
    : `${joinedText}${hostNotYet ? "Pembuat room belum masuk." : statusText(room.status, canControl)}`;

  const stripPeople = session?.order.length ?? slotCount;
  const stripShots = inSession ? session.shots : settings.shots;
  const thumbShots = settings.format === "single" ? 1 : stripShots;

  const micButton = (
    <button
      type="button"
      onClick={room.toggleMic}
      disabled={!room.localStream}
      className="rounded-full border-2 border-paper/60 px-5 py-3 text-sm font-bold transition-colors hover:bg-paper hover:text-ink disabled:opacity-40"
    >
      {room.micOn ? "Matikan mikrofon" : "Nyalakan mikrofon"}
    </button>
  );

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-5 px-4 py-5 md:px-8 md:py-7">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/" className="font-display text-2xl font-bold">
          Booth Bareng
        </Link>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-curtain-deep px-4 py-2 font-mono text-sm tracking-wide">{roomId}</span>
          <button
            type="button"
            onClick={shareLink}
            className="rounded-full border-2 border-paper px-4 py-1.5 text-sm font-bold transition-colors hover:bg-paper hover:text-ink"
          >
            Bagikan tautan
          </button>
        </div>
      </header>

      {room.legacyRoom && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border-2 border-flash/70 bg-curtain-deep/70 px-5 py-3">
          <p className="max-w-[60ch] text-sm text-paper/90">
            Room ini dibuat dengan versi lama Booth Bareng, jadi semua orang bisa mengatur dan memulai foto. Buat room
            baru supaya hanya pembuat room yang memegang kendali.
          </p>
          <Link href="/" className="rounded-full bg-flash px-5 py-2 text-sm font-bold text-ink">
            Buat room baru
          </Link>
        </div>
      )}

      <p role="status" className="text-base text-paper/90">
        {shareNote ?? status}
      </p>

      {/* Panggung: susunan dan tampilan sama dengan satu panel hasil pada bingkai yang dipilih */}
      <div ref={stageBoxRef} className={phase === "review" ? "hidden" : "w-full"}>
        <section
          ref={stageRef}
          className="relative mx-auto w-fit scroll-mt-3 transition-colors"
          style={{ backgroundColor: theme.bg, padding: STAGE_PAD }}
          aria-label="Kamera"
        >
          <div
            className="grid"
            style={{ gridTemplateColumns: `repeat(${liveCols}, ${tileWidth}px)`, gap: tileGap }}
          >
            {tiles}
          </div>

          {shooting && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              {count !== null && (
                <span
                  key={`${shotIndex}-${count}`}
                  className="animate-count font-display text-[min(40vw,16rem)] font-black leading-none text-flash [-webkit-text-stroke:6px_var(--color-ink)] [paint-order:stroke_fill]"
                >
                  {count}
                </span>
              )}
              <span className="absolute top-4 left-1/2 -translate-x-1/2 rounded-full bg-ink px-4 py-1.5 text-sm font-bold text-paper">
                Foto {shotIndex + 1} dari {shotsForLabel}
              </span>
            </div>
          )}
        </section>
      </div>

      {phase === "review" && (
        <section className="flex flex-col items-center gap-5" aria-label="Hasil foto">
          {results.length ? (
            <ResultGallery images={results} zipName={`booth-bareng-${roomId}.zip`} />
          ) : (
            <p className="py-16 text-center text-paper/85">Menunggu foto dari teman-temanmu…</p>
          )}
          {canControl && (
            <button
              type="button"
              onClick={again}
              className="rounded-full border-2 border-paper px-7 py-3 font-bold transition-colors hover:bg-paper hover:text-ink"
            >
              Foto lagi
            </button>
          )}
        </section>
      )}

      {canControl ? (
        <section className="grid gap-6 rounded-3xl bg-curtain-deep/70 p-5 md:grid-cols-2 md:p-7" aria-label="Pengaturan">
          {room.amHost && <p className="text-xs font-bold text-flash md:col-span-2">Kamu pembuat room</p>}
          <div className="md:col-span-2">
            <Field label="Bingkai">
              <FramePicker
                people={stripPeople}
                shots={thumbShots}
                caption={settings.caption}
                value={settings.frame}
                disabled={shooting}
                onChange={(frame) => updateSettings({ frame })}
              />
            </Field>
          </div>

          <Field label="Filter">
            <div className="flex flex-wrap gap-2">
              {(Object.keys(FILTERS) as FilterId[]).map((id) => (
                <Chip
                  key={id}
                  pressed={settings.filter === id}
                  disabled={shooting}
                  onClick={() => updateSettings({ filter: id })}
                >
                  {FILTERS[id].label}
                </Chip>
              ))}
            </div>
          </Field>

          <Field label="Jumlah foto">
            <div className="flex flex-wrap gap-2">
              {SHOT_OPTIONS.map((n) => (
                <Chip
                  key={n}
                  pressed={settings.shots === n}
                  disabled={phase !== "idle"}
                  onClick={() => updateSettings({ shots: n })}
                >
                  {n} foto
                </Chip>
              ))}
            </div>
          </Field>

          <Field label="Format hasil">
            <div className="flex flex-wrap gap-2">
              {(Object.keys(FORMATS) as ResultFormat[]).map((f) => (
                <Chip key={f} pressed={settings.format === f} disabled={shooting} onClick={() => updateSettings({ format: f })}>
                  {FORMATS[f]}
                </Chip>
              ))}
            </div>
          </Field>

          <div className="md:col-span-2">
            <Field label="Background">
              <div className="flex flex-wrap gap-2">
                <BackgroundChip
                  label="Asli"
                  pressed={settings.background === NO_BACKGROUND}
                  disabled={shooting}
                  onClick={() => updateSettings({ background: NO_BACKGROUND })}
                />
                {BACKGROUND_LIST.map((bg) => (
                  <BackgroundChip
                    key={bg.id}
                    label={bg.label}
                    src={bg.src}
                    pressed={settings.background === bg.id}
                    disabled={shooting}
                    onClick={() => updateSettings({ background: bg.id })}
                  />
                ))}
              </div>
              <span className="text-xs text-paper/70">
                Latar ruangan tiap orang diganti dengan pemandangan yang sama dan menyambung antar foto. Diproses di
                perangkat masing-masing; pertama kali butuh mengunduh ±12 MB.
              </span>
            </Field>
          </div>

          <Field label="Tulisan di bawah strip" htmlFor="caption">
            <input
              id="caption"
              value={settings.caption}
              maxLength={CAPTION_MAX}
              disabled={shooting}
              onChange={(e) => updateSettings({ caption: e.target.value })}
              className="w-full max-w-md rounded-full border-2 border-paper/30 bg-curtain px-5 py-2.5 text-paper focus:border-flash focus:outline-none disabled:opacity-50"
            />
          </Field>

          <div className="flex flex-wrap items-center gap-4 md:col-span-2">
            {phase === "idle" && (
              <button
                type="button"
                onClick={start}
                disabled={!canStart}
                className="rounded-full bg-flash px-9 py-4 text-lg font-bold text-ink shadow-[0_6px_0_0_var(--color-ink)] transition-transform active:translate-y-1 active:shadow-[0_2px_0_0_var(--color-ink)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                Mulai foto
              </button>
            )}
            {micButton}
            {phase === "idle" && !canStart && !solo && (
              <span className="text-sm text-paper/70">Tombol foto aktif setelah minimal satu teman tersambung.</span>
            )}
          </div>
        </section>
      ) : (
        <section className="flex flex-col gap-5 rounded-3xl bg-curtain-deep/70 p-5 md:p-7" aria-label="Pengaturan dari pembuat room">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
            <Summary label="Bingkai" value={theme.label} swatch={theme.bg} />
            <Summary label="Filter" value={FILTERS[settings.filter].label} />
            <Summary label="Jumlah foto" value={`${settings.shots} foto`} />
            <Summary label="Format" value={FORMATS[settings.format]} />
            <Summary label="Background" value={getBackground(settings.background)?.label ?? "Asli"} />
            <Summary label="Tulisan" value={settings.caption.trim() || "kita"} />
          </dl>
          <div className="flex flex-wrap items-center gap-4">
            {micButton}
            {phase === "idle" && <span className="text-sm text-paper/80">Menunggu pembuat room memulai foto.</span>}
          </div>
        </section>
      )}

      {flashKey > 0 && (
        <div key={flashKey} className="animate-flash pointer-events-none fixed inset-0 z-50 bg-white" aria-hidden="true" />
      )}
    </main>
  );
}

function BackgroundChip({
  label,
  src,
  pressed,
  disabled,
  onClick,
}: {
  label: string;
  src?: string;
  pressed: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className="group flex flex-col items-center gap-1.5 rounded-xl border-2 border-paper/20 p-1.5 transition-colors hover:border-paper aria-pressed:border-flash aria-pressed:bg-flash/10 disabled:opacity-50"
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className="h-10 w-[106px] rounded-md object-cover" />
      ) : (
        <span className="grid h-10 w-[106px] place-items-center rounded-md bg-paper/15 text-[10px] text-paper/80">
          latar asli
        </span>
      )}
      <span className="text-xs font-medium group-aria-pressed:font-bold group-aria-pressed:text-flash">{label}</span>
    </button>
  );
}

function Summary({ label, value, swatch }: { label: string; value: string; swatch?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-bold text-paper/70">{label}</dt>
      <dd className="flex items-center gap-2 font-medium">
        {swatch && <span className="h-4 w-4 rounded-full border border-paper/40" style={{ backgroundColor: swatch }} />}
        <span className="truncate">{value}</span>
      </dd>
    </div>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="text-sm font-bold text-paper/90">
          {label}
        </label>
      ) : (
        <span className="text-sm font-bold text-paper/90">{label}</span>
      )}
      {children}
    </div>
  );
}

function Chip({
  pressed,
  disabled,
  onClick,
  children,
}: {
  pressed: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className="rounded-full border-2 border-paper/30 px-4 py-2 text-sm font-medium transition-colors hover:border-paper aria-pressed:border-flash aria-pressed:bg-flash aria-pressed:text-ink disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function Notice({ title, body, reload = false }: { title: string; body: string; reload?: boolean }) {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-5 px-5 py-16">
      <h1 className="font-display text-5xl font-black leading-none">{title}</h1>
      <p className="text-lg text-paper/85">{body}</p>
      <div className="flex flex-wrap gap-3">
        {reload && (
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-full bg-flash px-7 py-3 font-bold text-ink"
          >
            Muat ulang
          </button>
        )}
        <Link href="/" className="rounded-full border-2 border-paper px-7 py-3 font-bold">
          Buat room baru
        </Link>
      </div>
    </main>
  );
}
