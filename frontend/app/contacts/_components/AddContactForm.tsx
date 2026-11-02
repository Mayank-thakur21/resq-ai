"use client";

import { Plus } from "lucide-react";
import * as React from "react";

import { Label } from "@/components/ui/label";
import type { ContactInputResult } from "@/lib/contacts";
import { MAX_CONTACT_NAME_LENGTH } from "@/lib/contacts";
import { MAX_PHONE_INPUT_LENGTH, toE164 } from "@/lib/phone";
import { cn } from "@/lib/utils";

export interface AddContactFormProps {
  /** Validates + saves; returns field errors on failure. */
  onAdd: (input: { name: string; phone: string }) => ContactInputResult;
}

const fieldClass =
  "h-12 w-full rounded-xl border border-slate-700 bg-slate-900/70 px-3 text-base text-slate-100 placeholder:text-slate-500 transition-colors outline-none focus-visible:border-purple-400 focus-visible:ring-3 focus-visible:ring-purple-500/30 aria-invalid:border-red-500 aria-invalid:ring-3 aria-invalid:ring-red-500/20 md:text-sm";

/** "Add a trusted contact" form with inline validation and an E.164 (country code) hint. */
export function AddContactForm({ onAdd }: AddContactFormProps) {
  const nameId = React.useId();
  const phoneId = React.useId();
  const nameErrorId = React.useId();
  const phoneHintId = React.useId();
  const phoneErrorId = React.useId();
  const nameRef = React.useRef<HTMLInputElement>(null);

  const [name, setName] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [errors, setErrors] = React.useState<{ name?: string; phone?: string; form?: string }>({});
  const [saved, setSaved] = React.useState<{ name: string; sosReady: boolean } | null>(null);

  const typedLooksLocal = phone.trim().length >= 6 && !toE164(phone);

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = onAdd({ name, phone });
    if (!result.ok) {
      setErrors(result.errors);
      setSaved(null);
      return;
    }
    setErrors({});
    setSaved({ name: result.contact.name, sosReady: !!toE164(result.contact.phone) });
    setName("");
    setPhone("");
    nameRef.current?.focus();
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-3" aria-label="Add a trusted contact">
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-start">
        <div className="grid gap-1.5">
          <Label htmlFor={nameId}>Name</Label>
          <input
            ref={nameRef}
            id={nameId}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (errors.name) setErrors((current) => ({ ...current, name: undefined }));
            }}
            placeholder="e.g. Mom"
            autoComplete="off"
            maxLength={MAX_CONTACT_NAME_LENGTH + 20}
            aria-invalid={!!errors.name || undefined}
            aria-describedby={errors.name ? nameErrorId : undefined}
            className={fieldClass}
          />
          {errors.name && (
            <p id={nameErrorId} className="text-xs text-red-300">
              {errors.name}
            </p>
          )}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={phoneId}>Phone number</Label>
          <input
            id={phoneId}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={phone}
            onChange={(event) => {
              setPhone(event.target.value);
              if (errors.phone) setErrors((current) => ({ ...current, phone: undefined }));
            }}
            placeholder="+91 98765 43210"
            maxLength={MAX_PHONE_INPUT_LENGTH}
            aria-invalid={!!errors.phone || undefined}
            aria-describedby={cn(phoneHintId, errors.phone && phoneErrorId)}
            className={fieldClass}
          />
          {errors.phone && (
            <p id={phoneErrorId} className="text-xs text-red-300">
              {errors.phone}
            </p>
          )}
        </div>
        <button
          type="submit"
          className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-purple-600 px-6 text-sm font-semibold text-white transition-colors hover:bg-purple-500 focus-visible:ring-2 focus-visible:ring-purple-300 focus-visible:outline-none sm:mt-[1.375rem]"
        >
          <Plus aria-hidden="true" className="size-4" />
          Add
        </button>
      </div>
      <p id={phoneHintId} className={cn("text-xs", typedLooksLocal ? "text-amber-200" : "text-slate-400")}>
        {typedLooksLocal
          ? "Tip: start with + and the country code (e.g. +91 for India) so this contact can receive SOS texts."
          : "Include the country code (e.g. +91…) so ResQ AI can text this contact when you send an SOS."}
      </p>
      {errors.form && (
        <p role="alert" className="text-sm text-red-300">
          {errors.form}
        </p>
      )}
      {saved && (
        <p role="status" className={cn("text-sm", saved.sosReady ? "text-emerald-300" : "text-amber-200")}>
          {saved.sosReady
            ? `${saved.name} was added and can receive SOS texts.`
            : `${saved.name} was added. Without a country code they can be called, but not texted automatically during an SOS.`}
        </p>
      )}
    </form>
  );
}

export default AddContactForm;
