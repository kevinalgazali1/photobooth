"use client";

import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

type Props = {
  stream: MediaStream | null;
  label: string;
  muted?: boolean;
  filterCss: string;
  videoRef?: RefObject<HTMLVideoElement | null>;
  emptyText: string;
  style?: CSSProperties;
};

export function VideoTile({ stream, label, muted = false, filterCss, videoRef, emptyText, style }: Props) {
  const innerRef = useRef<HTMLVideoElement | null>(null);
  const ref = videoRef ?? innerRef;
  const [needsTap, setNeedsTap] = useState(false);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.srcObject = stream;
    if (stream) {
      video.play().then(
        () => setNeedsTap(false),
        () => setNeedsTap(true), // autoplay dengan suara diblokir browser
      );
    }
  }, [stream, ref]);

  const resume = () => {
    ref.current?.play().then(() => setNeedsTap(false), () => undefined);
  };

  return (
    <div className="relative aspect-[4/3] overflow-hidden bg-ink/15" style={style}>
      <video
        ref={ref}
        autoPlay
        playsInline
        muted={muted}
        className="h-full w-full -scale-x-100 object-cover"
        style={{ filter: filterCss }}
      />

      {!stream && (
        <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-ink/70">
          {emptyText}
        </div>
      )}

      {needsTap && stream && (
        <button
          type="button"
          onClick={resume}
          className="absolute inset-0 grid place-items-center bg-ink/50 text-base font-bold text-paper"
        >
          Ketuk untuk menyalakan suara
        </button>
      )}

      <span className="absolute bottom-2 left-2 rounded-full bg-ink/70 px-3 py-1 text-xs font-medium text-paper">
        {label}
      </span>
    </div>
  );
}
