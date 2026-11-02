"use client";

import { AnimatePresence, motion, MotionConfig } from "framer-motion";
import { MessageSquareText, PhoneCall, Siren, Trash2, Undo2, UsersRound } from "lucide-react";
import Link from "next/link";
import * as React from "react";

import { AddContactForm } from "@/app/contacts/_components/AddContactForm";
import { ShareStatusCards } from "@/app/contacts/_components/ShareStatusCards";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type Contact,
  contactKey,
  DEFAULT_EMERGENCY_CONTACTS,
  MAX_CUSTOM_CONTACTS,
  useContacts,
} from "@/lib/contacts";
import { useGeolocation } from "@/lib/geo";
import { telHref, toE164 } from "@/lib/phone";
import { cn } from "@/lib/utils";

const UNDO_WINDOW_MS = 6000;

const roundButton =
  "inline-flex size-10 items-center justify-center rounded-full border transition-colors focus-visible:ring-2 focus-visible:outline-none";

function ContactRow({ contact, onRemove }: { contact: Contact; onRemove?: () => void }) {
  const e164 = contact.custom ? toE164(contact.phone) : null;
  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-lg font-bold text-slate-100">
          <span className="truncate">{contact.name}</span>
          {!contact.custom ? (
            <Badge variant="info" uppercase className="text-[10px]">
              Default
            </Badge>
          ) : e164 ? (
            <Badge variant="success" className="text-[10px]">
              SOS ready
            </Badge>
          ) : (
            <Badge variant="warning" className="text-[10px]" title="Add the country code to text this contact during an SOS">
              No country code
            </Badge>
          )}
        </p>
        <p className="mt-1 truncate font-mono text-sm text-slate-400">{contact.phone}</p>
      </div>
      <div className="flex shrink-0 gap-2">
        <a
          href={telHref(contact.phone)}
          aria-label={`Call ${contact.name}`}
          className={cn(roundButton, "border-slate-700 bg-slate-800 text-slate-200 hover:text-green-400 focus-visible:ring-green-300")}
        >
          <PhoneCall aria-hidden="true" className="size-4" />
        </a>
        {contact.custom && (
          <a
            href={`sms:${telHref(contact.phone).slice(4)}`}
            aria-label={`Text ${contact.name}`}
            className={cn(roundButton, "border-slate-700 bg-slate-800 text-slate-200 hover:text-blue-300 focus-visible:ring-blue-300")}
          >
            <MessageSquareText aria-hidden="true" className="size-4" />
          </a>
        )}
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove ${contact.name}`}
            className={cn(roundButton, "border-transparent bg-slate-800 text-slate-300 hover:border-red-500/40 hover:bg-red-900/20 hover:text-red-400 focus-visible:ring-red-300")}
          >
            <Trash2 aria-hidden="true" className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * `/contacts` — trusted contacts stored on this device (shared with `/sos` and `/offline`),
 * "I'm safe" / "I need help" sharing, and a prominent entry point to the SOS flow.
 */
export default function ContactsView() {
  const geo = useGeolocation({ timeoutMs: 10_000 });
  const { contacts, ready, persistent, add, remove, restore } = useContacts();
  const [removed, setRemoved] = React.useState<{ contact: Contact; index: number } | null>(null);

  React.useEffect(() => {
    if (!removed) return;
    const timer = setTimeout(() => setRemoved(null), UNDO_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [removed]);

  const handleRemove = (contact: Contact, index: number) => {
    remove(contact);
    setRemoved({ contact, index });
  };

  const undo = () => {
    if (!removed) return;
    restore(removed.contact, removed.index);
    setRemoved(null);
  };

  const missingCountryCode = contacts.filter((contact) => !toE164(contact.phone)).length;

  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-[calc(100dvh-7.5rem)] bg-gradient-to-b from-slate-900 via-slate-800 to-black p-4 text-white md:p-8">
        <div className="mx-auto w-full max-w-3xl space-y-8">
          <header className="space-y-4 text-center">
            <span
              aria-hidden="true"
              className="mb-2 inline-flex items-center justify-center rounded-full bg-purple-900/30 p-4"
            >
              <PhoneCall className="size-10 text-purple-400" />
            </span>
            <h1 className="text-4xl font-bold tracking-tight text-white md:text-5xl">SOS &amp; Contacts</h1>
            <p className="mx-auto max-w-2xl text-lg text-slate-400">
              Keep your trusted contacts on this device and alert them instantly with your location when you need
              help.
            </p>
          </header>

          <Link
            href="/sos"
            className="group flex items-center gap-4 rounded-3xl border border-red-500/40 bg-gradient-to-r from-red-600/30 to-red-900/30 p-5 transition-colors hover:from-red-600/40 hover:to-red-900/40 focus-visible:ring-2 focus-visible:ring-red-300 focus-visible:outline-none"
          >
            <span
              aria-hidden="true"
              className="inline-flex size-14 shrink-0 items-center justify-center rounded-full bg-red-600 shadow-lg shadow-red-900/50"
            >
              <Siren className="size-7 text-white" />
            </span>
            <span className="min-w-0">
              <span className="block text-xl font-extrabold text-white">Send an SOS</span>
              <span className="block text-sm text-red-100/80">
                Hold one button to text your live location to your contacts — with fallbacks if you&apos;re offline.
              </span>
            </span>
          </Link>

          <ErrorBoundary title="Sharing is unavailable" compact>
            <ShareStatusCards geo={geo} />
          </ErrorBoundary>

          <section
            aria-labelledby="trusted-contacts-title"
            className="rounded-3xl border border-slate-800 bg-slate-950/60 p-6 shadow-sm md:p-8"
          >
            <div className="mb-6 flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="trusted-contacts-title" className="text-2xl font-bold text-slate-100">
                Trusted Contacts
              </h2>
              {ready && (
                <span className="text-sm text-slate-400">
                  {contacts.length}/{MAX_CUSTOM_CONTACTS} saved on this device
                </span>
              )}
            </div>

            {!persistent && (
              <Alert variant="warning" className="mb-6">
                <AlertTitle>Contacts can&apos;t be saved on this device</AlertTitle>
                <AlertDescription>
                  Your browser is blocking storage (private browsing?). Contacts you add now will be forgotten when
                  you close this tab.
                </AlertDescription>
              </Alert>
            )}

            <div className="mb-8">
              <AddContactForm onAdd={add} />
            </div>

            {ready && missingCountryCode > 0 && (
              <Alert variant="info" className="mb-4">
                <AlertDescription>
                  {missingCountryCode === 1 ? "1 contact has" : `${missingCountryCode} contacts have`} no country code
                  and can&apos;t be texted automatically during an SOS. Remove and re-add them starting with + and the
                  country code.
                </AlertDescription>
              </Alert>
            )}

            {removed && (
              <div
                role="status"
                className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-slate-700 bg-slate-900 px-4 py-2.5 text-sm text-slate-200"
              >
                <span>
                  Removed <strong>{removed.contact.name}</strong>.
                </span>
                <button
                  type="button"
                  onClick={undo}
                  className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 font-semibold text-cyan-300 hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:outline-none"
                >
                  <Undo2 aria-hidden="true" className="size-4" />
                  Undo
                </button>
              </div>
            )}

            <ul className="space-y-3" aria-label="Your contacts">
              {!ready ? (
                <li role="status" className="space-y-3">
                  <span className="sr-only">Loading your contacts…</span>
                  <Skeleton className="h-20 rounded-2xl" />
                  <Skeleton className="h-20 rounded-2xl" />
                </li>
              ) : contacts.length === 0 ? (
                <li>
                  <EmptyState
                    compact
                    icon={<UsersRound />}
                    title="No personal contacts yet"
                    message="Add the people who should hear from you in an emergency. They stay on this device only."
                  />
                </li>
              ) : (
                <AnimatePresence initial={false}>
                  {contacts.map((contact, index) => (
                    <motion.li
                      key={contactKey(contact)}
                      layout
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, x: -10 }}
                    >
                      <ContactRow contact={contact} onRemove={() => handleRemove(contact, index)} />
                    </motion.li>
                  ))}
                </AnimatePresence>
              )}
            </ul>

            <h3 className="mt-8 mb-3 text-sm font-semibold tracking-wider text-slate-400 uppercase">
              Emergency services
            </h3>
            <ul className="space-y-3">
              {DEFAULT_EMERGENCY_CONTACTS.map((contact) => (
                <li key={contactKey(contact)}>
                  <ContactRow contact={contact} />
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </MotionConfig>
  );
}
