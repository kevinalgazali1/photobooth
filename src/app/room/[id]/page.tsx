import { Suspense } from "react";
import { notFound } from "next/navigation";
import { Booth } from "@/components/Booth";
import { normalizeRoomCode } from "@/lib/room";
import { parseCapacity } from "@/lib/types";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<{ n?: string | string[] }>;

async function RoomContent({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const roomId = normalizeRoomCode(decodeURIComponent(id));
  if (!roomId) notFound();
  // Kapasitas dari tautan pembuat room. Tanpa ?n, ikut kapasitas anggota yang sudah ada.
  const capacity = parseCapacity(Array.isArray(query.n) ? query.n[0] : query.n);
  return <Booth roomId={roomId} capacityParam={capacity} />;
}

export default function RoomPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  return (
    <Suspense
      fallback={
        <main className="grid flex-1 place-items-center p-8 text-paper/80">Membuka booth…</main>
      }
    >
      <RoomContent params={params} searchParams={searchParams} />
    </Suspense>
  );
}
