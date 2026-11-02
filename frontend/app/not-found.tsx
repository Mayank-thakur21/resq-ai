import { Compass, House, Siren } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Page not found",
};

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-2xl flex-col items-center justify-center px-4 py-16 text-center">
      <span className="mb-6 inline-flex items-center justify-center rounded-full bg-slate-800/80 p-4 text-cyan-300">
        <Compass aria-hidden="true" className="size-10" />
      </span>
      <p className="text-sm font-semibold tracking-widest text-cyan-300 uppercase">404</p>
      <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-white md:text-4xl">
        We couldn&apos;t find that page
      </h1>
      <p className="mt-3 max-w-md text-slate-400">
        The link may be broken or the page may have moved. Here are some places that can help.
      </p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Link
          href="/"
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-500 focus-visible:ring-3 focus-visible:ring-blue-400/60 focus-visible:outline-none"
        >
          <House aria-hidden="true" className="size-4" />
          Back to home
        </Link>
        <Link
          href="/sos"
          className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-red-500 focus-visible:ring-3 focus-visible:ring-red-400/60 focus-visible:outline-none"
        >
          <Siren aria-hidden="true" className="size-4" />
          Emergency SOS
        </Link>
      </div>
    </div>
  );
}
