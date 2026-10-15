"use client";

import { useState } from "react";

export type ResultImage = { url: string; blob: Blob; name: string; label: string };

type Props = {
  images: ResultImage[];
  zipName: string;
};

/** Menampilkan hasil foto: satu strip, atau satu gambar per jepretan dengan tombol unduh masing-masing. */
export function ResultGallery({ images, zipName }: Props) {
  const [zipping, setZipping] = useState(false);

  const downloadAll = async () => {
    setZipping(true);
    try {
      const { zipSync } = await import("fflate");
      const files: Record<string, Uint8Array> = {};
      for (const img of images) files[img.name] = new Uint8Array(await img.blob.arrayBuffer());
      // PNG sudah terkompresi, jadi cukup disimpan (level 0) supaya cepat di HP.
      const zipped = zipSync(files, { level: 0 }) as Uint8Array<ArrayBuffer>;
      const url = URL.createObjectURL(new Blob([zipped], { type: "application/zip" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = zipName;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      console.error("[zip]", err);
    } finally {
      setZipping(false);
    }
  };

  if (images.length === 1) {
    const [img] = images;
    return (
      <div className="flex flex-col items-center gap-5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={img.url}
          alt={img.label}
          className="max-h-[75vh] w-auto max-w-full shadow-[0_30px_60px_-20px_rgb(0_0_0/0.55)]"
        />
        <a href={img.url} download={img.name} className={PRIMARY}>
          Unduh strip
        </a>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <ul className="grid w-full gap-6 sm:grid-cols-2">
        {images.map((img) => (
          <li key={img.name} className="flex flex-col items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={img.url}
              alt={img.label}
              className="max-h-[70vh] w-auto max-w-full shadow-[0_24px_48px_-20px_rgb(0_0_0/0.55)]"
            />
            <a
              href={img.url}
              download={img.name}
              className="rounded-full border-2 border-paper px-5 py-2 text-sm font-bold transition-colors hover:bg-paper hover:text-ink"
            >
              Unduh {img.label.toLowerCase()}
            </a>
          </li>
        ))}
      </ul>
      <button type="button" onClick={downloadAll} disabled={zipping} className={`${PRIMARY} disabled:opacity-60`}>
        {zipping ? "Menyiapkan ZIP…" : `Unduh semua (${images.length} foto, ZIP)`}
      </button>
    </div>
  );
}

const PRIMARY = "rounded-full bg-flash px-7 py-3 font-bold text-ink shadow-[0_5px_0_0_var(--color-curtain-deep)]";
