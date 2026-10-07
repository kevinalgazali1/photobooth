export const PHOTO_ASPECT = 4 / 3;
const MAX_WIDTH = 1280;

/**
 * Memotret frame dari <video> kamera lokal (resolusi asli, bukan stream yang sudah dikompres WebRTC).
 * Hasil di-crop ke rasio 4:3 dan dicerminkan seperti selfie.
 */
export function captureFrame(video: HTMLVideoElement, mirror = true): Promise<Blob> {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return Promise.reject(new Error("Video kamera belum siap."));

  let sw = vw;
  let sh = vw / PHOTO_ASPECT;
  if (sh > vh) {
    sh = vh;
    sw = vh * PHOTO_ASPECT;
  }
  const sx = (vw - sw) / 2;
  const sy = (vh - sh) / 2;

  const outW = Math.round(Math.min(MAX_WIDTH, sw));
  const outH = Math.round(outW / PHOTO_ASPECT);

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("Canvas tidak didukung."));

  if (mirror) {
    ctx.translate(outW, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, outW, outH);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Gagal membuat foto."))),
      "image/jpeg",
      0.92,
    );
  });
}
