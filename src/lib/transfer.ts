/**
 * Kirim/terima file (foto) lewat RTCDataChannel dengan cara dipotong-potong.
 * Pesan teks (JSON) dipakai untuk metadata, pesan biner untuk potongan data.
 */

const CHUNK_SIZE = 16 * 1024; // aman untuk semua browser
const HIGH_WATER_MARK = 1024 * 1024; // tahan kirim kalau buffer > 1 MB
const LOW_WATER_MARK = 256 * 1024;

export type PhotoMeta = {
  type: "photo-meta";
  index: number;
  size: number;
  mime: string;
};

function waitForDrain(dc: RTCDataChannel): Promise<void> {
  return new Promise((resolve) => {
    const onLow = () => {
      dc.removeEventListener("bufferedamountlow", onLow);
      resolve();
    };
    dc.addEventListener("bufferedamountlow", onLow);
  });
}

export async function sendBlob(dc: RTCDataChannel, index: number, blob: Blob) {
  if (dc.readyState !== "open") return;
  const buffer = await blob.arrayBuffer();
  const meta: PhotoMeta = {
    type: "photo-meta",
    index,
    size: buffer.byteLength,
    mime: blob.type || "image/jpeg",
  };

  dc.bufferedAmountLowThreshold = LOW_WATER_MARK;
  dc.send(JSON.stringify(meta));

  for (let offset = 0; offset < buffer.byteLength; offset += CHUNK_SIZE) {
    if (dc.readyState !== "open") return;
    if (dc.bufferedAmount > HIGH_WATER_MARK) await waitForDrain(dc);
    dc.send(buffer.slice(offset, offset + CHUNK_SIZE));
  }
}

export function createReceiver(onComplete: (index: number, blob: Blob) => void) {
  let current: (PhotoMeta & { parts: ArrayBuffer[]; received: number }) | null = null;

  return {
    meta(meta: PhotoMeta) {
      current = { ...meta, parts: [], received: 0 };
      if (meta.size === 0) {
        onComplete(meta.index, new Blob([], { type: meta.mime }));
        current = null;
      }
    },
    chunk(data: ArrayBuffer) {
      if (!current) return;
      current.parts.push(data);
      current.received += data.byteLength;
      if (current.received >= current.size) {
        onComplete(current.index, new Blob(current.parts, { type: current.mime }));
        current = null;
      }
    },
  };
}
