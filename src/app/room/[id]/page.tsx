import { Suspense } from "react";
import { notFound } from "next/navigation";
import { Booth } from "@/components/Booth";
import { normalizeRoomCode } from "@/lib/room";

type Params = Promise<{ id: string }>;

async function RoomContent({ params }: { params: Params }) {
  const { id } = await params;
  const roomId = normalizeRoomCode(decodeURIComponent(id));
  if (!roomId) notFound();
  return <Booth roomId={roomId} />;
}

export default function RoomPage({ params }: { params: Params }) {
  return (
    <Suspense
      fallback={
        <main className="grid flex-1 place-items-center p-8 text-paper/80">Membuka booth…</main>
      }
    >
      <RoomContent params={params} />
    </Suspense>
  );
}
