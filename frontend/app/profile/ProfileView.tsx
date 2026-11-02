"use client";

import { LogOut, PhoneCall, Siren } from "lucide-react";
import Link from "next/link";
import * as React from "react";

import { SOSHistory } from "@/app/profile/_components/SOSHistory";
import { TestNotificationCard } from "@/app/profile/_components/TestNotificationCard";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { PushToggle } from "@/components/PushToggle";
import { signOutAndForget } from "@/lib/sign-out";

export interface ProfileUser {
  id: string;
  name: string | null;
  email: string | null;
}

/** How the account signs in, derived from the namespaced user id. */
export function accountProvider(userId: string): string {
  if (userId.startsWith("github:")) return "GitHub";
  if (userId.startsWith("google:")) return "Google";
  return "Email & password";
}

function initials(name: string | null, email: string | null): string {
  const source = (name || email || "?").trim();
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? `${parts[0][0]}${parts[1][0]}` : source.slice(0, 2);
  return letters.toUpperCase();
}

/** `/profile` body: account, alert notifications (+ test), SOS history, sign out. */
export default function ProfileView({ user }: { user: ProfileUser }) {
  const [signingOut, setSigningOut] = React.useState(false);

  return (
    <div className="space-y-6">
      <section
        aria-labelledby="account-title"
        className="flex flex-col gap-4 rounded-2xl border border-slate-700 bg-slate-800/50 p-5 backdrop-blur-md sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="flex min-w-0 items-center gap-4">
          <span
            aria-hidden="true"
            className="inline-flex size-14 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-cyan-500 text-lg font-bold text-white"
          >
            {initials(user.name, user.email)}
          </span>
          <div className="min-w-0">
            <h2 id="account-title" className="truncate text-xl font-bold text-white">
              {user.name || "ResQ AI user"}
            </h2>
            {user.email && <p className="truncate text-sm text-slate-300">{user.email}</p>}
            <p className="text-xs text-slate-400">Signed in with {accountProvider(user.id)}</p>
          </div>
        </div>
        <button
          type="button"
          disabled={signingOut}
          onClick={() => {
            setSigningOut(true);
            void signOutAndForget().catch((error: unknown) => {
              console.error("[profile] sign out failed", error);
              setSigningOut(false);
            });
          }}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-200 transition-colors hover:bg-slate-700/60 focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:outline-none disabled:opacity-60"
        >
          <LogOut aria-hidden="true" className="size-4" />
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <ErrorBoundary title="Notification settings are unavailable" compact>
            <PushToggle />
          </ErrorBoundary>
          <ErrorBoundary title="Test notifications are unavailable" compact>
            <TestNotificationCard />
          </ErrorBoundary>
          <nav aria-label="Emergency shortcuts" className="grid grid-cols-2 gap-3">
            <Link
              href="/sos"
              className="flex items-center gap-2 rounded-2xl border border-red-500/40 bg-red-600/15 p-4 text-sm font-semibold text-red-100 transition-colors hover:bg-red-600/25 focus-visible:ring-2 focus-visible:ring-red-300 focus-visible:outline-none"
            >
              <Siren aria-hidden="true" className="size-5 text-red-300" />
              Send SOS
            </Link>
            <Link
              href="/contacts"
              className="flex items-center gap-2 rounded-2xl border border-purple-500/40 bg-purple-600/15 p-4 text-sm font-semibold text-purple-100 transition-colors hover:bg-purple-600/25 focus-visible:ring-2 focus-visible:ring-purple-300 focus-visible:outline-none"
            >
              <PhoneCall aria-hidden="true" className="size-5 text-purple-300" />
              Trusted contacts
            </Link>
          </nav>
        </div>
        <ErrorBoundary title="SOS history is unavailable" compact>
          <SOSHistory />
        </ErrorBoundary>
      </div>
    </div>
  );
}
