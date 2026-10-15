/**
 * Jalankan: npm test
 * Memakai test runner bawaan Node (type stripping), tanpa dependency tambahan.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptsControlMessage,
  createHostKey,
  importHostKey,
  isKeyedRoomId,
  publicPart,
  signHostProof,
  verifyHostClaim,
  type HostKey,
} from "./host.ts";

async function makeHost(): Promise<{ roomId: string; key: HostKey }> {
  const { roomId, privateJwk } = await createHostKey();
  const key = await importHostKey(roomId, privateJwk);
  assert.ok(key, "kunci host bisa dimuat ulang");
  return { roomId, key };
}

test("room id 10 karakter dari alfabet tanpa karakter mirip", async () => {
  const { roomId } = await makeHost();
  assert.equal(roomId.length, 10);
  assert.match(roomId, /^[a-z2-9]+$/);
  assert.doesNotMatch(roomId, /[l1o0i]/);
  assert.ok(isKeyedRoomId(roomId));
  assert.ok(!isKeyedRoomId("k7xq2m"), "kode format lama (6 karakter) dianggap room lama");
});

test("klaim host yang benar diterima", async () => {
  const { roomId, key } = await makeHost();
  const claim = {
    id: "peer-host",
    joinedAt: 1_700_000_000_000,
    hostPublicKey: key.publicJwk,
    hostProof: await signHostProof(key, roomId, "peer-host", 1_700_000_000_000),
  };
  assert.equal(await verifyHostClaim(roomId, claim), true);
});

test("tanda tangan milik peer lain ditolak (tidak bisa disalin)", async () => {
  const { roomId, key } = await makeHost();
  const proof = await signHostProof(key, roomId, "peer-host", 1);
  assert.equal(
    await verifyHostClaim(roomId, { id: "peer-penyusup", joinedAt: 1, hostPublicKey: key.publicJwk, hostProof: proof }),
    false,
  );
  assert.equal(
    await verifyHostClaim(roomId, { id: "peer-host", joinedAt: 2, hostPublicKey: key.publicJwk, hostProof: proof }),
    false,
    "joinedAt yang berbeda juga ditolak",
  );
});

test("kunci lain yang tidak cocok dengan room id ditolak", async () => {
  const { roomId } = await makeHost();
  const other = await makeHost();
  // Penyusup menandatangani dengan kuncinya sendiri untuk room orang lain.
  const claim = {
    id: "peer-penyusup",
    joinedAt: 5,
    hostPublicKey: other.key.publicJwk,
    hostProof: await signHostProof(other.key, roomId, "peer-penyusup", 5),
  };
  assert.equal(await verifyHostClaim(roomId, claim), false);
});

test("klaim rusak atau kosong ditolak tanpa error", async () => {
  const { roomId, key } = await makeHost();
  assert.equal(await verifyHostClaim(roomId, { id: "a", joinedAt: 1 }), false);
  assert.equal(await verifyHostClaim(roomId, { id: "a", joinedAt: 1, hostPublicKey: key.publicJwk, hostProof: "xxx" }), false);
  assert.equal(await verifyHostClaim(roomId, { id: "a", joinedAt: 1, hostPublicKey: "bukan jwk", hostProof: "x" }), false);
  assert.equal(
    await verifyHostClaim("k7xq2m", {
      id: "a",
      joinedAt: 1,
      hostPublicKey: key.publicJwk,
      hostProof: await signHostProof(key, "k7xq2m", "a", 1),
    }),
    false,
    "room lama tidak punya host",
  );
});

test("kunci privat yang bukan milik room tidak bisa dimuat", async () => {
  const { roomId } = await makeHost();
  const other = await createHostKey();
  assert.equal(await importHostKey(roomId, other.privateJwk), null);
  assert.equal(await importHostKey(roomId, publicPart(other.privateJwk)), null, "tanpa bagian privat");
});

test("pesan kendali dari non-host diabaikan", () => {
  // `from` = pemilik data channel asal pesan.
  assert.equal(acceptsControlMessage("host", "host", false), true);
  assert.equal(acceptsControlMessage("peserta", "host", false), false);
  assert.equal(acceptsControlMessage("peserta", null, false), false, "host belum terverifikasi");
  assert.equal(acceptsControlMessage("peserta", null, true), true, "room lama: semua orang memegang kendali");
});
