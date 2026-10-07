"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePeerRoom } from "@/hooks/usePeerRoom";
import { captureFrame } from "@/lib/capture";
import { composeStrip, FILTERS, FRAMES } from "@/lib/strip";
import type { BoothMessage, BoothSettings, ConnectionStatus, FilterId, FrameId } from "@/lib/types";
import { VideoTile } from "./VideoTile";

type Phase = "idle" | "shooting" | "review";

const DEFAULT_SETTINGS: BoothSettings = { frame: "paper", filter: "none", shots: 4, caption: "kita" };
const PARTNER_TIMEOUT_MS = 12_000;

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  media: "Meminta izin kamera dan mikrofon…",
  joining: "Masuk ke room…",
  waiting: "Menunggu pasanganmu masuk. Kirim tautan room ini ke dia.",
  connecting: "Menyambungkan ke pasanganmu…",
  connected: "Tersambung. Atur bingkai, lalu mulai foto.",
  full: "",
  error: "",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const emptyShots = (n: number) => Array<Blob | null>(n).fill(null);

export function Booth({ roomId }: { roomId: string }) {
  const [settings, setSettings] = useState<BoothSettings>(DEFAULT_SETTINGS);
  const [phase, setPhase] = useState<Phase>("idle");
  const [count, setCount] = useState<number | null>(null);
  const [shotIndex, setShotIndex] = useState(0);
  const [flashKey, setFlashKey] = useState(0);
  const [mine, setMine] = useState<(Blob | null)[]>([]);
  const [theirs, setTheirs] = useState<(Blob | null)[]>([]);
  const [partnerTimedOut, setPartnerTimedOut] = useState(false);
  const [stripUrl, setStripUrl] = useState<string | null>(null);
  const [shareNote, setShareNote] = useState<string | null>(null);

  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const runningRef = useRef(false);
  const settingsRef = useRef(settings);
  const sendPhotoRef = useRef<(index: number, blob: Blob) => void>(() => undefined);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const resetSession = useCallback(() => {
    if (runningRef.current) return;
    setPhase("idle");
    setMine([]);
    setTheirs([]);
    setPartnerTimedOut(false);
    setStripUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, []);

  const runSession = useCallback(async (shots: number) => {
    if (runningRef.current) return;
    runningRef.current = true;
    setMine(emptyShots(shots));
    setTheirs(emptyShots(shots));
    setPartnerTimedOut(false);
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

        const video = localVideoRef.current;
        if (video) {
          try {
            const blob = await captureFrame(video);
            setMine((prev) => prev.map((b, idx) => (idx === i ? blob : b)));
            sendPhotoRef.current(i, blob);
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
    (message: BoothMessage) => {
      if (message.type === "settings") setSettings(message.settings);
      else if (message.type === "start") void runSession(message.shots);
      else if (message.type === "reset") resetSession();
    },
    [runSession, resetSession],
  );

  const onPhoto = useCallback((index: number, blob: Blob) => {
    setTheirs((prev) => prev.map((b, idx) => (idx === index ? blob : b)));
  }, []);

  const room = usePeerRoom(roomId, { onMessage, onPhoto });
  const { send, channelOpen, isInitiator } = room;

  useEffect(() => {
    sendPhotoRef.current = room.sendPhoto;
  }, [room.sendPhoto]);

  // Orang pertama di room yang menentukan pengaturan awal untuk berdua.
  useEffect(() => {
    if (channelOpen && isInitiator) send({ type: "settings", settings: settingsRef.current });
  }, [channelOpen, isInitiator, send]);

  const partnerDone = theirs.length > 0 && theirs.every(Boolean);

  useEffect(() => {
    if (phase !== "review" || partnerDone) return;
    const timer = setTimeout(() => setPartnerTimedOut(true), PARTNER_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [phase, partnerDone]);

  // Susun ulang strip setiap kali foto atau pengaturan berubah di tahap review.
  useEffect(() => {
    if (phase !== "review" || !(partnerDone || partnerTimedOut)) return;
    let cancelled = false;
    composeStrip({
      left: isInitiator ? mine : theirs,
      right: isInitiator ? theirs : mine,
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
  }, [phase, partnerDone, partnerTimedOut, mine, theirs, settings, isInitiator]);

  const updateSettings = (patch: Partial<BoothSettings>) => {
    const next = { ...settingsRef.current, ...patch };
    setSettings(next);
    send({ type: "settings", settings: next });
  };

  const start = () => {
    if (!channelOpen || phase !== "idle") return;
    send({ type: "start", shots: settings.shots });
    void runSession(settings.shots);
  };

  const again = () => {
    send({ type: "reset" });
    resetSession();
  };

  const shareLink = async () => {
    const url = window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title: "Booth Berdua", text: "Ayo foto bareng!", url });
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
        body="Satu room hanya untuk dua orang. Buat room baru untuk berfoto."
      />
    );
  }

  if (room.status === "error") {
    return (
      <Notice title="Booth belum bisa dibuka." body={room.error ?? "Coba muat ulang halaman."} reload />
    );
  }

  const theme = FRAMES[settings.frame];
  const filterCss = FILTERS[settings.filter].css;
  const shooting = phase === "shooting";

  const localTile = (
    <VideoTile
      key="local"
      stream={room.localStream}
      label="Kamu"
      muted
      filterCss={filterCss}
      videoRef={localVideoRef}
      emptyText="Menyalakan kamera…"
    />
  );
  const remoteTile = (
    <VideoTile
      key="remote"
      stream={room.remoteStream}
      label="Pasangan"
      filterCss={filterCss}
      emptyText={room.status === "connecting" ? "Menyambungkan…" : "Belum ada yang masuk"}
    />
  );
  // Posisi kiri/kanan sama di kedua layar, sesuai urutan di strip.
  const tiles = room.status === "connected" && !isInitiator ? [remoteTile, localTile] : [localTile, remoteTile];

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-6 md:px-8 md:py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/" className="font-display text-2xl font-bold">
          Booth Berdua
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
        {shareNote ?? STATUS_TEXT[room.status]}
      </p>

      {/* Panggung: tampilannya sama dengan satu baris strip pada bingkai yang dipilih */}
      <section
        className={`relative p-3 transition-colors md:p-4 ${phase === "review" ? "hidden" : ""}`}
        style={{ backgroundColor: theme.bg }}
        aria-label="Kamera"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:gap-4">{tiles}</div>

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
              Foto {shotIndex + 1} dari {mine.length}
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
              alt="Strip foto kalian berdua"
              className="max-h-[75vh] w-auto shadow-[0_30px_60px_-20px_rgb(0_0_0/0.55)]"
            />
          ) : (
            <p className="py-16 text-center text-paper/85">Menunggu foto dari pasanganmu…</p>
          )}
          <div className="flex flex-wrap justify-center gap-3">
            {stripUrl && (
              <a
                href={stripUrl}
                download={`booth-berdua-${roomId}.png`}
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
        <Field label="Bingkai">
          <div className="flex flex-wrap gap-2">
            {(Object.keys(FRAMES) as FrameId[]).map((id) => (
              <button
                key={id}
                type="button"
                aria-pressed={settings.frame === id}
                aria-label={FRAMES[id].label}
                title={FRAMES[id].label}
                disabled={shooting}
                onClick={() => updateSettings({ frame: id })}
                className="h-10 w-10 rounded-full border-2 border-paper/30 aria-pressed:border-flash aria-pressed:ring-2 aria-pressed:ring-flash aria-pressed:ring-offset-2 aria-pressed:ring-offset-curtain-deep disabled:opacity-50"
                style={{ backgroundColor: FRAMES[id].bg }}
              />
            ))}
          </div>
        </Field>

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
          <div className="flex gap-2">
            {[3, 4].map((n) => (
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

        <Field label="Tulisan di bawah strip" htmlFor="caption">
          <input
            id="caption"
            value={settings.caption}
            maxLength={28}
            disabled={shooting}
            onChange={(e) => updateSettings({ caption: e.target.value })}
            className="w-full rounded-full border-2 border-paper/30 bg-curtain px-5 py-2.5 text-paper focus:border-flash focus:outline-none disabled:opacity-50"
          />
        </Field>

        <div className="flex flex-wrap items-center gap-4 md:col-span-2">
          {phase === "idle" && (
            <button
              type="button"
              onClick={start}
              disabled={!channelOpen}
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
          {phase === "idle" && !channelOpen && (
            <span className="text-sm text-paper/70">Tombol foto aktif setelah pasanganmu tersambung.</span>
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
