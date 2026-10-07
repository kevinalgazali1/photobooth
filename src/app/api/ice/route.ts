/**
 * Mengembalikan daftar ICE server (STUN + TURN) untuk RTCPeerConnection.
 * Kredensial TURN disimpan di environment variable server (bukan di bundle JS).
 *
 * Opsi:
 * - TURN_CREDENTIALS_URL : endpoint yang mengembalikan array iceServers
 *                          (mis. endpoint credential Metered.ca). Diprioritaskan bila diisi.
 * - TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL : kredensial TURN statis.
 */

import { connection } from "next/server";

const STUN: RTCIceServer = {
  urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"],
};

export async function GET() {
  await connection(); // selalu dijalankan per request, tidak di-prerender saat build
  const iceServers: RTCIceServer[] = [STUN];

  const credentialsUrl = process.env.TURN_CREDENTIALS_URL;
  if (credentialsUrl) {
    try {
      const res = await fetch(credentialsUrl, { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as RTCIceServer[] | { iceServers?: RTCIceServer[] };
        const list = Array.isArray(data) ? data : data.iceServers;
        if (list?.length) iceServers.push(...list);
      }
    } catch (err) {
      console.error("[api/ice] gagal mengambil kredensial TURN", err);
    }
  }

  const urls = process.env.TURN_URLS?.split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  if (urls?.length && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({
      urls,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }

  return Response.json({ iceServers }, { headers: { "Cache-Control": "no-store" } });
}
