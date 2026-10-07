import { SampleStrip } from "@/components/SampleStrip";
import { StartForm } from "@/components/StartForm";

export default function Home() {
  return (
    <main className="mx-auto grid w-full max-w-6xl flex-1 items-center gap-14 px-5 py-12 md:grid-cols-[1.25fr_1fr] md:px-10 md:py-20">
      <section className="flex flex-col gap-8">
        <p className="font-display text-2xl font-bold">Booth Berdua</p>

        <h1 className="font-display text-[clamp(3.5rem,10vw,6.75rem)] font-black leading-none tracking-tight text-balance text-paper">
          Satu strip foto, dua kota.
        </h1>

        <p className="max-w-[46ch] text-lg leading-relaxed text-paper/85">
          Buat room, kirim tautannya, lalu berfoto bareng lewat kamera masing-masing. Hitung
          mundurnya jalan bersamaan, dan hasilnya satu strip foto yang bisa kalian unduh berdua.
        </p>

        <StartForm />

        <p className="max-w-[46ch] text-sm text-paper/65">
          Video dan foto dikirim langsung antar browser. Tidak ada yang disimpan di server.
        </p>
      </section>

      <div className="flex justify-center md:justify-end">
        <SampleStrip />
      </div>
    </main>
  );
}
