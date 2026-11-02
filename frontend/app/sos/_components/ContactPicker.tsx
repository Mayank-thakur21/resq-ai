"use client";

import { CircleAlert, Settings2, UsersRound } from "lucide-react";
import Link from "next/link";

import { MAX_SOS_CONTACTS } from "@/app/sos/sos-helpers";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import type { SosRecipient } from "@/lib/contacts";
import { cn } from "@/lib/utils";

export interface ContactPickerProps {
  recipients: readonly SosRecipient[];
  /** Selected E.164 numbers. */
  selected: readonly string[];
  onToggle: (e164: string) => void;
  ready: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * Chooses which saved contacts receive the SOS text. Only numbers that can be converted to
 * international E.164 format are selectable (the SMS gateway needs the country code); the
 * others explain how to fix them. At most {@link MAX_SOS_CONTACTS} can be selected.
 */
export function ContactPicker({ recipients, selected, onToggle, ready, disabled = false, className }: ContactPickerProps) {
  const selectable = recipients.filter((recipient) => recipient.e164);
  const atLimit = selected.length >= MAX_SOS_CONTACTS;

  return (
    <section
      aria-labelledby="sos-contacts-title"
      className={cn("rounded-2xl border border-slate-700 bg-slate-800/50 p-4 backdrop-blur-md", className)}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 id="sos-contacts-title" className="text-base font-semibold text-white">
            Text my contacts
          </h2>
          <p className="text-sm text-slate-400" aria-live="polite">
            {ready && selectable.length > 0
              ? `${selected.length} of ${Math.min(selectable.length, MAX_SOS_CONTACTS)} selected`
              : "Your location is sent to these numbers by SMS."}
          </p>
        </div>
        <Link
          href="/contacts"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-600 px-3 py-1.5 text-xs font-semibold text-slate-200 transition-colors hover:bg-slate-700/60 focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:outline-none"
        >
          <Settings2 aria-hidden="true" className="size-3.5" />
          Manage
        </Link>
      </div>

      {!ready ? (
        <div role="status" className="space-y-2">
          <span className="sr-only">Loading your contacts…</span>
          <Skeleton className="h-12 rounded-xl" />
          <Skeleton className="h-12 rounded-xl" />
        </div>
      ) : recipients.length === 0 ? (
        <EmptyState
          compact
          icon={<UsersRound />}
          title="No trusted contacts yet"
          message="Add family or friends with their country code (e.g. +91…). You can still send an SOS to record and share your location."
          action={
            <Link
              href="/contacts"
              className="rounded-lg bg-purple-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-purple-500 focus-visible:ring-2 focus-visible:ring-purple-300 focus-visible:outline-none"
            >
              Add contacts
            </Link>
          }
        />
      ) : (
        <fieldset disabled={disabled} className="space-y-2">
          <legend className="sr-only">Contacts to text</legend>
          {recipients.map(({ contact, e164 }) => {
            const key = `${contact.phone}|${contact.name}`;
            if (!e164) {
              return (
                <div
                  key={key}
                  className="flex items-start gap-3 rounded-xl border border-dashed border-slate-700 px-3 py-2.5 text-sm opacity-90"
                >
                  <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber-300" />
                  <div className="min-w-0">
                    <p className="truncate font-medium text-slate-200">
                      {contact.name} <span className="font-mono text-slate-400">{contact.phone}</span>
                    </p>
                    <p className="text-xs text-amber-200/90">
                      Can&apos;t be texted automatically — add the country code (e.g. +91…) on the Contacts page.
                    </p>
                  </div>
                </div>
              );
            }
            const checked = selected.includes(e164);
            const blocked = !checked && atLimit;
            return (
              <label
                key={key}
                className={cn(
                  "flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 text-sm transition-colors",
                  checked ? "border-red-500/40 bg-red-500/10" : "border-slate-700 hover:border-slate-600",
                  (blocked || disabled) && "cursor-not-allowed opacity-60",
                )}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={blocked || disabled}
                  onChange={() => onToggle(e164)}
                  className="size-5 shrink-0 accent-red-500"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-slate-100">{contact.name}</span>
                  <span className="block truncate font-mono text-xs text-slate-400">{e164}</span>
                </span>
              </label>
            );
          })}
          {atLimit && selectable.length > MAX_SOS_CONTACTS && (
            <p className="text-xs text-slate-400">You can text up to {MAX_SOS_CONTACTS} contacts per SOS.</p>
          )}
        </fieldset>
      )}
    </section>
  );
}

export default ContactPicker;
