"use client";

import { MapPin, Mic, MicOff, Send } from "lucide-react";
import * as React from "react";

import { describeSpeechError, MAX_CHAT_MESSAGE_LENGTH } from "@/app/chat/chat-helpers";
import { cn } from "@/lib/utils";

// ---- Web Speech API (not in the TypeScript DOM lib) ------------------------------------

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  readonly length: number;
  readonly isFinal: boolean;
  [index: number]: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: { readonly length: number; [index: number]: SpeechRecognitionResultLike };
}
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

export function getSpeechRecognition(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// ---- Component -------------------------------------------------------------------------

export interface ChatComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  pending: boolean;
  /** BCP 47 language for speech recognition. */
  speechLang: string;
  locationShared: boolean;
  onToggleLocation: () => void;
  /** Short status line under the input (location state etc.). */
  locationStatus?: React.ReactNode;
}

/**
 * Message input with location sharing, voice dictation (Web Speech API, inline errors —
 * never `alert()`) and send. Enter sends, Shift+Enter inserts a newline.
 */
export function ChatComposer({
  value,
  onChange,
  onSubmit,
  pending,
  speechLang,
  locationShared,
  onToggleLocation,
  locationStatus,
}: ChatComposerProps) {
  const inputId = React.useId();
  const [recording, setRecording] = React.useState(false);
  const [voiceNotice, setVoiceNotice] = React.useState<string | null>(null);
  const recognitionRef = React.useRef<SpeechRecognitionLike | null>(null);
  const baseTextRef = React.useRef("");

  React.useEffect(
    () => () => {
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    },
    [],
  );

  const toggleVoice = () => {
    if (recording) {
      recognitionRef.current?.stop();
      return;
    }
    const Recognition = getSpeechRecognition();
    if (!Recognition) {
      setVoiceNotice("Voice input isn't supported in this browser. Try Chrome, Edge or Safari, or type your message.");
      return;
    }
    let recognition: SpeechRecognitionLike;
    try {
      recognition = new Recognition();
    } catch (error) {
      console.warn("[chat] speech recognition unavailable", error);
      setVoiceNotice("Voice input isn't available right now. Please type your message.");
      return;
    }
    recognition.lang = speechLang;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    baseTextRef.current = value.trim() ? `${value.trim()} ` : "";

    recognition.onresult = (event) => {
      let transcript = "";
      for (let index = 0; index < event.results.length; index += 1) {
        transcript += event.results[index][0]?.transcript ?? "";
      }
      onChange(`${baseTextRef.current}${transcript}`.slice(0, MAX_CHAT_MESSAGE_LENGTH));
    };
    recognition.onerror = (event) => {
      const message = describeSpeechError(event.error);
      if (message) setVoiceNotice(message);
    };
    recognition.onend = () => {
      setRecording(false);
      recognitionRef.current = null;
    };

    try {
      recognition.start();
      recognitionRef.current = recognition;
      setVoiceNotice(null);
      setRecording(true);
    } catch (error) {
      console.warn("[chat] could not start speech recognition", error);
      setVoiceNotice("Couldn't start voice input. Please try again.");
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!pending && value.trim()) onSubmit();
    }
  };

  const remaining = MAX_CHAT_MESSAGE_LENGTH - value.length;
  const iconButton =
    "inline-flex size-11 shrink-0 items-center justify-center rounded-full border transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50 sm:size-12";

  return (
    <div className="border-t border-slate-800 bg-slate-950/90 p-3 backdrop-blur-md sm:p-4">
      <form
        className="mx-auto flex max-w-3xl items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!pending && value.trim()) onSubmit();
        }}
      >
        <button
          type="button"
          onClick={onToggleLocation}
          aria-pressed={locationShared}
          aria-label={locationShared ? "Stop sharing location" : "Share my location"}
          title={locationShared ? "Stop sharing location" : "Share location for nearby hospitals and shelters"}
          className={cn(
            iconButton,
            locationShared
              ? "border-emerald-500 bg-emerald-600 text-white hover:bg-emerald-500 focus-visible:ring-emerald-300"
              : "border-slate-700 text-slate-300 hover:bg-slate-800 focus-visible:ring-slate-300",
          )}
        >
          <MapPin aria-hidden="true" className="size-5" />
        </button>

        <div className="relative min-w-0 flex-1">
          <label htmlFor={inputId} className="sr-only">
            Describe your situation
          </label>
          <textarea
            id={inputId}
            value={value}
            onChange={(event) => onChange(event.target.value.slice(0, MAX_CHAT_MESSAGE_LENGTH))}
            onKeyDown={onKeyDown}
            placeholder="What's happening?"
            rows={1}
            maxLength={MAX_CHAT_MESSAGE_LENGTH}
            className={cn(
              "block max-h-40 min-h-11 w-full resize-none rounded-3xl border border-transparent bg-slate-900 px-4 py-2.5 text-base text-slate-100 placeholder:text-slate-500 [field-sizing:content] focus-visible:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:outline-none sm:min-h-12 sm:px-5 sm:py-3",
              recording && "pr-12",
            )}
          />
          {recording && (
            <span aria-hidden="true" className="absolute top-1/2 right-4 flex -translate-y-1/2 items-center gap-1">
              {[0, 150, 300].map((delay, index) => (
                <span
                  key={delay}
                  className={cn("w-1.5 rounded-full bg-red-500 motion-safe:animate-bounce", index === 1 ? "h-6" : "h-4")}
                  style={{ animationDelay: `${delay}ms` }}
                />
              ))}
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={toggleVoice}
          aria-pressed={recording}
          aria-label={recording ? "Stop voice input" : "Speak your message"}
          className={cn(
            iconButton,
            recording
              ? "border-red-500 bg-red-600 text-white hover:bg-red-500 focus-visible:ring-red-300"
              : "border-slate-700 text-slate-300 hover:bg-slate-800 focus-visible:ring-slate-300",
          )}
        >
          {recording ? <MicOff aria-hidden="true" className="size-5" /> : <Mic aria-hidden="true" className="size-5" />}
        </button>

        <button
          type="submit"
          disabled={pending || !value.trim()}
          aria-label="Send message"
          className={cn(iconButton, "border-blue-600 bg-blue-600 text-white hover:bg-blue-500 focus-visible:ring-blue-300")}
        >
          <Send aria-hidden="true" className="ml-0.5 size-5" />
        </button>
      </form>

      <div className="mx-auto mt-2 flex max-w-3xl flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1 text-xs">
        <div className="min-w-0 text-slate-400" aria-live="polite">
          {voiceNotice ? <span className="text-amber-200">{voiceNotice}</span> : locationStatus}
        </div>
        {remaining < 200 && (
          <span className={cn("ml-auto", remaining < 50 ? "text-amber-300" : "text-slate-500")}>
            {remaining} characters left
          </span>
        )}
      </div>
    </div>
  );
}

export default ChatComposer;
