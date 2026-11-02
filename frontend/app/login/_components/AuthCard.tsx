import { ShieldAlert } from "lucide-react";
import Link from "next/link";
import type * as React from "react";

/** Shared shell for the sign-in and registration pages (dark glass card, ResQ branding). */
export function AuthCard({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-[calc(100vh-3.5rem)] items-center justify-center overflow-hidden bg-gradient-to-b from-slate-900 via-slate-800 to-black px-4 py-12 lg:min-h-[calc(100vh-4rem)]">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-32 left-1/2 h-80 w-80 -translate-x-1/2 rounded-full bg-red-600/20 blur-3xl"
      />
      <div className="relative w-full max-w-md">
        <div className="mb-8 text-center">
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-2xl bg-gradient-to-br from-red-500 to-red-700 p-3 shadow-lg shadow-red-900/40 focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none"
            aria-label="ResQ AI home"
          >
            <ShieldAlert aria-hidden="true" className="size-8 text-white" />
          </Link>
          <h1 className="mt-5 text-3xl font-extrabold tracking-tight text-white">{title}</h1>
          {subtitle && <p className="mt-2 text-sm text-slate-400">{subtitle}</p>}
        </div>
        <div className="rounded-3xl border border-slate-700/80 bg-slate-900/60 p-6 shadow-2xl shadow-black/40 backdrop-blur-md sm:p-8">
          {children}
        </div>
        {footer && <div className="mt-6 text-center text-sm text-slate-400">{footer}</div>}
      </div>
    </div>
  );
}

/** Shared class names so login and register controls look identical. */
export const authInputClass =
  "h-11 rounded-xl border-slate-700 bg-slate-950/60 px-3 text-base text-white placeholder:text-slate-500 dark:bg-slate-950/60";

export const authPrimaryButtonClass =
  "inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-red-600 px-4 text-sm font-semibold text-white shadow-lg shadow-red-900/30 transition-colors hover:bg-red-500 focus-visible:ring-3 focus-visible:ring-red-400/60 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60";
