"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { generateRoomCode, normalizeRoomCode } from "@/lib/room";

export function StartForm() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const createRoom = () => {
    setBusy(true);
    router.push(`/room/${generateRoomCode()}`);
  };

  const joinRoom = (event: FormEvent) => {
    event.preventDefault();
    const normalized = normalizeRoomCode(code);
    if (!normalized) return;
    setBusy(true);
    router.push(`/room/${normalized}`);
  };

  return (
    <div className="flex flex-col gap-5">
      <button
        type="button"
        onClick={createRoom}
        disabled={busy}
        className="self-start rounded-full bg-flash px-8 py-4 text-lg font-bold text-ink shadow-[0_6px_0_0_var(--color-curtain-deep)] transition-transform active:translate-y-1 active:shadow-[0_2px_0_0_var(--color-curtain-deep)] disabled:opacity-60"
      >
        Buat room baru
      </button>

      <form onSubmit={joinRoom} className="flex max-w-sm flex-col gap-2">
        <label htmlFor="room-code" className="text-sm text-paper/80">
          Sudah dapat kode atau tautan dari pasanganmu?
        </label>
        <div className="flex gap-2">
          <input
            id="room-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="mis. k7xq2m"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-full border-2 border-paper/40 bg-curtain-deep/60 px-5 py-3 text-paper placeholder:text-paper/40 focus:border-flash focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy || !normalizeRoomCode(code)}
            className="rounded-full border-2 border-paper px-6 py-3 font-bold text-paper transition-colors hover:bg-paper hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-paper"
          >
            Masuk
          </button>
        </div>
      </form>
    </div>
  );
}
