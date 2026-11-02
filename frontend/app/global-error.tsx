"use client";

import { useEffect } from "react";

import "./globals.css";

/**
 * Last-resort error UI, used when the root layout itself fails. It replaces the whole
 * document, so it renders its own <html>/<body> and avoids any app providers or components
 * that could be the cause of the crash.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app/global-error] root layout crashed", error);
  }, [error]);

  return (
    <html lang="en" className="dark">
      <body className="flex min-h-screen items-center justify-center bg-slate-950 p-6 text-slate-100 antialiased">
        <main className="w-full max-w-lg rounded-2xl border border-red-500/30 bg-red-950/20 p-8 text-center">
          <h1 className="text-2xl font-bold text-white">ResQ AI hit an unexpected error</h1>
          <p className="mt-3 text-sm text-slate-300">
            Please try again. If you are in danger, call <a className="font-semibold text-red-300 underline" href="tel:112">112</a>{" "}
            or your local emergency number right away.
          </p>
          {error.digest && <p className="mt-3 font-mono text-xs text-slate-500">Reference: {error.digest}</p>}
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <button
              type="button"
              onClick={reset}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500 focus-visible:ring-3 focus-visible:ring-red-400/60 focus-visible:outline-none"
            >
              Try again
            </button>
            {/* A full page load (not next/link) so a broken client runtime is replaced. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a
              href="/"
              className="rounded-lg border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800 focus-visible:ring-3 focus-visible:ring-slate-400/60 focus-visible:outline-none"
            >
              Reload home
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
