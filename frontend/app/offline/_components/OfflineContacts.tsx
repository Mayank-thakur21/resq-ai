"use client";

import { MessageSquareText, Phone, UserRound } from "lucide-react";
import Link from "next/link";

import { EmptyState } from "@/components/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { useContacts } from "@/lib/contacts";
import { telHref } from "@/lib/phone";

/**
 * The user's saved contacts (from this device's localStorage) with call / text links, for
 * the offline page. Works without any network request.
 */
export function OfflineContacts() {
  const { contacts, ready } = useContacts();

  return (
    <section aria-labelledby="offline-contacts" className="space-y-3">
      <h2 id="offline-contacts" className="text-xl font-bold">
        Your saved contacts
      </h2>
      {!ready ? (
        <div role="status" className="grid gap-3 sm:grid-cols-2">
          <span className="sr-only">Loading saved contacts…</span>
          <Skeleton className="h-16 rounded-2xl" />
          <Skeleton className="h-16 rounded-2xl" />
        </div>
      ) : contacts.length === 0 ? (
        <EmptyState
          compact
          icon={<UserRound />}
          title="No contacts saved on this device"
          message="Add family and friends on the Contacts page so they're here when you're offline."
          action={
            <Link
              href="/contacts"
              className="rounded-lg border border-slate-600 px-3 py-1.5 text-sm font-semibold text-slate-200 hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:outline-none"
            >
              Manage contacts
            </Link>
          }
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {contacts.map((contact) => (
            <li
              key={`${contact.phone}|${contact.name}`}
              className="flex items-center justify-between gap-3 rounded-2xl border border-slate-700 bg-slate-800/50 p-4"
            >
              <div className="min-w-0">
                <p className="truncate font-semibold text-white">{contact.name}</p>
                <p className="truncate font-mono text-sm text-slate-400">{contact.phone}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                <a
                  href={telHref(contact.phone)}
                  aria-label={`Call ${contact.name}`}
                  className="inline-flex size-10 items-center justify-center rounded-full bg-emerald-600/20 text-emerald-300 transition-colors hover:bg-emerald-600/30 focus-visible:ring-2 focus-visible:ring-emerald-300 focus-visible:outline-none"
                >
                  <Phone aria-hidden="true" className="size-4" />
                </a>
                <a
                  href={`sms:${telHref(contact.phone).slice(4)}`}
                  aria-label={`Text ${contact.name}`}
                  className="inline-flex size-10 items-center justify-center rounded-full bg-blue-600/20 text-blue-300 transition-colors hover:bg-blue-600/30 focus-visible:ring-2 focus-visible:ring-blue-300 focus-visible:outline-none"
                >
                  <MessageSquareText aria-hidden="true" className="size-4" />
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default OfflineContacts;
