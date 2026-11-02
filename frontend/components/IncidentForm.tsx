"use client";

/**
 * Incident report form (`/incidents/new`).
 *
 * - Fields: type (select), severity (segmented control of radios), description with a
 *   live counter, optional image URL, and the {@link LocationPicker}.
 * - Validated with zod before submitting; the backend validates again (its 422 message is
 *   shown verbatim if the two ever disagree).
 * - A draft is kept in `sessionStorage`, so an expired session (401 → sign in → come back)
 *   or an accidental reload does not lose a half-written report.
 * - Success → redirect to the new incident's detail page (`?created=1` shows a banner).
 */

import { Link2, Send } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import * as React from "react";
import { z } from "zod";

import { LocationPicker } from "@/components/LocationPicker";
import {
  DESCRIPTION_MAX,
  DESCRIPTION_MIN,
  DISASTER_TYPE_OPTIONS,
  IMAGE_URL_MAX,
  SEVERITY_HINTS,
  SEVERITY_META,
  isDisasterType,
  isSeverity,
} from "@/components/map/incident-meta";
import { isValidLatLon, signInHref } from "@/components/map/layers";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { createIncident, getErrorMessage, isApiError } from "@/lib/api";
import { DISASTER_TYPES, SEVERITIES, type Incident, type IncidentInput, type LatLon } from "@/lib/types";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------

export interface IncidentFormValues {
  disaster_type: string;
  severity: string;
  description: string;
  image_url: string;
  location: LatLon | null;
}

export type IncidentFormField = keyof IncidentFormValues;

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !!url.hostname;
  } catch {
    return false;
  }
}

export const incidentFormSchema = z.object({
  disaster_type: z.enum(DISASTER_TYPES as [string, ...string[]], { error: "Choose what happened." }),
  severity: z.enum(SEVERITIES as [string, ...string[]], { error: "Choose how severe it is." }),
  description: z
    .string()
    .trim()
    .min(DESCRIPTION_MIN, { error: `Describe the incident in at least ${DESCRIPTION_MIN} characters.` })
    .max(DESCRIPTION_MAX, { error: `Keep the description under ${DESCRIPTION_MAX} characters.` }),
  image_url: z
    .string()
    .trim()
    .max(IMAGE_URL_MAX, { error: `Image links can be at most ${IMAGE_URL_MAX} characters.` })
    .refine((value) => value === "" || isHttpUrl(value), {
      error: "Enter a full image link starting with https:// (or leave it empty).",
    }),
  location: z.custom<LatLon>(
    (value) => !!value && typeof value === "object" && isValidLatLon((value as LatLon).lat, (value as LatLon).lon),
    { error: "Set the incident location: use your location, pick it on the map or enter coordinates." },
  ),
});

export type IncidentFormResult =
  | { ok: true; data: IncidentInput }
  | { ok: false; errors: Partial<Record<IncidentFormField, string>> };

/** Validates the form and builds the `POST /api/incidents` body. */
export function validateIncidentForm(values: IncidentFormValues): IncidentFormResult {
  const result = incidentFormSchema.safeParse(values);
  if (!result.success) {
    const errors: Partial<Record<IncidentFormField, string>> = {};
    for (const issue of result.error.issues) {
      const field = issue.path[0] as IncidentFormField | undefined;
      if (field && !errors[field]) errors[field] = issue.message;
    }
    return { ok: false, errors };
  }
  const { disaster_type, severity, description, image_url, location } = result.data;
  if (!isDisasterType(disaster_type) || !isSeverity(severity)) {
    return { ok: false, errors: { disaster_type: "Choose what happened." } };
  }
  const body: IncidentInput = {
    lat: location.lat,
    lon: location.lon,
    disaster_type,
    severity,
    description,
  };
  if (image_url) body.image_url = image_url;
  return { ok: true, data: body };
}

// ---------------------------------------------------------------------------------------
// Draft persistence (sessionStorage; best effort)
// ---------------------------------------------------------------------------------------

export const INCIDENT_DRAFT_KEY = "resq_incident_draft";

function loadDraft(): Partial<IncidentFormValues> | null {
  try {
    const raw = window.sessionStorage.getItem(INCIDENT_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Record<IncidentFormField, unknown>>;
    const draft: Partial<IncidentFormValues> = {};
    if (typeof parsed.disaster_type === "string") draft.disaster_type = parsed.disaster_type;
    if (typeof parsed.severity === "string") draft.severity = parsed.severity;
    if (typeof parsed.description === "string") draft.description = parsed.description.slice(0, DESCRIPTION_MAX + 50);
    if (typeof parsed.image_url === "string") draft.image_url = parsed.image_url.slice(0, IMAGE_URL_MAX + 50);
    const loc = parsed.location as LatLon | null | undefined;
    if (loc && isValidLatLon(loc.lat, loc.lon)) draft.location = { lat: loc.lat, lon: loc.lon };
    return draft;
  } catch {
    return null;
  }
}

function saveDraft(values: IncidentFormValues): void {
  try {
    window.sessionStorage.setItem(INCIDENT_DRAFT_KEY, JSON.stringify(values));
  } catch {
    // Storage unavailable: drafts are a convenience only.
  }
}

function clearDraft(): void {
  try {
    window.sessionStorage.removeItem(INCIDENT_DRAFT_KEY);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------------------

export interface IncidentFormProps {
  /** Pre-filled location (e.g. `/incidents/new?lat&lon` from the map). Wins over a draft. */
  initialLocation?: LatLon | null;
  /** Called after a successful submit. Default: navigate to the incident's detail page. */
  onCreated?: (incident: Incident) => void;
}

const FIELD_ORDER: readonly IncidentFormField[] = [
  "disaster_type",
  "severity",
  "description",
  "image_url",
  "location",
];

const fieldClass =
  "rounded-xl border-slate-700 bg-slate-950/60 text-base text-white placeholder:text-slate-500 dark:bg-slate-950/60";

export function IncidentForm({ initialLocation = null, onCreated }: IncidentFormProps) {
  const router = useRouter();
  const { data: session, status: sessionStatus } = useSession();

  const [values, setValues] = React.useState<IncidentFormValues>({
    disaster_type: "",
    severity: "medium",
    description: "",
    image_url: "",
    location: initialLocation,
  });
  const [errors, setErrors] = React.useState<Partial<Record<IncidentFormField, string>>>({});
  const [formError, setFormError] = React.useState<{ message: string; signIn?: boolean } | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [draftRestored, setDraftRestored] = React.useState(false);

  const discardDraft = () => {
    clearDraft();
    setDraftRestored(false);
    setErrors({});
    setValues({ disaster_type: "", severity: "medium", description: "", image_url: "", location: initialLocation });
  };

  // Restore a draft after mount (sessionStorage is client-only; avoids hydration mismatch).
  // The save effect is declared first so that, on mount, it runs before the restore and
  // never overwrites a stored draft with the empty initial values.
  const draftLoaded = React.useRef(false);
  React.useEffect(() => {
    if (draftLoaded.current) saveDraft(values);
  }, [values]);
  React.useEffect(() => {
    if (draftLoaded.current) return;
    draftLoaded.current = true;
    const draft = loadDraft();
    if (!draft || (!draft.description?.trim() && !draft.disaster_type && !draft.image_url?.trim())) return;
    setDraftRestored(true);
    setValues((prev) => ({
      ...prev,
      ...draft,
      // An explicit location in the URL beats the one remembered in the draft.
      location: initialLocation ?? draft.location ?? prev.location,
    }));
  }, [initialLocation]);

  const formRef = React.useRef<HTMLFormElement>(null);
  const update = <K extends IncidentFormField>(field: K, value: IncidentFormValues[K]) => {
    setValues((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  // Stable identity: LocationPicker / PickerMap use it in effects and memoised handlers.
  const setLocation = React.useCallback((location: LatLon | null) => {
    setValues((prev) => ({ ...prev, location }));
    setErrors((prev) => (prev.location ? { ...prev, location: undefined } : prev));
  }, []);

  const focusFirstError = (fieldErrors: Partial<Record<IncidentFormField, string>>) => {
    const first = FIELD_ORDER.find((field) => fieldErrors[field]);
    if (!first || !formRef.current) return;
    const target = formRef.current.querySelector<HTMLElement>(`[data-field="${first}"]`);
    const focusable =
      target?.matches("input, select, textarea, button")
        ? target
        : target?.querySelector<HTMLElement>("input:checked, input, select, textarea, button");
    focusable?.focus();
  };

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    setFormError(null);

    const result = validateIncidentForm(values);
    if (!result.ok) {
      setErrors(result.errors);
      focusFirstError(result.errors);
      return;
    }

    setErrors({});
    setSubmitting(true);
    try {
      const created = await createIncident(result.data);
      clearDraft();
      if (onCreated) {
        onCreated(created);
      } else {
        router.push(`/incidents/${encodeURIComponent(created.id)}?created=1`);
      }
      // Stay in the submitting state while navigating away.
    } catch (error) {
      console.error("[IncidentForm] submit failed", error);
      if (isApiError(error) && error.status === 401) {
        setFormError({
          message: "Your session has expired. Sign in again — your draft is saved on this device.",
          signIn: true,
        });
      } else if (isApiError(error) && (error.status === 422 || error.status === 400)) {
        setFormError({ message: `Please check the report: ${error.message}` });
      } else {
        setFormError({
          message: getErrorMessage(error, "We couldn't submit your report. Your draft is saved — please try again."),
        });
      }
      setSubmitting(false);
    }
  };

  const descriptionLength = values.description.trim().length;
  const counterTone =
    descriptionLength > DESCRIPTION_MAX
      ? "text-red-300"
      : descriptionLength > DESCRIPTION_MAX * 0.9
        ? "text-amber-300"
        : "text-slate-500";

  return (
    <form ref={formRef} noValidate onSubmit={onSubmit} aria-busy={submitting} className="space-y-6">
      {formError && (
        <Alert variant="destructive">
          <AlertTitle>Report not submitted</AlertTitle>
          <AlertDescription>
            {formError.message}{" "}
            {formError.signIn && (
              <Link href={signInHref("/incidents/new")} className="font-semibold text-white underline underline-offset-2">
                Sign in
              </Link>
            )}
          </AlertDescription>
        </Alert>
      )}

      {draftRestored && !formError && (
        <Alert variant="info">
          <AlertDescription>
            We restored your unsent draft from earlier.{" "}
            <button
              type="button"
              onClick={discardDraft}
              disabled={submitting}
              className="font-semibold text-white underline underline-offset-2"
            >
              Start over
            </button>
          </AlertDescription>
        </Alert>
      )}

      {sessionStatus === "authenticated" && session?.user && (
        <p className="text-sm text-slate-400">
          Reporting as <span className="font-semibold text-slate-200">{session.user.name || session.user.email}</span>.
          Your name is shown with the report.
        </p>
      )}

      {/* Type */}
      <div className="space-y-2" data-field="disaster_type">
        <Label htmlFor="incident-type" required>
          What happened?
        </Label>
        <Select
          id="incident-type"
          value={values.disaster_type}
          disabled={submitting}
          onChange={(event) => update("disaster_type", event.target.value)}
          aria-invalid={errors.disaster_type ? true : undefined}
          aria-describedby={errors.disaster_type ? "incident-type-error" : undefined}
          className="[&>select]:h-11 [&>select]:rounded-xl [&>select]:text-base"
        >
          <option value="" disabled>
            Choose a type…
          </option>
          {DISASTER_TYPE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        {errors.disaster_type && (
          <p id="incident-type-error" className="text-sm text-red-300">
            {errors.disaster_type}
          </p>
        )}
      </div>

      {/* Severity (segmented control built from native radios: arrow keys work natively) */}
      <fieldset
        data-field="severity"
        aria-describedby={errors.severity ? "incident-severity-error" : undefined}
        disabled={submitting}
      >
        <legend className="mb-2 flex items-center gap-1 text-sm font-medium text-slate-200">
          Severity
          <span aria-hidden="true" className="text-red-400">
            *
          </span>
        </legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {SEVERITIES.map((severity) => {
            const meta = SEVERITY_META[severity];
            const checked = values.severity === severity;
            return (
              <label
                key={severity}
                className={cn(
                  "relative flex cursor-pointer flex-col gap-0.5 rounded-xl border px-3 py-2.5 text-left transition-colors",
                  "has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-blue-400/60",
                  checked ? meta.selectedClass : "border-slate-700 bg-slate-950/50 text-slate-300 hover:border-slate-500",
                )}
              >
                <input
                  type="radio"
                  name="severity"
                  value={severity}
                  checked={checked}
                  onChange={() => update("severity", severity)}
                  className="sr-only"
                />
                <span className="flex items-center gap-2 text-sm font-semibold">
                  <span aria-hidden="true" className={cn("size-2.5 rounded-full", meta.accentClass)} />
                  {meta.label}
                </span>
                <span className="text-xs opacity-80">{SEVERITY_HINTS[severity]}</span>
              </label>
            );
          })}
        </div>
        {errors.severity && (
          <p id="incident-severity-error" className="mt-2 text-sm text-red-300">
            {errors.severity}
          </p>
        )}
      </fieldset>

      {/* Description */}
      <div className="space-y-2" data-field="description">
        <div className="flex items-end justify-between gap-2">
          <Label htmlFor="incident-description" required>
            Description
          </Label>
          <span id="incident-description-count" className={cn("text-xs tabular-nums", counterTone)} aria-live="polite">
            {descriptionLength}/{DESCRIPTION_MAX}
          </span>
        </div>
        <Textarea
          id="incident-description"
          value={values.description}
          disabled={submitting}
          onChange={(event) => update("description", event.target.value)}
          rows={5}
          maxLength={DESCRIPTION_MAX + 200}
          placeholder="What do you see? Is anyone hurt or trapped? Which roads or buildings are affected?"
          aria-invalid={errors.description ? true : undefined}
          aria-describedby={[
            "incident-description-count",
            errors.description ? "incident-description-error" : "incident-description-hint",
          ].join(" ")}
          className={cn(fieldClass, "min-h-32 px-3 py-2.5")}
        />
        {errors.description ? (
          <p id="incident-description-error" className="text-sm text-red-300">
            {errors.description}
          </p>
        ) : (
          <p id="incident-description-hint" className="text-xs text-slate-500">
            At least {DESCRIPTION_MIN} characters. Don&apos;t include personal phone numbers.
          </p>
        )}
      </div>

      {/* Image URL */}
      <div className="space-y-2" data-field="image_url">
        <Label htmlFor="incident-image">
          Photo link <span className="font-normal text-slate-500">(optional)</span>
        </Label>
        <div className="relative">
          <Link2 aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-500" />
          <Input
            id="incident-image"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={values.image_url}
            disabled={submitting}
            onChange={(event) => update("image_url", event.target.value)}
            placeholder="https://…"
            aria-invalid={errors.image_url ? true : undefined}
            aria-describedby={errors.image_url ? "incident-image-error" : "incident-image-hint"}
            className={cn(fieldClass, "h-11 pl-9")}
          />
        </div>
        {errors.image_url ? (
          <p id="incident-image-error" className="text-sm text-red-300">
            {errors.image_url}
          </p>
        ) : (
          <p id="incident-image-hint" className="text-xs text-slate-500">
            A public link to a photo of the scene (http or https).
          </p>
        )}
      </div>

      {/* Location */}
      <div data-field="location">
        <LocationPicker
          id="incident-location"
          value={values.location}
          onChange={setLocation}
          error={errors.location}
          disabled={submitting}
        />
      </div>

      <div className="flex flex-col-reverse gap-3 border-t border-slate-700/60 pt-6 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-slate-500">
          In immediate danger? Call 112 first, or use{" "}
          <Link href="/sos" className="font-semibold text-red-300 hover:underline">
            SOS
          </Link>
          .
        </p>
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-red-600 px-6 text-sm font-semibold text-white shadow-lg shadow-red-900/30 transition-colors hover:bg-red-500 focus-visible:ring-3 focus-visible:ring-red-400/60 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? (
            <Spinner size="sm" label="Submitting report" showLabel className="text-white" />
          ) : (
            <>
              <Send aria-hidden="true" className="size-4" />
              Submit report
            </>
          )}
        </button>
      </div>
    </form>
  );
}

export default IncidentForm;
