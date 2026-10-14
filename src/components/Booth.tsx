"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePeerRoom } from "@/hooks/usePeerRoom";
import { captureFrame } from "@/lib/capture";
import { DEFAULT_FRAME_ID, FRAMES, getFrame } from "@/lib/frames";
import { columnsFor, composeStrip, FILTERS } from "@/lib/strip";
import { MAX_CAPACITY, type BoothMessage, type BoothSettings, type ConnectionStatus, type FilterId } from "@/lib/types";
import { FramePicker } from "./FramePicker";
import { VideoTile } from "./VideoTile";

type Phase = "idle" | "shooting" | "review";
type Session = { order: string[]; shots: number };
type Photos = Map<string, (Blob | null)[]>;

const SHOT_OPTIONS = [1, 2, 3, 4];
const DEFAULT_SETTINGS: BoothSettings = {
  frame: DEFAULT_FRAME_ID,
  filter: "none",
  shots: 4,
  caption: "kita",
  updatedAt: 0,
};
const PHOTO_TIMEOUT_MS = 12_000;
const CAPTION_MAX = 28;

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  media: "Meminta izin kamera dan mikrofon…",
  joining: "Masuk ke room…",
  solo: "Mode sendiri. Atur bingkai, lalu mulai foto.",
  waiting: "Belum ada teman yang masuk. Kirim tautan room ini ke mereka.",
  connecting: "Menyambungkan ke teman-temanmu…",
  connected: "Tersambung. Atur bingkai, lalu mulai foto.",
  full: "",
  error: "",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const emptyShots = (n: number) => Array<Blob | null>(n).fill(null);
const hasOwn = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

function withPhoto(prev: Photos, id: string, index: number, blob: Blob, shots: number): Photos {
  const next = new Map(prev);
  const list = (next.get(id) ?? emptyShots(Math.max(shots, index + 1))).slice();
  list[index] = blob;
  next.set(id, list);
  return next;
}

/** Pengaturan dari peer lain bisa berasal dari versi aplikasi berbeda, jadi diperiksa dulu. */
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
    updatedAt: Number(s.updatedAt) || 0,
  };
}

/** "Yang terbaru menang"; seri dipecah secara deterministik supaya semua layar sepakat. */
function isNewer(a: BoothSettings, b: BoothSettings) {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
  return JSON.stringify(a) > JSON.stringify(b);
}

export function Booth({ roomId, capacityParam }: { roomId: string; capacityParam: number | null }) {
  const [settings, setSettings] = useState<BoothSettings>(DEFAULT_SETTINGS);
  const [phase, setPhase] = useState<Phase>("idle");
  const [count, setCount] = useState<number | null>(null);
  const [shotIndex, setShotIndex] = useState(0);
  const [flashKey, setFlashKey] = useState(0);
  const [session, setSession] = useState<Session | null>(null);
  const [photos, setPhotos] = useState<Photos>(() => new Map());
  const [timedOut, setTimedOut] = useState(false);
  const [stripUrl, setStripUrl] = useState<string | null>(null);
  const [shareNote, setShareNote] = useState<string | null>(null);

  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const runningRef = useRef(false);
  const settingsRef = useRef(settings);
  const sessionRef = useRef<Session | null>(null);
  const roomRef = useRef<{
    myId: string | null;
    sendTo: (peerId: string, message: BoothMessage) => void;
    sendPhoto: (index: number, blob: Blob) => void;
  }>({ myId: null, sendTo: () => undefined, sendPhoto: () => undefined });

  const commitSettings = useCallback((next: BoothSettings) => {
    settingsRef.current = next;
    setSettings(next);
  }, []);

  const resetSession = useCallback(() => {
    if (runningRef.current) return;
    sessionRef.current = null;
    setSession(null);
    setPhase("idle");
    setPhotos(new Map());
    setTimedOut(false);
    setStripUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, []);

  const runSession = useCallback(async (shots: number, order: string[]) => {
    if (runningRef.current) return;
    runningRef.current = true;
    const next = { shots, order };
    sessionRef.current = next;
    setSession(next);
    setPhotos(new Map(order.map((id) => [id, emptyShots(shots)])));
    setTimedOut(false);
    setStripUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
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
        const myId = roomRef.current.myId;
        if (video && myId) {
          try {
            const blob = await captureFrame(video);
            setPhotos((prev) => withPhoto(prev, myId, i, blob, shots));
            roomRef.current.sendPhoto(i, blob);
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
    (_from: string, message: BoothMessage) => {
      if (message.type === "settings") {
        const incoming = sanitizeSettings(message.settings);
        if (incoming && isNewer(incoming, settingsRef.current)) commitSettings(incoming);
      } else if (message.type === "start") {
        const shots = SHOT_OPTIONS.includes(message.shots) ? message.shots : DEFAULT_SETTINGS.shots;
        const order = Array.isArray(message.order)
          ? message.order.filter((id): id is string => typeof id === "string").slice(0, MAX_CAPACITY)
          : [];
        if (order.length) void runSession(shots, order);
      } else if (message.type === "reset") {
        resetSession();
      }
    },
    [commitSettings, runSession, resetSession],
  );

  const onPhoto = useCallback((from: string, index: number, blob: Blob) => {
    if (!Number.isInteger(index) || index < 0 || index >= SHOT_OPTIONS.length) return;
    setPhotos((prev) => withPhoto(prev, from, index, blob, sessionRef.current?.shots ?? index + 1));
  }, []);

  // Setiap data channel yang baru terbuka langsung dikirimi pengaturan terkini.
  const onChannelOpen = useCallback((peerId: string) => {
    roomRef.current.sendTo(peerId, { type: "settings", settings: settingsRef.current });
  }, []);

  const room = usePeerRoom(roomId, capacityParam, { onMessage, onPhoto, onChannelOpen });
  const { send } = room;

  useEffect(() => {
    roomRef.current = { myId: room.myId, sendTo: room.sendTo, sendPhoto: room.sendPhoto };
  }, [room.myId, room.sendTo, room.sendPhoto]);

  const allArrived =
    !!session &&
    session.order.every((id) => {
      const list = photos.get(id);
      return !!list && list.length >= session.shots && list.slice(0, session.shots).every(Boolean);
    });

  useEffect(() => {
    if (phase !== "review" || allArrived) return;
    const timer = setTimeout(() => setTimedOut(true), PHOTO_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [phase, allArrived]);

  // Susun ulang strip setiap kali foto atau pengaturan berubah di tahap review.
  useEffect(() => {
    if (phase !== "review" || !session || !(allArrived || timedOut)) return;
    let cancelled = false;
    composeStrip({
      people: session.order.length,
      shots: session.shots,
      photos: session.order.map((id) => photos.get(id) ?? []),
      frame: settings.frame,
      filter: settings.filter,
      caption: settings.caption,
    })
      .then((blob) => {
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        setStripUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return url;
        });
      })
      .catch((err) => console.error("[strip]", err));
    return () => {
      cancelled = true;
    };
  }, [phase, session, allArrived, timedOut, photos, settings.frame, settings.filter, settings.caption]);

  const updateSettings = (patch: Partial<Omit<BoothSettings, "updatedAt">>) => {
    const current = settingsRef.current;
    // Selalu lebih besar dari versi yang sudah dilihat, jadi perbedaan jam antar perangkat tidak masalah.
    const next = { ...current, ...patch, updatedAt: Math.max(Date.now(), current.updatedAt + 1) };
    commitSettings(next);
    send({ type: "settings", settings: next });
  };

  const solo = room.status === "solo";
  const canStart = phase === "idle" && !!room.myId && (solo || room.openCount > 0);

  const start = () => {
    if (!canStart || !room.myId) return;
    // Hanya peserta yang tersambung denganku yang ikut, urutannya sama dengan urutan anggota.
    const order = room.members.filter((id) => id === room.myId || room.peers[id]?.channelOpen);
    if (!order.includes(room.myId)) order.push(room.myId);
    const shots = settingsRef.current.shots;
    send({ type: "start", shots, order });
    void runSession(shots, order);
  };

  const again = () => {
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

  // Grid kamera memakai susunan kolom yang sama dengan satu panel strip.
  const tileIds = session && phase !== "idle" ? session.order : room.members;
  const slotCount = session && phase !== "idle" ? session.order.length : Math.max(room.capacity ?? 1, room.members.length, 1);
  const cols = columnsFor(slotCount);
  const rows = Math.ceil(slotCount / cols);
  const tileWidth = `calc((100% - ${(cols - 1) * 0.75}rem) / ${cols})`;

  const tiles = Array.from({ length: slotCount }, (_, i) => {
    const id = tileIds[i];
    const position = i + 1;
    if (id && id === room.myId) {
      return (
        <VideoTile
          key="local"
          stream={room.localStream}
          label="Kamu"
          muted
          filterCss={filterCss}
          videoRef={localVideoRef}
          emptyText="Menyalakan kamera…"
          style={{ width: tileWidth }}
        />
      );
    }
    const peer = id ? room.peers[id] : undefined;
    return (
      <VideoTile
        key={id ?? `slot-${i}`}
        stream={peer?.stream ?? null}
        label={`Orang ke-${position}`}
        filterCss={filterCss}
        emptyText={id ? (peer ? "Menyambungkan…" : "Terputus") : `Menunggu orang ke-${position}…`}
        style={{ width: tileWidth }}
      />
    );
  });
  // Kamera lokal harus selalu terpasang supaya bisa dipotret, walau aku belum muncul di daftar anggota.
  if (!tileIds.includes(room.myId ?? "")) {
    tiles[tileIds.length < slotCount ? tileIds.length : slotCount - 1] = (
      <VideoTile
        key="local"
        stream={room.localStream}
        label="Kamu"
        muted
        filterCss={filterCss}
        videoRef={localVideoRef}
        emptyText="Menyalakan kamera…"
        style={{ width: tileWidth }}
      />
    );
  }

  const joinedText =
    room.capacity && room.capacity > 1 && room.members.length > 0
      ? `${room.members.length} dari ${room.capacity} orang sudah masuk. `
      : "";

  const stripPeople = session?.order.length ?? Math.max(room.capacity ?? 1, room.members.length, 1);
  const stripShots = session && phase !== "idle" ? session.shots : settings.shots;

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-6 md:px-8 md:py-8">
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

      <p role="status" className="text-base text-paper/90">
        {shareNote ?? `${joinedText}${STATUS_TEXT[room.status]}`}
      </p>

      {/* Panggung: tampilannya sama dengan satu panel strip pada bingkai yang dipilih */}
      <section
        className={`relative mx-auto w-full p-3 transition-colors md:p-4 ${phase === "review" ? "hidden" : ""}`}
        style={{
          backgroundColor: theme.bg,
          maxWidth: `max(20rem, calc(68vh * ${((cols * 4) / (rows * 3)).toFixed(3)}))`,
        }}
        aria-label="Kamera"
      >
        <div className="flex flex-wrap justify-center gap-3">{tiles}</div>

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
              Foto {shotIndex + 1} dari {session?.shots ?? settings.shots}
            </span>
          </div>
        )}
      </section>

      {phase === "review" && (
        <section className="flex flex-col items-center gap-5" aria-label="Hasil foto">
          {stripUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={stripUrl}
              alt="Strip foto kalian"
              className="max-h-[75vh] w-auto max-w-full shadow-[0_30px_60px_-20px_rgb(0_0_0/0.55)]"
            />
          ) : (
            <p className="py-16 text-center text-paper/85">Menunggu foto dari teman-temanmu…</p>
          )}
          <div className="flex flex-wrap justify-center gap-3">
            {stripUrl && (
              <a
                href={stripUrl}
                download={`booth-bareng-${roomId}.png`}
                className="rounded-full bg-flash px-7 py-3 font-bold text-ink shadow-[0_5px_0_0_var(--color-curtain-deep)]"
              >
                Unduh strip
              </a>
            )}
            <button
              type="button"
              onClick={again}
              className="rounded-full border-2 border-paper px-7 py-3 font-bold transition-colors hover:bg-paper hover:text-ink"
            >
              Foto lagi
            </button>
          </div>
        </section>
      )}

      <section className="grid gap-6 rounded-3xl bg-curtain-deep/70 p-5 md:grid-cols-2 md:p-7" aria-label="Pengaturan">
        <div className="md:col-span-2">
          <Field label="Bingkai">
            <FramePicker
              people={stripPeople}
              shots={stripShots}
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

        <div className="md:col-span-2">
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
        </div>

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
          <button
            type="button"
            onClick={room.toggleMic}
            disabled={!room.localStream}
            className="rounded-full border-2 border-paper/60 px-5 py-3 text-sm font-bold transition-colors hover:bg-paper hover:text-ink disabled:opacity-40"
          >
            {room.micOn ? "Matikan mikrofon" : "Nyalakan mikrofon"}
          </button>
          {phase === "idle" && !canStart && !solo && (
            <span className="text-sm text-paper/70">Tombol foto aktif setelah minimal satu teman tersambung.</span>
          )}
        </div>
      </section>

      {flashKey > 0 && (
        <div key={flashKey} className="animate-flash pointer-events-none fixed inset-0 z-50 bg-white" aria-hidden="true" />
      )}
    </main>
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
