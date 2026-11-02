"use client";

import { motion } from "framer-motion";
import {
  Activity,
  CircleAlert,
  CircleCheck,
  FileText,
  Phone,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  Volume2,
} from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";

import { PlacesList } from "@/app/chat/_components/PlacesList";
import type { AssistantMessage, ErrorMessage, UserMessage } from "@/app/chat/chat-helpers";
import { parseEmergencyNumber } from "@/app/chat/chat-helpers";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { humanize, safeHttpUrl } from "@/lib/format";
import { telHref } from "@/lib/phone";

/** Markdown renderer overrides: safe external links only, no raw HTML (react-markdown default). */
const markdownComponents: Components = {
  a: ({ href, children }) => {
    const safe = safeHttpUrl(href);
    if (!safe) return <span>{children}</span>;
    return (
      <a href={safe} target="_blank" rel="noopener noreferrer" className="text-cyan-300 underline underline-offset-2">
        {children}
      </a>
    );
  },
};

export function UserBubble({ message }: { message: UserMessage }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[90%] rounded-2xl rounded-tr-sm bg-blue-600 p-4 whitespace-pre-wrap text-white shadow-sm md:max-w-[80%]">
        {message.content}
      </div>
    </div>
  );
}

export function AssistantBubble({
  message,
  onSpeak,
  canSpeak,
}: {
  message: AssistantMessage;
  onSpeak?: (text: string) => void;
  canSpeak?: boolean;
}) {
  const meta = message.meta;
  const numbers = meta?.emergencyNumbers.map(parseEmergencyNumber).filter((entry) => entry.number) ?? [];

  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[95%] space-y-3 md:max-w-[85%]">
        {meta && meta.steps.length > 0 && (
          <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-3 font-mono text-xs text-slate-400">
            <div className="mb-2 flex items-center gap-2 font-semibold text-slate-300">
              <Activity aria-hidden="true" className="size-4" /> Agent trace
            </div>
            <ul className="space-y-1">
              {meta.steps.map((step, index) => (
                <motion.li
                  key={`${index}-${step}`}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: Math.min(index, 8) * 0.12 }}
                  className="flex items-start gap-2"
                >
                  <CircleCheck aria-hidden="true" className="mt-px size-3.5 shrink-0 text-emerald-400" />
                  {step}
                </motion.li>
              ))}
            </ul>
          </div>
        )}

        <div className="rounded-2xl rounded-tl-sm border border-slate-700 bg-slate-900 p-4 shadow-sm">
          {meta && (meta.disaster || meta.urgency !== "low" || meta.agentUsed) && (
            <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-slate-800 pb-3">
              {meta.disaster && (
                <Badge variant="destructive" uppercase>
                  <TriangleAlert aria-hidden="true" />
                  {humanize(meta.disaster)}
                </Badge>
              )}
              <Badge variant={meta.urgency} uppercase>
                Urgency: {meta.urgency}
              </Badge>
              {meta.agentUsed && <Badge variant="outline">{humanize(meta.agentUsed)}</Badge>}
            </div>
          )}

          <div className="space-y-2 text-sm leading-relaxed text-slate-200 [&_h1]:text-lg [&_h1]:font-bold [&_h2]:text-base [&_h2]:font-bold [&_h3]:font-semibold [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_strong]:font-semibold [&_strong]:text-white [&_ul]:list-disc [&_ul]:pl-5">
            <ReactMarkdown components={markdownComponents}>{message.content}</ReactMarkdown>
          </div>

          {meta && (
            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
              {meta.actions.length > 0 && (
                <div className="rounded-lg border border-blue-900/40 bg-blue-900/10 p-3">
                  <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold text-blue-300">
                    <ShieldCheck aria-hidden="true" className="size-4" /> Actions
                  </h4>
                  <ul className="list-inside list-disc space-y-1 text-xs text-slate-300">
                    {meta.actions.map((action, index) => (
                      <li key={`${index}-${action}`}>{action}</li>
                    ))}
                  </ul>
                </div>
              )}

              {numbers.length > 0 && (
                <div className="rounded-lg border border-red-900/40 bg-red-900/10 p-3">
                  <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold text-red-300">
                    <Phone aria-hidden="true" className="size-4" /> Emergency numbers
                  </h4>
                  <ul className="flex flex-wrap gap-2 text-xs">
                    {numbers.map(({ number, label }) => (
                      <li key={`${number}-${label}`}>
                        <a
                          href={telHref(number)}
                          aria-label={label ? `Call ${number}, ${label}` : `Call ${number}`}
                          className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-2 py-1 font-mono text-slate-100 hover:border-red-400/60 focus-visible:ring-2 focus-visible:ring-red-300 focus-visible:outline-none"
                        >
                          <span className="font-bold">{number}</span>
                          {label && <span className="font-sans text-slate-400">{label}</span>}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {meta.advisory && (
                <div className="rounded-lg border border-amber-900/40 bg-amber-900/10 p-3 md:col-span-2">
                  <h4 className="mb-1 flex items-center gap-2 text-sm font-semibold text-amber-300">
                    <FileText aria-hidden="true" className="size-4" /> Weather advisory
                  </h4>
                  <p className="text-xs leading-relaxed text-slate-300">{meta.advisory}</p>
                </div>
              )}

              {meta.hospitals.length > 0 && <PlacesList kind="hospitals" places={meta.hospitals} />}
              {meta.shelters.length > 0 && <PlacesList kind="shelters" places={meta.shelters} />}
            </div>
          )}

          {canSpeak && onSpeak && (
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                onClick={() => onSpeak(message.content)}
                className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-slate-400 hover:bg-slate-800 hover:text-slate-200 focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:outline-none"
              >
                <Volume2 aria-hidden="true" className="size-3.5" />
                Read aloud
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function ErrorBubble({ message, onRetry, disabled }: { message: ErrorMessage; onRetry: () => void; disabled?: boolean }) {
  return (
    <div className="flex justify-start">
      <div
        role="alert"
        className="w-full max-w-[95%] rounded-2xl rounded-tl-sm border border-red-500/40 bg-red-950/40 p-4 text-sm text-red-100 md:max-w-[85%]"
      >
        <p className="flex items-start gap-2">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-red-300" />
          <span>{message.content}</span>
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onRetry}
            disabled={disabled}
            className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-500 focus-visible:ring-2 focus-visible:ring-red-300 focus-visible:outline-none disabled:opacity-60"
          >
            <RefreshCw aria-hidden="true" className="size-3.5" />
            Retry
          </button>
          {message.network && (
            <a
              href="tel:112"
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-400/40 px-3 py-1.5 text-xs font-semibold text-red-100 hover:bg-red-500/10 focus-visible:ring-2 focus-visible:ring-red-300 focus-visible:outline-none"
            >
              <Phone aria-hidden="true" className="size-3.5" />
              Emergency? Call 112
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

/** Assistant "typing" placeholder while the agents work. */
export function TypingIndicator() {
  return (
    <div className="flex justify-start" role="status" aria-live="polite">
      <div className="w-full max-w-[85%] rounded-2xl rounded-tl-sm border border-slate-700 bg-slate-900 p-4 shadow-sm md:max-w-[60%]">
        <div className="mb-3 flex items-center gap-2 text-sm text-slate-400">
          <span className="flex gap-1" aria-hidden="true">
            {[0, 150, 300].map((delay) => (
              <span
                key={delay}
                className="size-1.5 rounded-full bg-blue-400 motion-safe:animate-bounce"
                style={{ animationDelay: `${delay}ms` }}
              />
            ))}
          </span>
          Agents are analysing your request…
        </div>
        <div className="space-y-2">
          <Skeleton className="h-3 w-11/12" />
          <Skeleton className="h-3 w-4/5" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      </div>
    </div>
  );
}
