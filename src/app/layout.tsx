import type { Metadata, Viewport } from "next";
import "@fontsource/big-shoulders-display/latin-700";
import "@fontsource/big-shoulders-display/latin-900";
import "@fontsource/figtree/latin-400";
import "@fontsource/figtree/latin-500";
import "@fontsource/figtree/latin-700";
import "./globals.css";

export const metadata: Metadata = {
  title: "Booth Berdua",
  description: "Photobooth online untuk dua orang di kota yang berbeda. Foto bareng, unduh strip-nya.",
};

export const viewport: Viewport = {
  themeColor: "#2238c9",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id" className="h-full antialiased">
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
