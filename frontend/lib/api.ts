/**
 * Browser-side API client for the ResQ AI backend.
 *
 * The browser never talks to FastAPI directly: every call goes to the same-origin proxy
 * `/api/backend/<path>` (see `app/api/backend/[...path]/route.ts`), which attaches the user's
 * short-lived backend JWT server-side. This module:
 *
 * - wraps `fetch` with JSON encoding, query-string building and a timeout,
 * - normalises every failure into an {@link ApiError} (backend error envelope, FastAPI
 *   `{detail}` bodies, plain-text errors, network failures and timeouts),
 * - exposes one typed helper per backend endpoint plus SWR key helpers and a `fetcher`.
 */

import type {
  AdvisoriesResponse,
  ApiErrorBody,
  ChatRequest,
  ChatResponse,
  ChecklistRequest,
  ChecklistResponse,
  ClassifyResponse,
  DisasterEventsQuery,
  DisasterEventsResponse,
  HealthResponse,
  Incident,
  IncidentInput,
  IncidentStatus,
  IncidentsQuery,
  IncidentsResponse,
  LatLon,
  NewsQuery,
  NewsResponse,
  OkResponse,
  PlacesQuery,
  PlacesResponse,
  PushSubscribeRequest,
  PushSubscribeResponse,
  PushTestResponse,
  SOSHistoryResponse,
  SOSRequest,
  SOSResponse,
  TranslateRequest,
  TranslateResponse,
  VapidKeyResponse,
  WeatherResponse,
} from "@/lib/types";

/** Same-origin prefix of the backend proxy route. */
export const API_BASE = "/api/backend";

/** Default client-side timeout. The proxy itself gives up after 20 s. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Slow endpoints (LLM-backed chat/tools, SOS SMS fan-out). Timeouts are layered so the
 * innermost layer gives up first and the user sees its answer, not a generic timeout:
 * backend budget (chat ≤ 15 s, SOS ≈ one 6 s Twilio wave) < proxy upstream timeout (20 s,
 * `app/api/_lib/proxy.ts`) < this client timeout.
 */
export const SLOW_TIMEOUT_MS = 25_000;

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

type QueryPrimitive = string | number | boolean;
/** Query values: `undefined`/`null`/`""` are dropped, arrays are sent comma-separated. */
export type QueryValue = QueryPrimitive | null | undefined | readonly QueryPrimitive[];
export type QueryParams = Record<string, QueryValue>;

export interface ApiFetchOptions {
  method?: HttpMethod;
  /** Serialised as JSON. Omit for requests without a body. */
  body?: unknown;
  query?: QueryParams;
  /** Caller-controlled cancellation (e.g. component unmount). */
  signal?: AbortSignal;
  /** Abort the request after this many milliseconds (default 15 s). */
  timeoutMs?: number;
  headers?: Record<string, string>;
}

/** Well-known client-side error codes (backend codes are passed through unchanged). */
export const CLIENT_ERROR_CODES = {
  network: "network_error",
  timeout: "timeout",
  aborted: "aborted",
  invalidResponse: "invalid_response",
} as const;

/**
 * Error thrown by {@link apiFetch} for any non-2xx response or transport failure.
 *
 * `status` is the HTTP status, or `0` when no response was received (network failure,
 * timeout, or caller abort). `code` is the backend's machine-readable error code (e.g.
 * `"validation_error"`, `"rate_limited"`) or one of {@link CLIENT_ERROR_CODES}.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  /** Seconds to wait before retrying, from the `Retry-After` header (429/503). */
  readonly retryAfter: number | null;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { requestId?: string | null; retryAfter?: number | null; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = options.requestId ?? null;
    this.retryAfter = options.retryAfter ?? null;
  }

  /** True for transport-level failures where no HTTP response arrived. */
  get isNetworkError(): boolean {
    return this.status === 0;
  }

  /** True for 4xx responses (retrying will not help). */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

/** Type guard usable in `catch` blocks and SWR `error` values. */
export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** Human-friendly message for any error thrown by this module (or anything else). */
export function getErrorMessage(error: unknown, fallback = "Something went wrong."): string {
  if (isApiError(error)) {
    switch (error.code) {
      case CLIENT_ERROR_CODES.network:
      case "backend_unreachable":
        return "Can't reach ResQ AI right now. Check your connection and try again.";
      case CLIENT_ERROR_CODES.timeout:
      case "backend_timeout":
        return "The request took too long. Please try again.";
      case "rate_limited":
        return error.retryAfter
          ? `Too many requests. Please wait ${error.retryAfter}s and try again.`
          : "Too many requests. Please wait a moment and try again.";
      default:
        return error.message || fallback;
    }
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

// ---------------------------------------------------------------------------------------
// URL building
// ---------------------------------------------------------------------------------------

/** Builds a query string (with leading `?`, or `""` when nothing remains). */
export function buildQuery(query?: QueryParams): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      params.append(key, value.map(String).join(","));
      continue;
    }
    const str = String(value);
    if (str === "") continue;
    params.append(key, str);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/**
 * Resolves a backend path (e.g. `"weather"`, `"/incidents/abc/upvote"`) to the proxy URL.
 * Leading slashes and an accidental `api/` or `api/backend/` prefix are tolerated.
 */
export function apiUrl(path: string, query?: QueryParams): string {
  let clean = path.trim().replace(/^\/+/, "");
  if (clean.startsWith("api/backend/")) clean = clean.slice("api/backend/".length);
  else if (clean.startsWith("api/")) clean = clean.slice("api/".length);
  return `${API_BASE}/${clean}${buildQuery(query)}`;
}

/** Encodes a single path segment (ids coming from user input or URLs). */
function seg(value: string): string {
  return encodeURIComponent(value);
}

// ---------------------------------------------------------------------------------------
// Error parsing
// ---------------------------------------------------------------------------------------

function isEnvelope(value: unknown): value is ApiErrorBody {
  if (!value || typeof value !== "object") return false;
  const err = (value as { error?: unknown }).error;
  return (
    !!err &&
    typeof err === "object" &&
    typeof (err as { message?: unknown }).message === "string"
  );
}

/** FastAPI's default validation body: `{"detail": [{"loc": [...], "msg": "..."}]}`. */
function formatDetail(detail: unknown): string | null {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const parts = detail
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const { msg, loc } = item as { msg?: unknown; loc?: unknown };
        if (typeof msg !== "string") return null;
        const field = Array.isArray(loc)
          ? loc.filter((p) => p !== "body" && p !== "query").join(".")
          : "";
        return field ? `${field}: ${msg}` : msg;
      })
      .filter((part): part is string => !!part);
    return parts.length ? parts.join("; ") : null;
  }
  return null;
}

function defaultCodeForStatus(status: number): string {
  switch (status) {
    case 400:
      return "bad_request";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 413:
      return "payload_too_large";
    case 422:
      return "validation_error";
    case 429:
      return "rate_limited";
    case 502:
      return "upstream_error";
    case 503:
      return "service_unavailable";
    case 504:
      return "backend_timeout";
    default:
      return status >= 500 ? "internal_error" : "http_error";
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

/** Converts a non-2xx `Response` into an {@link ApiError}. Never throws itself. */
export async function errorFromResponse(response: Response): Promise<ApiError> {
  const headerRequestId = response.headers.get("x-request-id");
  const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
  const fallbackMessage = response.statusText || `Request failed with status ${response.status}`;

  let text = "";
  try {
    text = await response.text();
  } catch {
    // Body unreadable (connection dropped mid-body): fall back to the status line.
  }

  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }

  if (isEnvelope(parsed)) {
    const { code, message, request_id: requestId } = parsed.error;
    return new ApiError(
      response.status,
      typeof code === "string" && code ? code : defaultCodeForStatus(response.status),
      message || fallbackMessage,
      { requestId: requestId || headerRequestId, retryAfter },
    );
  }

  if (parsed && typeof parsed === "object" && "detail" in parsed) {
    const message = formatDetail((parsed as { detail: unknown }).detail) ?? fallbackMessage;
    return new ApiError(response.status, defaultCodeForStatus(response.status), message, {
      requestId: headerRequestId,
      retryAfter,
    });
  }

  // Plain text (or HTML error page): keep it short and never surface markup.
  const plain = text && !/^\s*</.test(text) ? text.trim().slice(0, 300) : "";
  return new ApiError(response.status, defaultCodeForStatus(response.status), plain || fallbackMessage, {
    requestId: headerRequestId,
    retryAfter,
  });
}

// ---------------------------------------------------------------------------------------
// Response metadata (saved copies served by the service worker)
// ---------------------------------------------------------------------------------------

/**
 * Where a response body came from. `public/sw.js` answers GET weather/alerts/incidents/places
 * from its cache when the network fails or takes longer than 6 s, and marks that copy with
 * `X-ResQ-Offline: 1` and `X-ResQ-Cached-At: <iso>`. Emergency data must never look live
 * when it is not, so `apiFetch` keeps that information on the parsed body (see
 * {@link getResponseMeta}) and widgets show an {@link OfflineDataNotice}.
 */
export interface ResponseMeta {
  /** `true` when the body is a saved copy (offline, very slow network or server trouble). */
  offline: boolean;
  /** When the saved copy was originally fetched (ISO 8601), if known. */
  cachedAt: string | null;
  /**
   * Set when the copy was saved for another location (the service worker's nearest-location
   * fallback): distance in metres between that location and the one asked for.
   */
  distanceM?: number;
  /** `"server-error"` when the network worked but the server answered 5xx. */
  reason?: "server-error";
}

const RESPONSE_META = Symbol.for("resq.responseMeta");

/** Metadata attached by {@link apiFetch}, or `null` for live data / non-object values. */
export function getResponseMeta(data: unknown): ResponseMeta | null {
  if (!data || typeof data !== "object") return null;
  const meta = (data as Record<symbol, unknown>)[RESPONSE_META];
  return meta && typeof meta === "object" ? (meta as ResponseMeta) : null;
}

/** `true` when `data` is a saved copy served while offline (see {@link ResponseMeta}). */
export function isSavedCopy(data: unknown): boolean {
  return getResponseMeta(data)?.offline === true;
}

/** Reads the service worker's markers; `null` for a live response. */
export function responseMetaFromHeaders(headers: Headers): ResponseMeta | null {
  if (headers.get("x-resq-offline") !== "1") return null;
  const cachedAt = headers.get("x-resq-cached-at");
  const meta: ResponseMeta = {
    offline: true,
    cachedAt: cachedAt && !Number.isNaN(Date.parse(cachedAt)) ? cachedAt : null,
  };
  const rawDistance = headers.get("x-resq-cached-distance-m");
  const distance = rawDistance === null || rawDistance.trim() === "" ? Number.NaN : Number(rawDistance);
  if (Number.isFinite(distance) && distance >= 0) meta.distanceM = Math.round(distance);
  if (headers.get("x-resq-offline-reason") === "server-error") meta.reason = "server-error";
  return meta;
}

function attachResponseMeta<T>(value: T, meta: ResponseMeta | null): T {
  if (!meta || !value || typeof value !== "object") return value;
  // Non-enumerable: invisible to JSON.stringify, spreads and deep-equality in tests.
  Object.defineProperty(value, RESPONSE_META, { value: meta, enumerable: false, configurable: true });
  return value;
}

/**
 * SWR `compare`: like the default deep comparison, but a saved (offline) copy and live data
 * with identical content are *different* — otherwise SWR would keep the saved copy (and its
 * "offline" label) after the connection comes back.
 */
export function compareApiData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isSavedCopy(a) !== isSavedCopy(b)) return false;
  if (getResponseMeta(a)?.cachedAt !== getResponseMeta(b)?.cachedAt) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------
// Core fetch
// ---------------------------------------------------------------------------------------

/**
 * Calls the backend through the same-origin proxy and returns the parsed JSON body. When the
 * service worker answered with a saved copy, the body carries {@link ResponseMeta} (read it
 * with {@link getResponseMeta}).
 *
 * @throws {ApiError} on any non-2xx status, invalid JSON, network failure (`status 0`,
 *   code `"network_error"`), timeout (`status 0`, code `"timeout"`) or when the caller's
 *   `signal` aborts (`status 0`, code `"aborted"`).
 */
export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { method = "GET", body, query, signal, timeoutMs = DEFAULT_TIMEOUT_MS, headers } = options;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onCallerAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onCallerAbort, { once: true });
  }

  const requestHeaders: Record<string, string> = { Accept: "application/json", ...headers };
  const hasBody = body !== undefined;
  if (hasBody) requestHeaders["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(apiUrl(path, query), {
      method,
      headers: requestHeaders,
      body: hasBody ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch (error) {
    if (timedOut) {
      throw new ApiError(0, CLIENT_ERROR_CODES.timeout, `Request timed out after ${timeoutMs} ms`, {
        cause: error,
      });
    }
    if (signal?.aborted) {
      throw new ApiError(0, CLIENT_ERROR_CODES.aborted, "Request was cancelled", { cause: error });
    }
    throw new ApiError(0, CLIENT_ERROR_CODES.network, "Network error: could not reach the server", {
      cause: error,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCallerAbort);
  }

  if (!response.ok) {
    throw await errorFromResponse(response);
  }

  if (response.status === 204 || response.status === 205) {
    return undefined as T;
  }

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw new ApiError(0, CLIENT_ERROR_CODES.network, "Connection lost while reading the response", {
      cause: error,
      requestId: response.headers.get("x-request-id"),
    });
  }
  if (!text) return undefined as T;

  try {
    return attachResponseMeta(JSON.parse(text) as T, responseMetaFromHeaders(response.headers));
  } catch (error) {
    throw new ApiError(
      response.status,
      CLIENT_ERROR_CODES.invalidResponse,
      "The server returned an invalid response",
      { cause: error, requestId: response.headers.get("x-request-id") },
    );
  }
}

/** Per-call options accepted by the typed helpers. */
export type RequestOptions = Pick<ApiFetchOptions, "signal" | "timeoutMs">;

// ---------------------------------------------------------------------------------------
// Typed endpoint helpers
// ---------------------------------------------------------------------------------------

export function getHealth(opts?: RequestOptions): Promise<HealthResponse> {
  return apiFetch<HealthResponse>("health", opts);
}

export function getWeather(coords: LatLon, opts?: RequestOptions) {
  return apiFetch<WeatherResponse>("weather", {
    ...opts,
    query: { lat: coords.lat, lon: coords.lon },
  });
}

export function getDisasterEvents(query: DisasterEventsQuery = {}, opts?: RequestOptions) {
  return apiFetch<DisasterEventsResponse>("alerts/disasters", { ...opts, query: { ...query } });
}

export function getNews(query: NewsQuery = {}, opts?: RequestOptions) {
  return apiFetch<NewsResponse>("alerts/news", { ...opts, query: { ...query } });
}

export function getPlaces(query: PlacesQuery, opts?: RequestOptions) {
  return apiFetch<PlacesResponse>("places", { ...opts, query: { ...query } });
}

export function listIncidents(query: IncidentsQuery = {}, opts?: RequestOptions) {
  return apiFetch<IncidentsResponse>("incidents", { ...opts, query: { ...query } });
}

export function getIncident(id: string, opts?: RequestOptions) {
  return apiFetch<Incident>(`incidents/${seg(id)}`, opts);
}

export function createIncident(input: IncidentInput, opts?: RequestOptions) {
  return apiFetch<Incident>("incidents", { ...opts, method: "POST", body: input });
}

export function upvoteIncident(id: string, opts?: RequestOptions) {
  return apiFetch<Incident>(`incidents/${seg(id)}/upvote`, { ...opts, method: "POST" });
}

export function updateIncidentStatus(id: string, status: IncidentStatus, opts?: RequestOptions) {
  return apiFetch<Incident>(`incidents/${seg(id)}`, {
    ...opts,
    method: "PATCH",
    body: { status },
  });
}

export function sendSOS(request: SOSRequest, opts?: RequestOptions) {
  return apiFetch<SOSResponse>("sos", {
    // Longer than the proxy's 20 s: a client-side abort must never be the reason an SOS
    // that the backend is still sending looks failed (and gets sent twice on retry).
    timeoutMs: SLOW_TIMEOUT_MS,
    ...opts,
    method: "POST",
    body: request,
  });
}

export function getSOSHistory(opts?: RequestOptions) {
  return apiFetch<SOSHistoryResponse>("sos/history", opts);
}

export function chat(request: ChatRequest, opts?: RequestOptions) {
  return apiFetch<ChatResponse>("chat", {
    timeoutMs: SLOW_TIMEOUT_MS,
    ...opts,
    method: "POST",
    body: request,
  });
}

export function classify(message: string, opts?: RequestOptions) {
  return apiFetch<ClassifyResponse>("classify", {
    timeoutMs: SLOW_TIMEOUT_MS,
    ...opts,
    method: "POST",
    body: { message },
  });
}

export function getChecklist(request: ChecklistRequest, opts?: RequestOptions) {
  return apiFetch<ChecklistResponse>("checklist", {
    timeoutMs: SLOW_TIMEOUT_MS,
    ...opts,
    method: "POST",
    body: request,
  });
}

export function translate(request: TranslateRequest, opts?: RequestOptions) {
  return apiFetch<TranslateResponse>("translate", {
    timeoutMs: SLOW_TIMEOUT_MS,
    ...opts,
    method: "POST",
    body: request,
  });
}

export function getAdvisories(coords: LatLon, opts?: RequestOptions) {
  return apiFetch<AdvisoriesResponse>("advisories", {
    timeoutMs: SLOW_TIMEOUT_MS,
    ...opts,
    query: { lat: coords.lat, lon: coords.lon },
  });
}

export function getVapidPublicKey(opts?: RequestOptions) {
  return apiFetch<VapidKeyResponse>("push/vapid-public-key", opts);
}

export function subscribePush(request: PushSubscribeRequest, opts?: RequestOptions) {
  return apiFetch<PushSubscribeResponse>("push/subscribe", {
    ...opts,
    method: "POST",
    body: request,
  });
}

export function unsubscribePush(endpoint: string, opts?: RequestOptions) {
  return apiFetch<OkResponse>("push/unsubscribe", {
    ...opts,
    method: "POST",
    body: { endpoint },
  });
}

/** Detaches this device's subscription from its account (sign-out); idempotent. */
export function unlinkPush(endpoint: string, opts?: RequestOptions) {
  return apiFetch<OkResponse>("push/unlink", {
    ...opts,
    method: "POST",
    body: { endpoint },
  });
}

export function sendTestPush(opts?: RequestOptions) {
  return apiFetch<PushTestResponse>("push/test", { ...opts, method: "POST" });
}

// ---------------------------------------------------------------------------------------
// SWR integration
// ---------------------------------------------------------------------------------------

/**
 * SWR keys are `[path, query?]` tuples; SWR hashes them structurally, so two components
 * asking for the same data share one request and one cache entry.
 */
export type SWRKey = readonly [path: string, query?: QueryParams];

/**
 * Rounds coordinates for cache keys (4 decimals ≈ 11 m) so GPS jitter does not cause a
 * refetch storm while still being far more precise than any backend query needs.
 */
export function roundCoord(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export const swrKeys = {
  health: (): SWRKey => ["health"],
  weather: (coords: LatLon): SWRKey => [
    "weather",
    { lat: roundCoord(coords.lat), lon: roundCoord(coords.lon) },
  ],
  disasters: (query: DisasterEventsQuery = {}): SWRKey => [
    "alerts/disasters",
    {
      ...query,
      lat: query.lat === undefined ? undefined : roundCoord(query.lat),
      lon: query.lon === undefined ? undefined : roundCoord(query.lon),
    },
  ],
  news: (query: NewsQuery = {}): SWRKey => ["alerts/news", { ...query }],
  places: (query: PlacesQuery): SWRKey => [
    "places",
    { ...query, lat: roundCoord(query.lat), lon: roundCoord(query.lon) },
  ],
  incidents: (query: IncidentsQuery = {}): SWRKey => [
    "incidents",
    {
      ...query,
      lat: query.lat === undefined ? undefined : roundCoord(query.lat),
      lon: query.lon === undefined ? undefined : roundCoord(query.lon),
    },
  ],
  incident: (id: string): SWRKey => [`incidents/${seg(id)}`],
  sosHistory: (): SWRKey => ["sos/history"],
  vapidPublicKey: (): SWRKey => ["push/vapid-public-key"],
} as const;

/**
 * Default SWR fetcher (registered globally in `components/Providers.tsx`).
 * Accepts either an {@link SWRKey} tuple or a plain path string.
 */
export function fetcher<T = unknown>(key: SWRKey | string): Promise<T> {
  if (typeof key === "string") return apiFetch<T>(key);
  const [path, query] = key;
  return apiFetch<T>(path, { query });
}
