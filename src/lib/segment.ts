/**
 * Memisahkan orang dari latar (segmentasi selfie MediaPipe) untuk background pengganti.
 *
 * Masker dibuat sekali di perangkat pemilik foto, lalu dikirim ke teman sebagai PNG grayscale-alpha.
 * Semua browser menyusun hasil dari masker yang sama persis, jadi hasilnya tetap identik
 * (menjalankan model di tiap perangkat bisa memberi hasil yang sedikit berbeda antar GPU).
 *
 * Model (±250 KB) ada di `public/models/`. Runtime WASM (±12 MB) dimuat dari jsDelivr hanya saat
 * background dipakai. Versi WASM harus sama dengan versi paket @mediapipe/tasks-vision.
 */
import type { ImageSegmenter } from "@mediapipe/tasks-vision";

const TASKS_VISION_VERSION = "1.0.1";
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`;
const MODEL_URL = "/models/selfie_segmenter.tflite";
/** Lebar masker yang dikirim. Cukup halus untuk tepi rambut, tapi kecil untuk data channel. */
const MASK_WIDTH = 640;

let segmenterPromise: Promise<ImageSegmenter> | null = null;

async function createSegmenter(): Promise<ImageSegmenter> {
  const { FilesetResolver, ImageSegmenter } = await import("@mediapipe/tasks-vision");
  const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
  const options = (delegate: "GPU" | "CPU") => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: "IMAGE" as const,
    outputConfidenceMasks: true,
    outputCategoryMask: false,
  });
  try {
    return await ImageSegmenter.createFromOptions(fileset, options("GPU"));
  } catch {
    // Sebagian browser/HP tidak mendukung delegate GPU.
    return ImageSegmenter.createFromOptions(fileset, options("CPU"));
  }
}

function getSegmenter(): Promise<ImageSegmenter> {
  segmenterPromise ??= createSegmenter().catch((err) => {
    segmenterPromise = null; // coba lagi lain kali
    throw err;
  });
  return segmenterPromise;
}

/** Mulai mengunduh model lebih awal (mis. begitu host memilih background). */
export function preloadSegmenter() {
  void getSegmenter().catch((err) => console.warn("[segment] model gagal dimuat", err));
}

/** Box blur satu arah pada array alpha (running sum, O(n)). */
function blurPass(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, horizontal: boolean) {
  const len = horizontal ? w : h;
  const lines = horizontal ? h : w;
  const at = (line: number, i: number) => (horizontal ? line * w + i : i * w + line);
  for (let line = 0; line < lines; line++) {
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += src[at(line, Math.min(len - 1, Math.max(0, i)))];
    for (let i = 0; i < len; i++) {
      dst[at(line, i)] = sum / (2 * r + 1);
      sum += src[at(line, Math.min(len - 1, i + r + 1))] - src[at(line, Math.max(0, i - r))];
    }
  }
}

/**
 * Menghaluskan tepi masker: diburamkan sedikit lalu ditarik ke dalam, supaya sisa latar asli
 * (halo) di sekitar rambut dan bahu tidak terlihat dan tepinya tidak bergerigi.
 * Dikerjakan di perangkat pengirim, jadi semua penerima memakai masker yang sama persis.
 */
function refineEdges(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const image = ctx.getImageData(0, 0, w, h);
  const a = new Float32Array(w * h);
  for (let i = 0; i < a.length; i++) a[i] = image.data[i * 4 + 3] / 255;
  const tmp = new Float32Array(a.length);
  const r = Math.max(1, Math.round(w / 320));
  for (let pass = 0; pass < 2; pass++) {
    blurPass(a, tmp, w, h, r, true);
    blurPass(tmp, a, w, h, r, false);
  }
  for (let i = 0; i < a.length; i++) {
    // 0,45–0,9 → transparan–penuh: tepi bergeser sedikit ke dalam, transisinya tetap lembut.
    const t = Math.min(1, Math.max(0, (a[i] - 0.45) / 0.45));
    image.data[i * 4] = image.data[i * 4 + 1] = image.data[i * 4 + 2] = 0;
    image.data[i * 4 + 3] = Math.round(t * t * (3 - 2 * t) * 255);
  }
  ctx.putImageData(image, 0, 0);
}

function toCanvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Gagal membuat masker."))), "image/png"),
  );
}

/**
 * Membuat masker orang untuk satu foto: PNG dengan alpha = keyakinan "ini orang".
 * Ukuran masker proporsional dengan foto, jadi bisa dipetakan dengan crop yang sama.
 */
export async function makePersonMask(photo: Blob): Promise<Blob> {
  const segmenter = await getSegmenter();
  const bitmap = await createImageBitmap(photo);
  try {
    const result = segmenter.segment(bitmap);
    try {
      const masks = result.confidenceMasks ?? [];
      // selfie_segmenter memberi satu masker (orang). Model multi-kelas: kelas 0 = latar.
      const mask = masks.length > 1 ? masks[1] : masks[0];
      if (!mask) throw new Error("Model tidak mengembalikan masker.");
      const values = mask.getAsFloat32Array();
      const src = document.createElement("canvas");
      src.width = mask.width;
      src.height = mask.height;
      const sctx = src.getContext("2d");
      if (!sctx) throw new Error("Canvas tidak didukung.");
      const image = sctx.createImageData(mask.width, mask.height);
      for (let i = 0; i < values.length; i++) image.data[i * 4 + 3] = Math.round(values[i] * 255);
      sctx.putImageData(image, 0, 0);

      const out = document.createElement("canvas");
      out.width = MASK_WIDTH;
      out.height = Math.round((MASK_WIDTH * bitmap.height) / bitmap.width);
      const octx = out.getContext("2d", { willReadFrequently: true });
      if (!octx) throw new Error("Canvas tidak didukung.");
      octx.imageSmoothingQuality = "high";
      octx.drawImage(src, 0, 0, out.width, out.height);
      refineEdges(octx, out.width, out.height);
      return await toCanvasBlob(out);
    } finally {
      result.close();
    }
  } finally {
    bitmap.close();
  }
}
