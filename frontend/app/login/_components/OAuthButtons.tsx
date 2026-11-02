"use client";

import { signIn } from "next-auth/react";
import * as React from "react";

import { Spinner } from "@/components/ui/spinner";
import type { OAuthProviderInfo } from "@/lib/auth-providers";

function GitHubMark(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 .5C5.73.5.75 5.48.75 11.75c0 4.97 3.22 9.18 7.69 10.67.56.1.77-.24.77-.54v-1.9c-3.13.68-3.79-1.51-3.79-1.51-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.69.08-.69 1.13.08 1.72 1.16 1.72 1.16 1 1.72 2.63 1.22 3.27.93.1-.73.39-1.22.71-1.5-2.5-.28-5.13-1.25-5.13-5.57 0-1.23.44-2.24 1.16-3.03-.12-.28-.5-1.43.11-2.98 0 0 .95-.3 3.1 1.16a10.8 10.8 0 0 1 5.65 0c2.15-1.46 3.1-1.16 3.1-1.16.61 1.55.23 2.7.11 2.98.72.79 1.16 1.8 1.16 3.03 0 4.33-2.64 5.28-5.15 5.56.4.35.76 1.03.76 2.08v3.08c0 .3.2.65.78.54a11.26 11.26 0 0 0 7.68-10.67C23.25 5.48 18.27.5 12 .5Z" />
    </svg>
  );
}

function GoogleMark(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" {...props}>
      <path
        fill="#FFC107"
        d="M43.6 20.1H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9Z"
      />
      <path
        fill="#FF3D00"
        d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7Z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.5-4.5 2.4-7.2 2.4-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44Z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9Z"
      />
    </svg>
  );
}

const ICONS = { github: GitHubMark, google: GoogleMark } as const;

/** "Continue with GitHub/Google" buttons; renders nothing when no provider is configured. */
export function OAuthButtons({
  providers,
  callbackUrl,
  disabled = false,
}: {
  providers: OAuthProviderInfo[];
  callbackUrl: string;
  disabled?: boolean;
}) {
  const [pending, setPending] = React.useState<string | null>(null);

  if (providers.length === 0) return null;

  return (
    <div className="space-y-4">
      <div className="grid gap-3">
        {providers.map((provider) => {
          const Icon = ICONS[provider.id];
          const isPending = pending === provider.id;
          return (
            <button
              key={provider.id}
              type="button"
              disabled={disabled || pending !== null}
              onClick={() => {
                setPending(provider.id);
                void signIn(provider.id, { callbackUrl }).catch(() => setPending(null));
              }}
              className="inline-flex h-11 w-full items-center justify-center gap-3 rounded-xl border border-slate-700 bg-slate-950/40 px-4 text-sm font-semibold text-slate-100 transition-colors hover:border-slate-500 hover:bg-slate-800/70 focus-visible:ring-3 focus-visible:ring-slate-400/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isPending ? <Spinner size="sm" label={`Redirecting to ${provider.name}`} /> : <Icon className="size-5" />}
              Continue with {provider.name}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-3 text-xs tracking-wider text-slate-500 uppercase">
        <span className="h-px flex-1 bg-slate-700" />
        or use email
        <span className="h-px flex-1 bg-slate-700" />
      </div>
    </div>
  );
}
