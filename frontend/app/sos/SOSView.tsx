"use client";

import { RefreshCw, Siren, UserRound, WifiOff } from "lucide-react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import * as React from "react";
import { useSWRConfig } from "swr";

import { ContactPicker } from "@/app/sos/_components/ContactPicker";
import { FallbackActions } from "@/app/sos/_components/FallbackActions";
import { LocationStatus } from "@/app/sos/_components/LocationStatus";
import { MessageComposer } from "@/app/sos/_components/MessageComposer";
import { SOSResultPanel } from "@/app/sos/_components/SOSResultPanel";
import {
  buildLocalSmsBody,
  buildSosRequest,
  DEFAULT_SOS_MESSAGE,
  matchSmsResults,
  MAX_SOS_CONTACTS,
} from "@/app/sos/sos-helpers";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { HoldToConfirmButton } from "@/components/HoldToConfirmButton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { getErrorMessage, isApiError, sendSOS, swrKeys } from "@/lib/api";
import { type SosRecipient, toSosRecipients, useContacts } from "@/lib/contacts";
import { pluralize } from "@/lib/format";
import { useGeolocation } from "@/lib/geo";
import { identityTag } from "@/lib/identity";
import { buildSmsUri } from "@/lib/phone";
import { readSosName, SOS_NAME_STORAGE_KEY, storeSosName } from "@/lib/sos-name";
import type { SOSRequest, SOSResponse } from "@/lib/types";

/** Sender name remembered on this device between SOS uses (see `lib/sos-name.ts`). */
export { SOS_NAME_STORAGE_KEY };

type Phase =
  | { kind: "idle" }
  | { kind: "sending"; request: SOSRequest; recipients: SosRecipient[] }
  | { kind: "sent"; request: SOSRequest; recipients: SosRecipient[]; response: SOSResponse }
  | { kind: "failed"; request: SOSRequest; recipients: SosRecipient[]; error: unknown; offline: boolean };

/**
 * The `/sos` experience: press-and-hold to send the live location to selected contacts,
 * with per-number results and fallbacks (native SMS app, share, call 112) whenever the
 * server can't text — or can't be reached at all.
 */
export default function SOSView() {
  const { data: session, status: sessionStatus } = useSession();
  const { mutate } = useSWRConfig();
  const [phase, setPhase] = React.useState<Phase>({ kind: "idle" });

  // Live, high-accuracy tracking until the SOS is sent (then a single fix saves battery).
  const geo = useGeolocation({
    enableHighAccuracy: true,
    watch: phase.kind !== "sent",
    timeoutMs: 20_000,
    maximumAgeMs: 10_000,
  });
  const location = React.useMemo(
    () => (geo.coords ? { lat: geo.coords.lat, lon: geo.coords.lon, accuracy: geo.coords.accuracy } : null),
    [geo.coords],
  );

  const { contacts, ready: contactsReady } = useContacts();
  const recipients = React.useMemo(() => toSosRecipients(contacts), [contacts]);
  const [selected, setSelected] = React.useState<string[]>([]);
  const selectionInitialized = React.useRef(false);

  const [message, setMessage] = React.useState(DEFAULT_SOS_MESSAGE);
  const [name, setName] = React.useState("");
  const nameTouched = React.useRef(false);

  const abortRef = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => abortRef.current?.abort(), []);

  // Select every textable contact once contacts load; later, drop numbers that were removed.
  React.useEffect(() => {
    if (!contactsReady) return;
    const textable = [...new Set(recipients.map((r) => r.e164).filter((n): n is string => !!n))];
    if (!selectionInitialized.current) {
      selectionInitialized.current = true;
      setSelected(textable.slice(0, MAX_SOS_CONTACTS));
      return;
    }
    setSelected((previous) => previous.filter((number) => textable.includes(number)));
  }, [contactsReady, recipients]);

  // Prefill the sender name once the session is known: the name this identity used last
  // time, else the account name. A name remembered for another account (or for anonymous
  // use) is never offered, so Bob's SOS cannot go out as "SOS from Alice".
  const sessionName = session?.user?.name ?? "";
  const owner = identityTag(session?.user?.id);
  React.useEffect(() => {
    if (nameTouched.current || sessionStatus === "loading") return;
    setName(readSosName(owner) || sessionName);
  }, [owner, sessionName, sessionStatus]);

  const toggleContact = React.useCallback((e164: string) => {
    setSelected((previous) => {
      if (previous.includes(e164)) return previous.filter((number) => number !== e164);
      if (previous.length >= MAX_SOS_CONTACTS) return previous;
      return [...previous, e164];
    });
  }, []);

  const send = React.useCallback(async () => {
    if (!location) return;
    const chosen = recipients.filter((recipient) => recipient.e164 && selected.includes(recipient.e164));
    const request = buildSosRequest({
      location,
      message,
      numbers: chosen.map((recipient) => recipient.e164 as string),
      userName: name,
    });
    storeSosName(name, owner);

    // Known offline: don't wait for a timeout — go straight to the phone's own tools.
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setPhase({ kind: "failed", request, recipients: chosen, error: null, offline: true });
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase({ kind: "sending", request, recipients: chosen });
    try {
      const response = await sendSOS(request, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setPhase({ kind: "sent", request, recipients: chosen, response });
      void mutate(swrKeys.sosHistory());
    } catch (error) {
      if (controller.signal.aborted) return;
      console.warn("[sos] request failed", error);
      // "Offline" only when the browser says so; a network error while online means the
      // server is unreachable (shown with the API error message).
      const offline = isApiError(error) && error.isNetworkError && navigator.onLine === false;
      setPhase({ kind: "failed", request, recipients: chosen, error, offline });
    }
  }, [location, message, mutate, name, owner, recipients, selected]);

  const reset = () => setPhase({ kind: "idle" });

  // Fallback SMS (used when the request fails or before sending without a location).
  const fallbackNumbers = phase.kind === "idle" ? selected : phase.request.contact_numbers;
  const localBody = buildLocalSmsBody({ name, message, location });
  const localSmsUri = buildSmsUri(fallbackNumbers, localBody);

  const busy = phase.kind === "sending";
  const selectedCount = selected.length;
  const sublabel =
    selectedCount > 0 ? `Texts ${pluralize(selectedCount, "contact")} your location` : "Records & shares your location";

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          {phase.kind === "sent" ? (
            <SOSResultPanel
              response={phase.response}
              outcomes={matchSmsResults(phase.response.sms, phase.recipients)}
              recipientCount={phase.request.contact_numbers.length}
              shareText={buildLocalSmsBody({
                name,
                message: phase.request.message ?? message,
                location: { lat: phase.request.lat, lon: phase.request.lon },
              })}
              localSmsUri={localSmsUri}
              onDone={reset}
            />
          ) : (
            <section
              aria-labelledby="sos-send-title"
              className="space-y-5 rounded-3xl border border-red-500/30 bg-red-950/20 p-5 backdrop-blur-md sm:p-6"
            >
              <h2 id="sos-send-title" className="sr-only">
                Send SOS
              </h2>

              {phase.kind === "failed" && (
                <div className="space-y-4">
                  <Alert variant="destructive" icon={phase.offline ? <WifiOff /> : undefined}>
                    <AlertTitle>
                      {phase.offline ? "You're offline — SOS not sent automatically" : "Couldn't send your SOS"}
                    </AlertTitle>
                    <AlertDescription>
                      {phase.offline
                        ? "Use your phone instead: open your SMS app with the message ready to send, share your location, or call 112."
                        : `${getErrorMessage(phase.error)} Use the options below to get help right now.`}
                    </AlertDescription>
                  </Alert>
                  <FallbackActions smsUri={localSmsUri} emphasizeSms shareText={localBody} />
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void send()}
                      disabled={!location}
                      className="inline-flex items-center gap-2 rounded-xl border border-slate-600 px-4 py-2.5 text-sm font-semibold text-slate-100 transition-colors hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:outline-none disabled:opacity-50"
                    >
                      <RefreshCw aria-hidden="true" className="size-4" />
                      Try sending again
                    </button>
                    <button
                      type="button"
                      onClick={reset}
                      className="rounded-xl px-4 py-2.5 text-sm font-medium text-slate-300 hover:text-white focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:outline-none"
                    >
                      Back
                    </button>
                  </div>
                </div>
              )}

              {phase.kind !== "failed" && (
                <>
                  <HoldToConfirmButton
                    label="Hold to send SOS"
                    holdingLabel="Keep holding…"
                    sublabel={sublabel}
                    confirmLabel="Send SOS now"
                    armLabel="Can't press and hold? Tap here to send in two steps"
                    icon={<Siren />}
                    busy={busy}
                    busyLabel="Sending SOS…"
                    disabled={!location}
                    onConfirm={() => void send()}
                  />
                  {!location && (
                    <p role="status" className="text-center text-sm text-amber-200">
                      {geo.status === "idle" || geo.status === "locating"
                        ? "Waiting for your location before an SOS can be sent…"
                        : "An SOS needs your location. Allow location access, or use the options below."}
                    </p>
                  )}
                </>
              )}

              <p className="flex items-center justify-center gap-2 text-center text-xs text-slate-400">
                <UserRound aria-hidden="true" className="size-3.5" />
                {sessionStatus === "authenticated" ? (
                  <span>Signed in — this SOS will be saved to your profile history.</span>
                ) : (
                  <span>
                    <Link href="/login?callbackUrl=%2Fsos" className="text-cyan-300 hover:underline">
                      Sign in
                    </Link>{" "}
                    to keep a history of your SOS alerts.
                  </span>
                )}
              </p>
            </section>
          )}

          <ErrorBoundary title="Location status is unavailable" compact>
            <LocationStatus geo={geo} />
          </ErrorBoundary>
        </div>

        <div className="space-y-4">
          <ErrorBoundary title="Contacts couldn't be shown" compact>
            <ContactPicker
              recipients={recipients}
              selected={selected}
              onToggle={toggleContact}
              ready={contactsReady}
              disabled={busy || phase.kind === "sent"}
            />
          </ErrorBoundary>
          <MessageComposer
            message={message}
            onMessageChange={setMessage}
            name={name}
            onNameChange={(value) => {
              nameTouched.current = true;
              setName(value);
            }}
            disabled={busy || phase.kind === "sent"}
          />
        </div>
      </div>

      {(phase.kind === "idle" || phase.kind === "sending") && (
        <section
          aria-labelledby="sos-other-ways"
          className="rounded-2xl border border-slate-700 bg-slate-800/40 p-4 backdrop-blur-md sm:p-5"
        >
          <h2 id="sos-other-ways" className="text-base font-semibold text-white">
            Other ways to get help
          </h2>
          <p className="mb-4 text-sm text-slate-400">
            These work even without ResQ AI&apos;s servers: your SMS app opens with the message ready to send.
          </p>
          <FallbackActions smsUri={localSmsUri} emphasizeSms={!location} shareText={localBody} />
        </section>
      )}
    </div>
  );
}
