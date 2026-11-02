/**
 * Web Push helpers (browser only).
 *
 * Flow for {@link subscribe}:
 *
 *   support check ─> VAPID key from the backend (enabled?) ─> notification permission
 *     ─> service worker registration ─> pushManager.subscribe ─> POST /push/subscribe
 *
 * Every failure is reported as a {@link PushError} with a machine-readable `code`, so the UI
 * can show a specific, actionable message (unsupported browser, permission denied, push
 * disabled on the server, ...) instead of a generic error. Backend/network failures surface
 * as the `ApiError` thrown by `lib/api.ts`.
 *
 * Preferences used for the last successful subscription (radius, topics, rounded location)
 * are remembered in `localStorage` so the toggle can show them and re-sync the server.
 *
 * Account link: the backend links a subscription to the user whose JWT accompanies the
 * `subscribe` call. The once-per-session re-sync marker is therefore keyed by endpoint **and**
 * identity (`<endpoint>|<user id or "anon">`), so signing in re-posts the subscription with
 * the new identity, and signing out calls {@link unlinkCurrentSubscription} so the next
 * person using the device does not receive the previous user's notifications.
 *
 * Not a "use client" module, but every function touches browser APIs and must only be
 * called from effects / event handlers.
 */

import {
  getVapidPublicKey,
  subscribePush,
  unlinkPush,
  unsubscribePush,
  type RequestOptions,
} from "@/lib/api";
import { serviceWorkerUrl } from "@/lib/sw-url";
import type { PushSubscribeRequest, PushSubscribeResponse, PushTopic, WebPushSubscriptionJSON } from "@/lib/types";

/**
 * Service worker script (served by `public/sw.js`, owned by the PWA feature). Same versioned
 * URL as `PwaRegister`, so registering from here never downgrades or duplicates the worker.
 */
export const SERVICE_WORKER_URL = serviceWorkerUrl();
export const PUSH_PREFS_STORAGE_KEY = "resq_push_prefs";
/** sessionStorage: `<endpoint>|<identity>` of the last subscription posted to the backend. */
export const PUSH_SYNCED_STORAGE_KEY = "resq_push_synced";
const SYNCED_STORAGE_KEY = PUSH_SYNCED_STORAGE_KEY;
/** Identity used in the re-sync marker for signed-out visitors. */
export const ANONYMOUS_PUSH_IDENTITY = "anon";

export const DEFAULT_PUSH_RADIUS_KM = 50;
export const PUSH_RADIUS_OPTIONS_KM: readonly number[] = [10, 25, 50, 100, 250, 500];
export const ALL_PUSH_TOPICS: readonly PushTopic[] = ["incidents", "disasters"];

/** Coordinates sent to the backend are rounded to 3 decimals (≈ 110 m) for privacy. */
const LOCATION_DECIMALS = 3;
/** Give up waiting for `navigator.serviceWorker.ready` after this long. */
const SW_READY_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------

export type PushErrorCode =
  /** Browser lacks service workers / Push API / Notifications. */
  | "unsupported"
  /** Page is not served over HTTPS (or localhost). */
  | "insecure"
  /** The backend has no VAPID keys configured (`enabled: false`). */
  | "disabled"
  /** The backend returned a malformed VAPID public key. */
  | "invalid_key"
  /** The user (or browser policy) blocked notifications. */
  | "denied"
  /** The permission prompt was dismissed without a choice. */
  | "dismissed"
  /** No service worker could be registered / became ready. */
  | "no_service_worker"
  /** `pushManager.subscribe()` failed (push service unreachable, etc.). */
  | "subscribe_failed"
  /** Removing the browser subscription failed. */
  | "unsubscribe_failed";

const DEFAULT_MESSAGES: Record<PushErrorCode, string> = {
  unsupported: "This browser doesn't support push notifications.",
  insecure: "Push notifications need a secure (HTTPS) connection.",
  disabled: "Push notifications aren't set up on this server yet.",
  invalid_key: "The server's push configuration is invalid. Please try again later.",
  denied:
    "Notifications are blocked for this site. Allow them in your browser's site settings, then try again.",
  dismissed: "Notification permission wasn't granted. Try again and choose “Allow”.",
  no_service_worker:
    "The offline service worker isn't available, so notifications can't be delivered. Reload the page and try again.",
  subscribe_failed: "Couldn't register this device for notifications. Please try again.",
  unsubscribe_failed: "Couldn't turn off notifications on this device. Please try again.",
};

export class PushError extends Error {
  readonly code: PushErrorCode;

  constructor(code: PushErrorCode, message?: string, options?: { cause?: unknown }) {
    super(message ?? DEFAULT_MESSAGES[code], options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "PushError";
    this.code = code;
  }
}

export function isPushError(error: unknown): error is PushError {
  return error instanceof PushError;
}

// ---------------------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------------------

/**
 * Decodes a base64url string (as produced by `web-push generate-vapid-keys`) into bytes
 * for `pushManager.subscribe({ applicationServerKey })`.
 *
 * @throws {TypeError} when the input is not valid base64/base64url.
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const trimmed = base64String.trim();
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(trimmed)) {
    throw new TypeError("Invalid base64url string");
  }
  const unpadded = trimmed.replace(/=+$/, "");
  const padding = "=".repeat((4 - (unpadded.length % 4)) % 4);
  const base64 = (unpadded + padding).replace(/-/g, "+").replace(/_/g, "/");
  let raw: string;
  try {
    raw = atob(base64);
  } catch (error) {
    throw new TypeError("Invalid base64url string", { cause: error });
  }
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

/** Decodes and validates a VAPID public key (65-byte uncompressed P-256 point). */
export function decodeVapidPublicKey(key: string): Uint8Array<ArrayBuffer> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = urlBase64ToUint8Array(key);
  } catch (error) {
    throw new PushError("invalid_key", undefined, { cause: error });
  }
  if (bytes.length !== 65 || bytes[0] !== 0x04) {
    throw new PushError("invalid_key");
  }
  return bytes;
}

function bytesEqual(a: ArrayBuffer | ArrayBufferView | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const view =
    a instanceof ArrayBuffer ? new Uint8Array(a) : new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  if (view.length !== b.length) return false;
  for (let i = 0; i < view.length; i += 1) if (view[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------------------

export type PushUnsupportedReason =
  /** Server render / non-browser environment. */
  | "no_window"
  /** Not a secure context (HTTPS / localhost required). */
  | "insecure"
  /** Missing service worker, Push API or Notification API. */
  | "no_api";

export type PushSupport =
  | { supported: true }
  | {
      supported: false;
      reason: PushUnsupportedReason;
      /** iOS/iPadOS Safari only supports push for apps added to the Home Screen (16.4+). */
      iosNeedsInstall: boolean;
    };

/** True on iPhone/iPod/iPad, including iPadOS which reports itself as a Mac. */
export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && typeof navigator.maxTouchPoints === "number" && navigator.maxTouchPoints > 1;
}

/** True when running as an installed PWA (standalone display mode). */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  let displayStandalone = false;
  try {
    displayStandalone = window.matchMedia?.("(display-mode: standalone)").matches ?? false;
  } catch {
    displayStandalone = false;
  }
  return iosStandalone || displayStandalone;
}

/** Detailed support check (see {@link isPushSupported} for the boolean form). */
export function getPushSupport(): PushSupport {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return { supported: false, reason: "no_window", iosNeedsInstall: false };
  }
  if (window.isSecureContext === false) {
    return { supported: false, reason: "insecure", iosNeedsInstall: false };
  }
  const hasApis =
    "serviceWorker" in navigator &&
    !!navigator.serviceWorker &&
    "PushManager" in window &&
    "Notification" in window;
  if (!hasApis) {
    return { supported: false, reason: "no_api", iosNeedsInstall: isIOS() && !isStandalone() };
  }
  return { supported: true };
}

/** Whether this browser can receive web push notifications at all. */
export function isPushSupported(): boolean {
  return getPushSupport().supported;
}

/** Current notification permission, or `"unsupported"` without the Notification API. */
export function getNotificationPermission(): NotificationPermission | "unsupported" {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission;
}

function assertSupported(): void {
  const support = getPushSupport();
  if (support.supported) return;
  throw new PushError(support.reason === "insecure" ? "insecure" : "unsupported");
}

/** Asks for notification permission (handles Safari's legacy callback-only API). */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (getNotificationPermission() === "unsupported") throw new PushError("unsupported");
  if (Notification.permission !== "default") return Notification.permission;
  return new Promise<NotificationPermission>((resolve, reject) => {
    try {
      const maybePromise = Notification.requestPermission(resolve);
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then(resolve, reject);
      }
    } catch (error) {
      reject(error);
    }
  });
}

// ---------------------------------------------------------------------------------------
// Service worker
// ---------------------------------------------------------------------------------------

/** Mirrors `PwaRegister`: the service worker only runs in production unless opted in. */
function serviceWorkerAllowed(): boolean {
  return process.env.NODE_ENV === "production" || process.env.NEXT_PUBLIC_ENABLE_SW_IN_DEV === "true";
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function existingRegistration(): Promise<ServiceWorkerRegistration | undefined> {
  try {
    return await navigator.serviceWorker.getRegistration("/");
  } catch {
    return undefined;
  }
}

/**
 * Resolves the active service worker registration, registering `/sw.js` when the PWA layer
 * has not done so yet (e.g. the user toggles push before `PwaRegister` ran).
 */
async function getServiceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  let registration = await existingRegistration();
  if (!registration) {
    if (!serviceWorkerAllowed()) {
      throw new PushError(
        "no_service_worker",
        "Push notifications need the service worker, which is disabled in development. Set NEXT_PUBLIC_ENABLE_SW_IN_DEV=true to test them.",
      );
    }
    try {
      registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: "/" });
    } catch (error) {
      throw new PushError("no_service_worker", undefined, { cause: error });
    }
  }
  if (registration.active) return registration;
  return withTimeout(
    navigator.serviceWorker.ready,
    SW_READY_TIMEOUT_MS,
    () => new PushError("no_service_worker"),
  );
}

/** The browser's current push subscription for this site, or `null`. Never throws. */
export async function getCurrentSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const registration = await existingRegistration();
  if (!registration?.pushManager) return null;
  try {
    return await registration.pushManager.getSubscription();
  } catch (error) {
    console.warn("[push] could not read the current subscription", error);
    return null;
  }
}

// ---------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------

export type PushStatus =
  | { state: "unsupported"; support: Extract<PushSupport, { supported: false }> }
  | { state: "denied" }
  | { state: "subscribed"; subscription: PushSubscription; prefs: PushPreferences | null }
  | { state: "unsubscribed" };

/** Combined browser-side status: support, permission and current subscription. */
export async function getPushStatus(): Promise<PushStatus> {
  const support = getPushSupport();
  if (!support.supported) return { state: "unsupported", support };
  if (getNotificationPermission() === "denied") return { state: "denied" };
  const subscription = await getCurrentSubscription();
  if (subscription) return { state: "subscribed", subscription, prefs: loadPushPreferences() };
  return { state: "unsubscribed" };
}

// ---------------------------------------------------------------------------------------
// Preferences (localStorage; every access guarded — private mode / disabled storage)
// ---------------------------------------------------------------------------------------

export interface PushPreferences {
  radiusKm: number;
  topics: PushTopic[];
  /** Rounded location the subscription was registered with (absent = no location). */
  lat?: number;
  lon?: number;
}

function isTopic(value: unknown): value is PushTopic {
  return value === "incidents" || value === "disasters";
}

export function loadPushPreferences(): PushPreferences | null {
  try {
    const raw = window.localStorage.getItem(PUSH_PREFS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PushPreferences> | null;
    if (!parsed || typeof parsed !== "object") return null;
    const radiusKm =
      typeof parsed.radiusKm === "number" && parsed.radiusKm >= 1 && parsed.radiusKm <= 500
        ? parsed.radiusKm
        : DEFAULT_PUSH_RADIUS_KM;
    const topics = Array.isArray(parsed.topics) ? parsed.topics.filter(isTopic) : [];
    const prefs: PushPreferences = { radiusKm, topics: topics.length ? topics : [...ALL_PUSH_TOPICS] };
    if (
      typeof parsed.lat === "number" &&
      typeof parsed.lon === "number" &&
      Math.abs(parsed.lat) <= 90 &&
      Math.abs(parsed.lon) <= 180
    ) {
      prefs.lat = parsed.lat;
      prefs.lon = parsed.lon;
    }
    return prefs;
  } catch {
    return null;
  }
}

function savePushPreferences(prefs: PushPreferences): void {
  try {
    window.localStorage.setItem(PUSH_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable: preferences simply won't be remembered.
  }
}

function clearPushPreferences(): void {
  try {
    window.localStorage.removeItem(PUSH_PREFS_STORAGE_KEY);
    window.sessionStorage.removeItem(SYNCED_STORAGE_KEY);
  } catch {
    // ignore
  }
}

function syncMarker(endpoint: string, identity: string | null | undefined): string {
  return `${endpoint}|${identity || ANONYMOUS_PUSH_IDENTITY}`;
}

function markSynced(endpoint: string, identity: string | null | undefined): void {
  try {
    window.sessionStorage.setItem(SYNCED_STORAGE_KEY, syncMarker(endpoint, identity));
  } catch {
    // ignore
  }
}

function isSynced(endpoint: string, identity: string | null | undefined): boolean {
  try {
    return window.sessionStorage.getItem(SYNCED_STORAGE_KEY) === syncMarker(endpoint, identity);
  } catch {
    return false;
  }
}

/** Forgets the re-sync marker so the next page view re-posts the subscription. */
export function clearPushSyncMarker(): void {
  try {
    window.sessionStorage.removeItem(SYNCED_STORAGE_KEY);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------------------
// Subscribe / unsubscribe
// ---------------------------------------------------------------------------------------

/** Converts a browser subscription into the JSON body the backend expects. */
export function toSubscriptionJSON(subscription: PushSubscription): WebPushSubscriptionJSON {
  const json = subscription.toJSON();
  const endpoint = json.endpoint ?? subscription.endpoint;
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    throw new PushError("subscribe_failed", "The browser returned an incomplete push subscription.");
  }
  return { endpoint, keys: { p256dh, auth } };
}

function roundCoordinate(value: number): number {
  const factor = 10 ** LOCATION_DECIMALS;
  return Math.round(value * factor) / factor;
}

function validLocation(lat: unknown, lon: unknown): { lat: number; lon: number } | null {
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return null;
  }
  return { lat: roundCoordinate(lat), lon: roundCoordinate(lon) };
}

function normaliseTopics(topics: readonly PushTopic[] | undefined): PushTopic[] {
  const unique = Array.from(new Set((topics ?? ALL_PUSH_TOPICS).filter(isTopic)));
  return unique.length ? unique : [...ALL_PUSH_TOPICS];
}

function clampRadius(radiusKm: number | undefined): number {
  if (typeof radiusKm !== "number" || !Number.isFinite(radiusKm)) return DEFAULT_PUSH_RADIUS_KM;
  return Math.min(500, Math.max(1, Math.round(radiusKm)));
}

function buildRequest(subscription: WebPushSubscriptionJSON, prefs: PushPreferences): PushSubscribeRequest {
  const body: PushSubscribeRequest = {
    subscription,
    radius_km: prefs.radiusKm,
    topics: prefs.topics,
  };
  if (prefs.lat !== undefined && prefs.lon !== undefined) {
    body.lat = prefs.lat;
    body.lon = prefs.lon;
  }
  return body;
}

export interface SubscribeOptions {
  /** Centre for nearby alerts. Without a location only red disaster alerts are delivered. */
  lat?: number | null;
  lon?: number | null;
  /**
   * Lazily resolves the location *after* notification permission was granted (overrides
   * `lat`/`lon`). Lets callers ask for geolocation without delaying the permission prompt,
   * which browsers only show while the click's user activation is still fresh.
   */
  locate?: () => Promise<{ lat: number; lon: number } | null>;
  /** Alert radius in km (1–500, default 50). */
  radiusKm?: number;
  /** Default: both "incidents" and "disasters". */
  topics?: readonly PushTopic[];
  /** VAPID public key when the caller already fetched it (skips one request). */
  vapidPublicKey?: string;
  /** Signed-in user id (`session.user.id`), or null/undefined when signed out. */
  identity?: string | null;
  request?: RequestOptions;
}

export interface SubscribeResult {
  subscription: PushSubscription;
  server: PushSubscribeResponse;
  prefs: PushPreferences;
}

/**
 * Subscribes this browser to push notifications and registers the subscription with the
 * backend (upsert by endpoint — calling it again updates radius/topics/location).
 *
 * Call it directly from a click handler and pass `vapidPublicKey` when you have it: the
 * permission prompt is then requested synchronously within the user gesture (Safari and
 * Firefox ignore permission requests made after unrelated awaits).
 *
 * @throws {PushError} for browser-side problems (see {@link PushErrorCode}).
 * @throws {ApiError} when the backend call fails (network, 503 `not_configured`, 422 ...).
 */
export async function subscribe(options: SubscribeOptions = {}): Promise<SubscribeResult> {
  assertSupported();

  let publicKey = options.vapidPublicKey ?? null;
  if (!publicKey) {
    const vapid = await getVapidPublicKey(options.request);
    if (!vapid.enabled || !vapid.public_key) throw new PushError("disabled");
    publicKey = vapid.public_key;
  }
  const applicationServerKey = decodeVapidPublicKey(publicKey);

  let permission: NotificationPermission;
  try {
    permission = await requestNotificationPermission();
  } catch (error) {
    if (isPushError(error)) throw error;
    throw new PushError("denied", undefined, { cause: error });
  }
  if (permission === "denied") throw new PushError("denied");
  if (permission !== "granted") throw new PushError("dismissed");

  const registration = await getServiceWorkerRegistration();

  let subscription: PushSubscription | null = null;
  try {
    subscription = await registration.pushManager.getSubscription();
  } catch {
    subscription = null;
  }
  // The server's VAPID key changed (key rotation): the old subscription can't receive our
  // messages any more, so replace it.
  if (subscription && !bytesEqual(subscription.options?.applicationServerKey, applicationServerKey)) {
    await subscription.unsubscribe().catch((error: unknown) => {
      console.warn("[push] failed to drop a subscription with an outdated key", error);
    });
    subscription = null;
  }

  let created = false;
  if (!subscription) {
    try {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
      created = true;
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "NotAllowedError") throw new PushError("denied", undefined, { cause: error });
      throw new PushError("subscribe_failed", undefined, { cause: error });
    }
  }

  let location = validLocation(options.lat, options.lon);
  if (options.locate) {
    try {
      const located = await options.locate();
      location = located ? validLocation(located.lat, located.lon) : null;
    } catch (error) {
      console.warn("[push] locating failed; subscribing without a location", error);
      location = null;
    }
  }
  const prefs: PushPreferences = {
    radiusKm: clampRadius(options.radiusKm),
    topics: normaliseTopics(options.topics),
    ...(location ?? {}),
  };

  let server: PushSubscribeResponse;
  try {
    server = await subscribePush(buildRequest(toSubscriptionJSON(subscription), prefs), options.request);
  } catch (error) {
    // Keep browser and server consistent: a subscription the server doesn't know about would
    // show "on" while nothing is ever delivered.
    if (created) {
      await subscription.unsubscribe().catch(() => undefined);
    }
    throw error;
  }

  savePushPreferences(prefs);
  markSynced(subscription.endpoint, options.identity);
  return { subscription, server, prefs };
}

/**
 * Turns push off for this browser: removes the browser subscription, then tells the backend
 * (best effort — the backend also drops endpoints that answer 404/410).
 *
 * @returns `true` if a subscription existed and was removed.
 * @throws {PushError} `unsubscribe_failed` when the browser refused to unsubscribe.
 */
export async function unsubscribe(options: { request?: RequestOptions } = {}): Promise<boolean> {
  const subscription = await getCurrentSubscription();
  if (!subscription) {
    clearPushPreferences();
    return false;
  }
  const { endpoint } = subscription;
  let removed: boolean;
  try {
    removed = await subscription.unsubscribe();
  } catch (error) {
    throw new PushError("unsubscribe_failed", undefined, { cause: error });
  }
  if (!removed) throw new PushError("unsubscribe_failed");

  try {
    await unsubscribePush(endpoint, options.request);
  } catch (error) {
    console.warn("[push] backend unsubscribe failed; the server will drop the endpoint on its next send", error);
  }
  clearPushPreferences();
  return true;
}

/**
 * Re-registers an existing browser subscription with the backend once per browser session
 * **and identity** (e.g. after the server database was reset, or after signing in — the
 * proxy then attaches the new user's JWT and the backend links the device to that account).
 * Silent: returns `false` on any problem.
 *
 * @param options.identity signed-in user id, or null/undefined when signed out.
 */
export async function resyncSubscription(
  options: { identity?: string | null; request?: RequestOptions } = {},
): Promise<boolean> {
  try {
    const subscription = await getCurrentSubscription();
    if (!subscription || isSynced(subscription.endpoint, options.identity)) return false;
    // Without remembered preferences we don't know what the user chose: never overwrite the
    // server's copy with guesses.
    const prefs = loadPushPreferences();
    if (!prefs) return false;
    await subscribePush(buildRequest(toSubscriptionJSON(subscription), prefs), options.request);
    markSynced(subscription.endpoint, options.identity);
    return true;
  } catch (error) {
    console.debug("[push] background re-sync skipped", error);
    return false;
  }
}

/**
 * Sign-out helper: detaches this device's push subscription from the account (it keeps
 * receiving location-based alerts anonymously) and forgets the re-sync marker. Best effort
 * and bounded in time — signing out must never hang on the network. Never throws.
 */
export async function unlinkCurrentSubscription(timeoutMs = 3_000): Promise<boolean> {
  clearPushSyncMarker();
  try {
    if (!getPushSupport().supported) return false;
    const subscription = await withTimeout(getCurrentSubscription(), timeoutMs, () => new Error("timeout"));
    if (!subscription) return false;
    await unlinkPush(subscription.endpoint, { timeoutMs });
    return true;
  } catch (error) {
    console.debug("[push] could not unlink the subscription on sign-out", error);
    return false;
  }
}
