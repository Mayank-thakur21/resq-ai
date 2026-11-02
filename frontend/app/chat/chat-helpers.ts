/**
 * Pure helpers for the emergency chat (`/chat`): message model, response normalisation,
 * defensive parsing of agent data (`data.hospitals` / `data.shelters`), session history and
 * speech helpers. No React — unit tested in `chat-helpers.test.ts`.
 */

import type { ChatRequest, ChatResponse, LatLon, Place, PlaceType } from "@/lib/types";

export type Urgency = "low" | "medium" | "high";

export interface AssistantMeta {
  agentUsed: string;
  urgency: Urgency;
  /** Detected disaster type, `null` when unknown. */
  disaster: string | null;
  advisory: string | null;
  actions: string[];
  emergencyNumbers: string[];
  steps: string[];
  hospitals: Place[];
  shelters: Place[];
}

export interface UserMessage {
  id: string;
  role: "user";
  content: string;
  createdAt: number;
}

export interface AssistantMessage {
  id: string;
  role: "assistant";
  content: string;
  createdAt: number;
  meta?: AssistantMeta;
}

export interface ErrorMessage {
  id: string;
  role: "error";
  content: string;
  createdAt: number;
  /** Id of the user message to resend on "Retry". */
  retryOf: string;
  /** True for connectivity problems (offline / server unreachable). */
  network: boolean;
}

export type ChatMessage = UserMessage | AssistantMessage | ErrorMessage;

export const MAX_CHAT_MESSAGE_LENGTH = 2000;
export const CHAT_HISTORY_STORAGE_KEY = "resq_chat_history";
export const CHAT_TTS_STORAGE_KEY = "resq_chat_tts";
export const CHAT_LANGUAGE_STORAGE_KEY = "resq_chat_language";
/** Messages kept in sessionStorage (oldest dropped first). */
export const MAX_STORED_MESSAGES = 60;
/** Places shown per list in a chat answer. */
export const MAX_PLACES_PER_LIST = 5;

export const WELCOME_MESSAGE =
  "Hello! I am ResQ AI, your multi-agent emergency assistant. Describe what's happening — I can give safety steps, check the weather and find hospitals or shelters near you.";

export interface ChatLanguage {
  code: string;
  label: string;
  /** BCP 47 tag for speech recognition / synthesis. */
  speech: string;
}

export const CHAT_LANGUAGES: readonly ChatLanguage[] = [
  { code: "en", label: "English", speech: "en-US" },
  { code: "hi", label: "हिन्दी (Hindi)", speech: "hi-IN" },
  { code: "bn", label: "বাংলা (Bengali)", speech: "bn-IN" },
  { code: "ta", label: "தமிழ் (Tamil)", speech: "ta-IN" },
  { code: "te", label: "తెలుగు (Telugu)", speech: "te-IN" },
  { code: "mr", label: "मराठी (Marathi)", speech: "mr-IN" },
  { code: "es", label: "Español", speech: "es-ES" },
  { code: "fr", label: "Français", speech: "fr-FR" },
];

export function findLanguage(code: string | null | undefined): ChatLanguage {
  return CHAT_LANGUAGES.find((language) => language.code === code) ?? CHAT_LANGUAGES[0];
}

export const CHAT_SUGGESTIONS: readonly string[] = [
  "Water is rising around my house — what should I do?",
  "What do I do during an earthquake?",
  "Find the nearest hospital",
  "Where is the closest shelter?",
  "I smell gas in my building",
  "How do I prepare for a cyclone?",
];

// ---------------------------------------------------------------------------------------
// Requests & responses
// ---------------------------------------------------------------------------------------

/** Builds the `POST /chat` body (trimmed text, location only when shared). */
export function buildChatRequest(text: string, language: string, location: LatLon | null): ChatRequest {
  const request: ChatRequest = {
    message: text.trim().slice(0, MAX_CHAT_MESSAGE_LENGTH),
    language: language || "en",
  };
  if (location && Number.isFinite(location.lat) && Number.isFinite(location.lon)) {
    request.location = { lat: location.lat, lon: location.lon };
  }
  return request;
}

/** Maps any urgency string to the three levels the UI knows ("critical" → "high"). */
export function normalizeUrgency(value: unknown): Urgency {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (text === "high" || text === "critical" || text === "severe") return "high";
  if (text === "medium" || text === "moderate") return "medium";
  return "low";
}

function stringList(value: unknown, max = 20): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim())
    .slice(0, max);
}

const PLACE_TYPES: readonly PlaceType[] = ["hospital", "shelter", "police", "fire_station", "pharmacy"];

/** Validates `data.hospitals` / `data.shelters` items; malformed entries are dropped. */
export function extractPlaces(value: unknown, fallbackType: PlaceType, max = MAX_PLACES_PER_LIST): Place[] {
  if (!Array.isArray(value)) return [];
  const places: Place[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const lat = Number(raw.lat);
    const lon = Number(raw.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "Unnamed place";
    const distance = Number(raw.distance_km);
    places.push({
      id: typeof raw.id === "string" && raw.id ? raw.id : `${fallbackType}-${lat},${lon}`,
      name,
      type: PLACE_TYPES.includes(raw.type as PlaceType) ? (raw.type as PlaceType) : fallbackType,
      lat,
      lon,
      distance_km: Number.isFinite(distance) && distance >= 0 ? distance : Number.NaN,
      address: typeof raw.address === "string" && raw.address.trim() ? raw.address.trim() : null,
      phone: typeof raw.phone === "string" && raw.phone.trim() ? raw.phone.trim() : null,
    });
    if (places.length >= max) break;
  }
  return places;
}

function cleanDisaster(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && !["unknown", "none", "general", "other", "n/a"].includes(text.toLowerCase()) ? text : null;
}

/** Converts the backend `ChatResponse` into the UI's message metadata. Never throws. */
export function toAssistantMeta(response: ChatResponse): AssistantMeta {
  const data = response.data && typeof response.data === "object" ? response.data : {};
  return {
    agentUsed: typeof response.agent_used === "string" ? response.agent_used : "",
    urgency: normalizeUrgency(response.urgency_level),
    disaster: cleanDisaster(response.detected_disaster),
    advisory: typeof response.advisory === "string" && response.advisory.trim() ? response.advisory.trim() : null,
    actions: stringList(response.recommended_actions),
    emergencyNumbers: stringList(response.emergency_numbers, 8),
    steps: stringList(response.steps_taken, 12),
    hospitals: extractPlaces((data as Record<string, unknown>).hospitals, "hospital"),
    shelters: extractPlaces((data as Record<string, unknown>).shelters, "shelter"),
  };
}

/** Splits "112 (International Emergency)" into a dialable number and a label. */
export function parseEmergencyNumber(entry: string): { number: string; label: string } {
  const match = entry.trim().match(/^([+\d][\d\s-]*\d|\d)\s*(?:\((.*)\)|[-–:]\s*(.*))?$/);
  if (!match) return { number: "", label: entry.trim() };
  return { number: match[1].replace(/[\s-]/g, ""), label: (match[2] ?? match[3] ?? "").trim() };
}

// ---------------------------------------------------------------------------------------
// Session history (sessionStorage — survives navigation, cleared when the tab closes)
// ---------------------------------------------------------------------------------------

function isMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<ChatMessage>;
  if (typeof v.id !== "string" || typeof v.content !== "string" || typeof v.createdAt !== "number") return false;
  if (v.role === "user" || v.role === "assistant") return true;
  return v.role === "error" && typeof (v as ErrorMessage).retryOf === "string";
}

export function parseChatHistory(raw: string | null | undefined): ChatMessage[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isMessage).slice(-MAX_STORED_MESSAGES);
  } catch {
    return [];
  }
}

export function serializeChatHistory(messages: readonly ChatMessage[]): string {
  return JSON.stringify(messages.slice(-MAX_STORED_MESSAGES));
}

// ---------------------------------------------------------------------------------------
// Speech
// ---------------------------------------------------------------------------------------

/** Plain text for text-to-speech: strips Markdown syntax, URLs and emoji-only noise. */
export function toSpeechText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_`~>#|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
}

/** User-facing message for a Web Speech API recognition error code. */
export function describeSpeechError(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access is blocked. Allow it in your browser's site settings to use voice input.";
    case "no-speech":
      return "We didn't hear anything. Tap the microphone and try again.";
    case "audio-capture":
      return "No microphone was found on this device.";
    case "network":
      return "Voice input needs an internet connection. Please type your message instead.";
    case "language-not-supported":
      return "Voice input isn't available for this language in your browser.";
    case "aborted":
      return "";
    default:
      return "Voice input stopped unexpectedly. Please try again or type your message.";
  }
}

let idCounter = 0;
/** Unique-enough id for list keys (crypto.randomUUID when available). */
export function newMessageId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    // fall through
  }
  idCounter += 1;
  return `msg-${Date.now().toString(36)}-${idCounter}`;
}
