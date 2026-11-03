"use client";

import { MotionConfig, motion } from "framer-motion";
import { Activity, RefreshCw, Trash2, Volume2, VolumeX } from "lucide-react";
import * as React from "react";

import { ChatComposer } from "@/app/chat/_components/ChatComposer";
import { AssistantBubble, ErrorBubble, TypingIndicator, UserBubble } from "@/app/chat/_components/ChatMessages";
import {
  type AssistantMessage,
  buildChatRequest,
  CHAT_HISTORY_STORAGE_KEY,
  CHAT_LANGUAGE_STORAGE_KEY,
  CHAT_LANGUAGES,
  CHAT_SUGGESTIONS,
  CHAT_TTS_STORAGE_KEY,
  type ChatMessage,
  type ErrorMessage,
  findLanguage,
  newMessageId,
  parseChatHistory,
  serializeChatHistory,
  toAssistantMeta,
  toSpeechText,
  type UserMessage,
  WELCOME_MESSAGE,
} from "@/app/chat/chat-helpers";
import { formatAccuracy } from "@/app/sos/sos-helpers";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { chat, getErrorMessage, isApiError } from "@/lib/api";
import { useGeolocation } from "@/lib/geo";
import { cn } from "@/lib/utils";

const WELCOME: AssistantMessage = { id: "welcome", role: "assistant", content: WELCOME_MESSAGE, createdAt: 0 };

function readStorage(storage: "local" | "session", key: string): string | null {
  try {
    return (storage === "local" ? window.localStorage : window.sessionStorage).getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(storage: "local" | "session", key: string, value: string | null): void {
  try {
    const target = storage === "local" ? window.localStorage : window.sessionStorage;
    if (value === null) target.removeItem(key);
    else target.setItem(key, value);
  } catch {
    // Storage unavailable (private mode): preferences/history just aren't remembered.
  }
}

function isSpeechSynthesisSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

function cancelSpeech(): void {
  try {
    if (isSpeechSynthesisSupported()) window.speechSynthesis.cancel();
  } catch {
    // ignore
  }
}

/**
 * `/chat` — multi-agent emergency assistant. Talks to `POST /chat` through `lib/api`,
 * optionally with the user's location (opt-in), renders the agents' structured output
 * (trace, urgency, actions, emergency numbers, advisory, nearby hospitals/shelters), and
 * shows failures as an inline error bubble with "Retry". The conversation survives
 * navigation within the tab (sessionStorage).
 */
export default function ChatView() {
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [hydrated, setHydrated] = React.useState(false);
  const [input, setInput] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [language, setLanguage] = React.useState("en");
  const [ttsEnabled, setTtsEnabled] = React.useState(true);
  const [ttsSupported, setTtsSupported] = React.useState(false);
  const [shareLocation, setShareLocation] = React.useState(false);
  const geo = useGeolocation({ auto: false, timeoutMs: 15_000 });

  const abortRef = React.useRef<AbortController | null>(null);
  const endRef = React.useRef<HTMLDivElement>(null);

  // Restore the conversation and preferences after hydration.
  React.useEffect(() => {
    setMessages(parseChatHistory(readStorage("session", CHAT_HISTORY_STORAGE_KEY)));
    if (readStorage("local", CHAT_TTS_STORAGE_KEY) === "off") setTtsEnabled(false);
    const storedLanguage = readStorage("local", CHAT_LANGUAGE_STORAGE_KEY);
    if (storedLanguage) setLanguage(findLanguage(storedLanguage).code);
    setTtsSupported(isSpeechSynthesisSupported());
    setHydrated(true);
  }, []);

  React.useEffect(() => {
    if (hydrated) writeStorage("session", CHAT_HISTORY_STORAGE_KEY, serializeChatHistory(messages));
  }, [messages, hydrated]);

  React.useEffect(() => {
    endRef.current?.scrollIntoView?.({ behavior: "smooth", block: "end" });
  }, [messages, pending]);

  React.useEffect(
    () => () => {
      abortRef.current?.abort();
      cancelSpeech();
    },
    [],
  );

  const speechLang = findLanguage(language).speech;

  const speak = React.useCallback(
    (text: string, force = false) => {
      if (!isSpeechSynthesisSupported() || (!ttsEnabled && !force)) return;
      try {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(toSpeechText(text));
        utterance.lang = speechLang;
        window.speechSynthesis.speak(utterance);
      } catch (error) {
        console.warn("[chat] text-to-speech failed", error);
      }
    },
    [speechLang, ttsEnabled],
  );

  const location = React.useMemo(
    () => (shareLocation && geo.coords ? { lat: geo.coords.lat, lon: geo.coords.lon } : null),
    [shareLocation, geo.coords],
  );

  const ask = React.useCallback(
    async (userMessage: UserMessage) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setPending(true);
      try {
        const response = await chat(buildChatRequest(userMessage.content, language, location), {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        const reply: AssistantMessage = {
          id: newMessageId(),
          role: "assistant",
          content: response.response?.trim() || "I couldn't put an answer together. Please rephrase your question.",
          createdAt: Date.now(),
          meta: toAssistantMeta(response),
        };
        setMessages((current) => [...current, reply]);
        speak(reply.content);
      } catch (error) {
        if (controller.signal.aborted) return;
        console.warn("[chat] request failed", error);
        const network =
          isApiError(error) &&
          (error.isNetworkError || error.code === "backend_unreachable" || error.code === "backend_timeout");
        const failure: ErrorMessage = {
          id: newMessageId(),
          role: "error",
          content: getErrorMessage(error, "ResQ AI couldn't answer right now."),
          createdAt: Date.now(),
          retryOf: userMessage.id,
          network,
        };
        setMessages((current) => [...current, failure]);
      } finally {
        if (!controller.signal.aborted) setPending(false);
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [language, location, speak],
  );

  const send = (text: string = input) => {
    const content = text.trim();
    if (!content || pending) return;
    const userMessage: UserMessage = { id: newMessageId(), role: "user", content, createdAt: Date.now() };
    setMessages((current) => [...current, userMessage]);
    setInput("");
    void ask(userMessage);
  };

  const retry = (failure: ErrorMessage) => {
    if (pending) return;
    const original = messages.find((message): message is UserMessage => message.id === failure.retryOf && message.role === "user");
    setMessages((current) => current.filter((message) => message.id !== failure.id));
    if (original) void ask(original);
  };

  const clearConversation = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    cancelSpeech();
    setPending(false);
    setMessages([]);
  };

  const toggleTts = () => {
    const next = !ttsEnabled;
    setTtsEnabled(next);
    writeStorage("local", CHAT_TTS_STORAGE_KEY, next ? "on" : "off");
    if (!next) cancelSpeech();
  };

  const changeLanguage = (code: string) => {
    setLanguage(code);
    writeStorage("local", CHAT_LANGUAGE_STORAGE_KEY, code);
  };

  const toggleLocation = () => {
    if (shareLocation) {
      setShareLocation(false);
      return;
    }
    setShareLocation(true);
    if (geo.status !== "ready" && geo.status !== "locating") geo.retry();
  };

  let locationStatus: React.ReactNode = "Share your location to find hospitals and shelters near you.";
  if (shareLocation) {
    if (geo.coords && geo.status === "ready") {
      const accuracy = formatAccuracy(geo.coords.accuracy);
      locationStatus = (
        <span className="text-emerald-300">Location shared{accuracy ? ` (${accuracy})` : ""}.</span>
      );
    } else if (geo.status === "denied" || geo.status === "unavailable" || geo.status === "error") {
      locationStatus = (
        <span className="text-amber-200">
          {geo.error}{" "}
          <button type="button" onClick={geo.retry} className="inline-flex items-center gap-1 font-semibold underline">
            <RefreshCw aria-hidden="true" className="size-3" />
            Retry
          </button>
        </span>
      );
    } else {
      locationStatus = <Spinner size="sm" showLabel label="Finding your location…" className="text-xs" />;
    }
  }

  const hasUserMessages = messages.some((message) => message.role === "user");

  // Exactly fills the viewport between the navbar and the mobile tab bar (composer always
  // visible), minus the offline banner while it is shown (`OFFLINE_BANNER_HEIGHT_VAR`).
  return (
    <MotionConfig reducedMotion="user">
      <div className="mx-auto flex h-[calc(100dvh-7.5rem-env(safe-area-inset-bottom)-var(--offline-banner-h))] w-full max-w-5xl flex-col bg-slate-900/50 lg:h-[calc(100dvh-4rem-var(--offline-banner-h))]">
        <header className="flex items-center justify-between gap-3 border-b border-slate-800 bg-slate-950/80 px-4 py-3 backdrop-blur-md sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <span aria-hidden="true" className="hidden rounded-lg bg-red-500/10 p-2 text-red-500 sm:inline-flex">
              <Activity className="size-6" />
            </span>
            <div className="min-w-0">
              <h1 className="truncate bg-gradient-to-r from-white to-slate-400 bg-clip-text text-base font-bold text-transparent sm:text-xl">
                <span className="sm:hidden">AI Assistant</span>
                <span className="hidden sm:inline">Emergency Assistant</span>
              </h1>
              <p className="hidden text-xs text-slate-400 sm:block">Multi-agent AI network online</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <label htmlFor="chat-language" className="sr-only">
              Answer language
            </label>
            <Select
              id="chat-language"
              value={language}
              onChange={(event) => changeLanguage(event.target.value)}
              className="w-28 sm:w-44"
            >
              {CHAT_LANGUAGES.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.label}
                </option>
              ))}
            </Select>
            {ttsSupported && (
              <button
                type="button"
                onClick={toggleTts}
                aria-pressed={ttsEnabled}
                aria-label="Read answers aloud"
                title={ttsEnabled ? "Reading answers aloud" : "Answers are not read aloud"}
                className="inline-flex size-9 items-center justify-center rounded-lg text-slate-300 hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:outline-none"
              >
                {ttsEnabled ? (
                  <Volume2 aria-hidden="true" className="size-5 text-emerald-400" />
                ) : (
                  <VolumeX aria-hidden="true" className="size-5 text-slate-500" />
                )}
              </button>
            )}
            <button
              type="button"
              onClick={clearConversation}
              disabled={messages.length === 0}
              aria-label="Clear conversation"
              title="Clear conversation"
              className="inline-flex size-9 items-center justify-center rounded-lg text-slate-300 hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:outline-none disabled:opacity-40"
            >
              <Trash2 aria-hidden="true" className="size-5" />
            </button>
          </div>
        </header>

        <div
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-label="Conversation"
          className="flex-1 overflow-y-auto px-4 py-6 md:px-6"
        >
          <div className="mx-auto flex max-w-3xl flex-col gap-6">
            <AssistantBubble message={WELCOME} />

            {messages.map((message) => (
              <ErrorBoundary key={message.id} title="This message couldn't be displayed" compact>
                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
                  {message.role === "user" ? (
                    <UserBubble message={message} />
                  ) : message.role === "assistant" ? (
                    <AssistantBubble message={message} canSpeak={ttsSupported} onSpeak={(text) => speak(text, true)} />
                  ) : (
                    <ErrorBubble message={message} onRetry={() => retry(message)} disabled={pending} />
                  )}
                </motion.div>
              </ErrorBoundary>
            ))}

            {hydrated && !hasUserMessages && !pending && (
              <div aria-label="Suggestions" role="group" className="flex flex-wrap gap-2">
                {CHAT_SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => send(suggestion)}
                    className={cn(
                      "rounded-full border border-slate-700 bg-slate-900/70 px-3 py-1.5 text-left text-sm text-slate-300 transition-colors",
                      "hover:border-blue-500/50 hover:text-white focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:outline-none",
                    )}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            )}

            {pending && <TypingIndicator />}
            <div ref={endRef} className="h-2" />
          </div>
        </div>

        <ChatComposer
          value={input}
          onChange={setInput}
          onSubmit={() => send()}
          pending={pending}
          speechLang={speechLang}
          locationShared={shareLocation}
          onToggleLocation={toggleLocation}
          locationStatus={locationStatus}
        />
      </div>
    </MotionConfig>
  );
}
