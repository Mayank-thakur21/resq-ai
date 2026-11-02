"use client";

import * as React from "react";

import {
  effectiveMessage,
  MAX_SOS_MESSAGE_LENGTH,
  MAX_SOS_NAME_LENGTH,
  SOS_MESSAGE_PRESETS,
} from "@/app/sos/sos-helpers";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export interface MessageComposerProps {
  message: string;
  onMessageChange: (message: string) => void;
  name: string;
  onNameChange: (name: string) => void;
  disabled?: boolean;
  className?: string;
}

const fieldClass =
  "w-full rounded-xl border border-slate-700 bg-slate-900/60 px-3 py-2 text-base text-slate-100 placeholder:text-slate-500 transition-colors outline-none focus-visible:border-red-400 focus-visible:ring-3 focus-visible:ring-red-500/30 disabled:opacity-60 md:text-sm";

/** SOS message: one-tap presets, editable text (max 300 chars) and the sender's name. */
export function MessageComposer({
  message,
  onMessageChange,
  name,
  onNameChange,
  disabled = false,
  className,
}: MessageComposerProps) {
  const messageId = React.useId();
  const nameId = React.useId();
  const counterId = React.useId();
  const active = effectiveMessage(message);

  return (
    <section
      aria-labelledby="sos-message-title"
      className={cn("rounded-2xl border border-slate-700 bg-slate-800/50 p-4 backdrop-blur-md", className)}
    >
      <h2 id="sos-message-title" className="mb-3 text-base font-semibold text-white">
        Message
      </h2>
      <fieldset disabled={disabled} className="space-y-4">
        <legend className="sr-only">Choose or write your SOS message</legend>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Message presets">
          {SOS_MESSAGE_PRESETS.map((preset) => {
            const selected = active === preset.text;
            return (
              <button
                key={preset.id}
                type="button"
                aria-pressed={selected}
                onClick={() => onMessageChange(preset.text)}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-red-300 focus-visible:outline-none",
                  selected
                    ? "border-red-400/60 bg-red-500/20 text-red-100"
                    : "border-slate-600 text-slate-300 hover:border-slate-500 hover:text-white",
                )}
              >
                {preset.label}
              </button>
            );
          })}
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor={messageId}>Message text</Label>
          <textarea
            id={messageId}
            value={message}
            onChange={(event) => onMessageChange(event.target.value)}
            maxLength={MAX_SOS_MESSAGE_LENGTH}
            rows={3}
            aria-describedby={counterId}
            placeholder="SOS! I need help!"
            className={cn(fieldClass, "min-h-20 resize-y")}
          />
          <p id={counterId} className="text-right text-xs text-slate-400">
            {message.length}/{MAX_SOS_MESSAGE_LENGTH}
          </p>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor={nameId}>Your name (shown in the text)</Label>
          <input
            id={nameId}
            value={name}
            onChange={(event) => onNameChange(event.target.value)}
            maxLength={MAX_SOS_NAME_LENGTH}
            autoComplete="name"
            placeholder="e.g. Asha"
            className={cn(fieldClass, "h-10")}
          />
        </div>
      </fieldset>
    </section>
  );
}

export default MessageComposer;
