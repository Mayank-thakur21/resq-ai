"use client";

import { Eye, EyeOff, UserPlus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import * as React from "react";

import { OAuthButtons } from "@/app/login/_components/OAuthButtons";
import { authInputClass, authPrimaryButtonClass } from "@/app/login/_components/AuthCard";
import { NAME_MAX, PASSWORD_MAX, PASSWORD_MIN, fieldErrors, registerSchema } from "@/app/register/schema";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { errorFromResponse, getErrorMessage } from "@/lib/api";
import type { OAuthProviderInfo } from "@/lib/auth-providers";
import { cn } from "@/lib/utils";

type Field = "name" | "email" | "password" | "confirm";
type Errors = Partial<Record<Field, string>>;

/** Rough strength score 0–4 for the hint bar (not a security control; the backend rules). */
export function passwordStrength(password: string): number {
  if (!password) return 0;
  let score = 0;
  if (password.length >= PASSWORD_MIN) score += 1;
  if (password.length >= 12) score += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
  if (/\d/.test(password) && /[^A-Za-z0-9]/.test(password)) score += 1;
  return score;
}

const STRENGTH_LABELS = ["Too short", "Weak", "Fair", "Good", "Strong"] as const;
const STRENGTH_COLORS = ["bg-slate-700", "bg-red-500", "bg-amber-500", "bg-lime-500", "bg-emerald-500"] as const;

export function RegisterForm({
  providers,
  callbackUrl,
  loginHref,
}: {
  providers: OAuthProviderInfo[];
  callbackUrl: string;
  loginHref: string;
}) {
  const router = useRouter();
  const [values, setValues] = React.useState({ name: "", email: "", password: "", confirm: "" });
  const [showPassword, setShowPassword] = React.useState(false);
  const [errors, setErrors] = React.useState<Errors>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [emailTaken, setEmailTaken] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const formRef = React.useRef<HTMLFormElement>(null);

  const strength = passwordStrength(values.password);

  const update = (field: Field) => (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    setValues((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) setErrors((prev) => ({ ...prev, [field]: undefined }));
    if (field === "email") setEmailTaken(false);
  };

  const focusFirstError = (next: Errors) => {
    const first = (["name", "email", "password", "confirm"] as const).find((field) => next[field]);
    if (first) formRef.current?.querySelector<HTMLInputElement>(`[name="${first}"]`)?.focus();
  };

  const validate = (): Errors => {
    const next: Errors = {};
    const result = registerSchema.safeParse(values);
    if (!result.success) Object.assign(next, fieldErrors(result.error));
    if (!values.confirm) next.confirm = "Please confirm your password";
    else if (values.confirm !== values.password) next.confirm = "Passwords do not match";
    return next;
  };

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    setFormError(null);
    setEmailTaken(false);

    const next = validate();
    setErrors(next);
    if (Object.keys(next).length > 0) {
      focusFirstError(next);
      return;
    }

    setSubmitting(true);
    const payload = {
      name: values.name.trim(),
      email: values.email.trim().toLowerCase(),
      password: values.password,
    };

    try {
      const response = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const error = await errorFromResponse(response);
        if (error.status === 409) {
          setEmailTaken(true);
          setErrors({ email: "An account with this email already exists" });
          focusFirstError({ email: "taken" });
        } else {
          setFormError(getErrorMessage(error, "Registration failed. Please try again."));
        }
        setSubmitting(false);
        return;
      }

      // Account created: sign in straight away with the same credentials.
      const result = await signIn("credentials", {
        email: payload.email,
        password: payload.password,
        redirect: false,
        callbackUrl,
      });
      if (result?.ok && !result.error) {
        router.replace(callbackUrl);
        router.refresh();
        return;
      }
      const separator = loginHref.includes("?") ? "&" : "?";
      router.replace(`${loginHref}${separator}registered=1`);
    } catch (error) {
      console.error("[register] request failed", error);
      setFormError("We can't reach ResQ AI right now. Check your connection and try again.");
      setSubmitting(false);
    }
  };

  const fieldProps = (field: Field) => ({
    name: field,
    value: values[field],
    onChange: update(field),
    disabled: submitting,
    "aria-invalid": errors[field] ? true : undefined,
    "aria-describedby": errors[field] ? `register-${field}-error` : undefined,
  });

  const fieldError = (field: Field) =>
    errors[field] ? (
      <p id={`register-${field}-error`} className="text-sm text-red-300">
        {errors[field]}
        {field === "email" && emailTaken && (
          <>
            {" "}
            <Link href={loginHref} className="font-semibold text-cyan-300 underline">
              Sign in instead
            </Link>
          </>
        )}
      </p>
    ) : null;

  return (
    <div className="space-y-6">
      {formError && (
        <Alert variant="destructive">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}

      <OAuthButtons providers={providers} callbackUrl={callbackUrl} disabled={submitting} />

      <form ref={formRef} noValidate onSubmit={onSubmit} className="space-y-5" aria-busy={submitting}>
        <div className="space-y-2">
          <Label htmlFor="register-name">Name</Label>
          <Input
            id="register-name"
            autoComplete="name"
            maxLength={NAME_MAX}
            placeholder="Your name"
            className={authInputClass}
            {...fieldProps("name")}
          />
          {fieldError("name")}
        </div>

        <div className="space-y-2">
          <Label htmlFor="register-email">Email</Label>
          <Input
            id="register-email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="you@example.com"
            className={authInputClass}
            {...fieldProps("email")}
          />
          {fieldError("email")}
        </div>

        <div className="space-y-2">
          <Label htmlFor="register-password">Password</Label>
          <div className="relative">
            <Input
              id="register-password"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              maxLength={PASSWORD_MAX}
              placeholder={`At least ${PASSWORD_MIN} characters`}
              className={cn(authInputClass, "pr-11")}
              {...fieldProps("password")}
              aria-describedby={
                errors.password
                  ? "register-password-hint register-password-error"
                  : "register-password-hint"
              }
            />
            <button
              type="button"
              onClick={() => setShowPassword((value) => !value)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
              className="absolute top-1/2 right-2 -translate-y-1/2 rounded-lg p-1.5 text-slate-400 hover:text-white focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:outline-none"
            >
              {showPassword ? <EyeOff aria-hidden="true" className="size-4" /> : <Eye aria-hidden="true" className="size-4" />}
            </button>
          </div>
          <div id="register-password-hint" className="space-y-1">
            <div className="grid grid-cols-4 gap-1" aria-hidden="true">
              {[1, 2, 3, 4].map((step) => (
                <span
                  key={step}
                  className={cn(
                    "h-1 rounded-full transition-colors",
                    strength >= step ? STRENGTH_COLORS[strength] : "bg-slate-700",
                  )}
                />
              ))}
            </div>
            <p className="text-xs text-slate-400">
              {values.password ? `Strength: ${STRENGTH_LABELS[strength]}. ` : ""}
              Use {PASSWORD_MIN}+ characters; mixing cases, numbers and symbols makes it stronger.
            </p>
          </div>
          {fieldError("password")}
        </div>

        <div className="space-y-2">
          <Label htmlFor="register-confirm">Confirm password</Label>
          <Input
            id="register-confirm"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            maxLength={PASSWORD_MAX}
            placeholder="Repeat your password"
            className={authInputClass}
            {...fieldProps("confirm")}
          />
          {fieldError("confirm")}
        </div>

        <button type="submit" disabled={submitting} className={authPrimaryButtonClass}>
          {submitting ? (
            <Spinner size="sm" label="Creating your account" showLabel className="text-white" />
          ) : (
            <>
              <UserPlus aria-hidden="true" className="size-4" />
              Create account
            </>
          )}
        </button>
        <p className="text-center text-xs text-slate-500">
          By creating an account you agree to our{" "}
          <Link href="/privacy" className="underline hover:text-slate-300">
            privacy policy
          </Link>
          .
        </p>
      </form>
    </div>
  );
}
