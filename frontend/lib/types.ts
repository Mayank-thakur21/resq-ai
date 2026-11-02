/**
 * TypeScript mirrors of the FastAPI backend schemas (see the API contract in the spec).
 *
 * Conventions:
 * - Field names are kept in the backend's snake_case so payloads need no mapping.
 * - Timestamps are ISO-8601 strings (`IsoDateString`); parse them at the edge of the UI.
 * - `| null` means the backend always sends the key but it may be null; `?` means the key
 *   is optional in requests.
 */

/** ISO-8601 timestamp string, e.g. "2026-11-02T16:40:00Z". */
export type IsoDateString = string;

export interface LatLon {
  lat: number;
  lon: number;
}

export type RiskLevel = "low" | "medium" | "high";

// ---------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------

/** Error envelope returned by the backend (and by the Next.js proxy) for every failure. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    request_id: string;
  };
}

// ---------------------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------------------

export interface HealthResponse {
  /** "degraded" (with HTTP 503) when the database is unreachable. */
  status: "ok" | "degraded";
  version: string;
  services: {
    database: "ok" | "error";
    gemini: boolean;
    openweathermap: boolean;
    reliefweb: boolean;
    twilio: boolean;
    push: boolean;
    auth: boolean;
  };
}

// ---------------------------------------------------------------------------------------
// Weather  (GET /api/weather?lat&lon)
// ---------------------------------------------------------------------------------------

export type WeatherSource = "openweathermap" | "open-meteo";

export interface Weather {
  temperature: number;
  feels_like: number;
  humidity: number;
  wind_speed_kmh: number;
  description: string;
  /** OpenWeatherMap-style icon code, e.g. "10d". */
  icon: string;
  weather_code: number | null;
  city: string | null;
  country: string | null;
  is_day: boolean | null;
  observed_at: IsoDateString;
  source: WeatherSource;
}

export interface ForecastItem {
  time: IsoDateString;
  temperature: number;
  description: string;
  icon: string;
  precipitation_probability: number | null;
}

export interface WeatherAlert {
  event: string;
  description: string;
  sender: string;
  start: IsoDateString | null;
  end: IsoDateString | null;
  severity: RiskLevel;
}

export interface Hazard {
  type: string;
  severity: RiskLevel;
  message: string;
}

export interface WeatherResponse {
  weather: Weather;
  forecast: ForecastItem[];
  alerts: WeatherAlert[];
  hazards: Hazard[];
}

// ---------------------------------------------------------------------------------------
// Disaster alerts & news  (GET /api/alerts/disasters, GET /api/alerts/news)
// ---------------------------------------------------------------------------------------

/** GDACS event type codes. */
export type DisasterEventType = "EQ" | "TC" | "FL" | "VO" | "DR" | "WF";

export const DISASTER_EVENT_TYPE_LABELS: Record<DisasterEventType, string> = {
  EQ: "Earthquake",
  TC: "Tropical Cyclone",
  FL: "Flood",
  VO: "Volcano",
  DR: "Drought",
  WF: "Wildfire",
};

export type AlertLevel = "green" | "orange" | "red";

export interface DisasterEvent {
  id: string;
  source: "gdacs";
  /** Usually a `DisasterEventType`; kept as string to tolerate new GDACS codes. */
  event_type: DisasterEventType | (string & {});
  event_type_label: string;
  title: string;
  description: string;
  alert_level: AlertLevel;
  severity_text: string | null;
  country: string | null;
  lat: number;
  lon: number;
  from_date: IsoDateString | null;
  to_date: IsoDateString | null;
  is_current: boolean;
  url: string;
  /** Present when the request included lat/lon. */
  distance_km: number | null;
}

export interface DisasterEventsQuery {
  lat?: number;
  lon?: number;
  radius_km?: number;
  /** GDACS codes, sent comma-separated (e.g. "EQ,TC"). */
  types?: DisasterEventType[];
  min_level?: AlertLevel;
  limit?: number;
}

export interface DisasterEventsResponse {
  events: DisasterEvent[];
  updated_at: IsoDateString;
}

export type NewsSource = "reliefweb" | "gdacs";

export interface NewsItem {
  id: string;
  source: NewsSource;
  title: string;
  url: string;
  published_at: IsoDateString | null;
  summary: string | null;
  countries: string[];
  disaster_types: string[];
  source_name: string | null;
}

export interface NewsQuery {
  limit?: number;
  query?: string;
  /** ISO 3166-1 alpha-3 country code, e.g. "IND". */
  country?: string;
}

export interface NewsResponse {
  items: NewsItem[];
  sources: NewsSource[];
  updated_at: IsoDateString;
}

// ---------------------------------------------------------------------------------------
// Places  (GET /api/places)
// ---------------------------------------------------------------------------------------

export type PlaceType = "hospital" | "shelter" | "police" | "fire_station" | "pharmacy";

export const PLACE_TYPES: readonly PlaceType[] = [
  "hospital",
  "shelter",
  "police",
  "fire_station",
  "pharmacy",
] as const;

export interface Place {
  id: string;
  name: string;
  type: PlaceType;
  lat: number;
  lon: number;
  distance_km: number;
  address: string | null;
  phone: string | null;
}

export interface PlacesQuery extends LatLon {
  type: PlaceType;
  /** Search radius in metres (backend clamps to 500–20000). */
  radius?: number;
}

export interface PlacesResponse {
  places: Place[];
}

// ---------------------------------------------------------------------------------------
// Incidents  (/api/incidents)
// ---------------------------------------------------------------------------------------

export type DisasterType =
  | "flood"
  | "earthquake"
  | "fire"
  | "cyclone"
  | "landslide"
  | "drought"
  | "heatwave"
  | "tsunami"
  | "storm"
  | "accident"
  | "medical"
  | "other";

export const DISASTER_TYPES: readonly DisasterType[] = [
  "flood",
  "earthquake",
  "fire",
  "cyclone",
  "landslide",
  "drought",
  "heatwave",
  "tsunami",
  "storm",
  "accident",
  "medical",
  "other",
] as const;

export type Severity = "low" | "medium" | "high" | "critical";

export const SEVERITIES: readonly Severity[] = ["low", "medium", "high", "critical"] as const;

export type IncidentStatus = "open" | "resolved";

export interface IncidentReporter {
  id: string;
  name: string;
}

export interface Incident {
  id: string;
  created_at: IsoDateString;
  updated_at: IsoDateString;
  lat: number;
  lon: number;
  disaster_type: DisasterType;
  severity: Severity;
  description: string;
  image_url: string | null;
  status: IncidentStatus;
  reporter: IncidentReporter;
  upvotes: number;
  verified: boolean;
  upvoted_by_me: boolean;
  distance_km: number | null;
}

/** Body of `POST /api/incidents`. */
export interface IncidentInput extends LatLon {
  disaster_type: DisasterType;
  severity: Severity;
  /** 10–1000 characters. */
  description: string;
  /** Optional http(s) URL, at most 500 characters. */
  image_url?: string;
}

export interface IncidentsQuery {
  lat?: number;
  lon?: number;
  radius_km?: number;
  /** Defaults to "open" on the backend. */
  status?: IncidentStatus | "all";
  type?: DisasterType;
  limit?: number;
}

export interface IncidentsResponse {
  incidents: Incident[];
}

export interface IncidentStatusUpdate {
  status: IncidentStatus;
}

// ---------------------------------------------------------------------------------------
// SOS  (POST /api/sos, GET /api/sos/history)
// ---------------------------------------------------------------------------------------

export interface SOSRequest extends LatLon {
  accuracy_m?: number;
  /** 1–300 characters; backend default "SOS! I need help!". */
  message?: string;
  /** 0–10 E.164 numbers (e.g. "+919876543210"). */
  contact_numbers: string[];
  /** At most 80 characters. */
  user_name?: string;
}

export interface SMSSent {
  /** Masked number, e.g. "+91******3210". */
  to: string;
  sid: string;
  status: string;
}

export interface SMSFailed {
  /** Masked number. */
  to: string;
  error: string;
}

export interface SMSResult {
  configured: boolean;
  sent: SMSSent[];
  failed: SMSFailed[];
}

export interface SOSResponse {
  id: string;
  timestamp: IsoDateString;
  maps_link: string;
  message: string;
  sms: SMSResult;
  /** `sms:` URI that opens the native SMS app with the message pre-filled. */
  fallback_sms_uri: string;
}

export interface SOSHistoryEvent extends LatLon {
  id: string;
  timestamp: IsoDateString;
  message: string;
  contacts_count: number;
  sms_sent: number;
  sms_failed: number;
}

export interface SOSHistoryResponse {
  events: SOSHistoryEvent[];
}

// ---------------------------------------------------------------------------------------
// Chat & AI tools  (/api/chat, /api/classify, /api/checklist, /api/translate, /api/advisories)
// ---------------------------------------------------------------------------------------

export interface ChatRequest {
  /** 1–2000 characters. */
  message: string;
  language?: string;
  location?: LatLon;
}

export interface ChatResponse {
  response: string;
  agent_used: string;
  urgency_level: RiskLevel;
  /**
   * snake_case disaster type ("flood", "earthquake" ...); "unknown" when nothing was detected.
   * The schema allows null, so treat both null and "unknown" as "not detected".
   */
  detected_disaster: string | null;
  advisory: string | null;
  recommended_actions: string[];
  emergency_numbers: string[];
  steps_taken: string[];
  /**
   * Extra structured data from the agents; always an object (`{}` when no agent produced data).
   * Known keys are typed below; anything else must be treated as unknown.
   */
  data: ChatResponseData;
}

export interface ChatResponseData {
  /** At most 10 nearest; the key is absent when its OpenStreetMap lookup failed. */
  hospitals?: Place[];
  /** At most 10 nearest; the key is absent when its OpenStreetMap lookup failed. */
  shelters?: Place[];
  /** Preparedness checklist from the checklist agent. */
  checklist?: string[];
  /** Full weather snapshot used for the advisory. */
  weather?: WeatherResponse;
  [key: string]: unknown;
}

export interface ClassifyRequest {
  message: string;
}

export interface ClassifyResponse {
  disaster_type: string;
  urgency: RiskLevel;
  /** One of "seeking_help", "asking_info", "reporting", "other". */
  intent: string;
}

export interface ChecklistRequest {
  disaster_type: string;
  language?: string;
}

export interface ChecklistResponse {
  checklist: string[];
}

export interface TranslateRequest {
  text: string;
  target_language: string;
}

export interface TranslateResponse {
  translated_text: string;
}

export interface AdvisoriesResponse {
  advisories: string;
}

// ---------------------------------------------------------------------------------------
// Push notifications  (/api/push/*)
// ---------------------------------------------------------------------------------------

export type PushTopic = "incidents" | "disasters";

export interface VapidKeyResponse {
  enabled: boolean;
  public_key: string | null;
  /**
   * GDACS disaster alerts are actually pushed (the backend's alert poller runs). When
   * `false` the UI does not offer the "disasters" topic. Missing on older backends.
   */
  disaster_alerts?: boolean;
}

/** Shape of `PushSubscription.toJSON()` that the backend stores. */
export interface WebPushSubscriptionJSON {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface PushSubscribeRequest {
  subscription: WebPushSubscriptionJSON;
  lat?: number;
  lon?: number;
  /** 1–500 km, default 50. */
  radius_km?: number;
  topics?: PushTopic[];
}

export interface PushSubscribeResponse {
  id: string;
  radius_km: number;
  topics: PushTopic[];
}

export interface PushUnsubscribeRequest {
  endpoint: string;
}

export interface OkResponse {
  ok: true;
}

export interface PushTestResponse {
  sent: number;
}

/** Payload the service worker receives in a `push` event. */
export interface PushNotificationPayload {
  title: string;
  body: string;
  /** Same-origin path opened on click, e.g. "/incidents?focus=<id>" or "/alerts?event=<id>". */
  url: string;
  tag: string;
  severity: RiskLevel;
}

// ---------------------------------------------------------------------------------------
// Users (Next.js server only: registration + credential verification)
// ---------------------------------------------------------------------------------------

export interface RegisterRequest {
  name: string;
  email: string;
  password: string;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
}
