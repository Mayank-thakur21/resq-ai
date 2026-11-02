"use client";

import { Eye, EyeOff, LogIn } from "lucide-react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import * as React from "react";
import { z } from "zod";

import { OAuthButtons } from "@/app/login/_components/OAuthButtons";
import { authInputClass, authPrimaryButtonClass } from "@/app/login/_components/AuthCard";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import type { OAuthProviderInfo } from "@/lib/auth-providers";

/** Maps NextAuth / `authorize` error codes to user-facing copy. */
export function loginErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  switch (code) {
    case "CredentialsSignin":
      return "Incorrect email or password. Please try again.";
    case "AuthUnavailable":
      return "We can't reach the ResQ AI service right now. Please try again in a moment.";
    case "AuthRateLimited":
      return "Too many failed sign-in attempts. Please wait a few minutes and try again.";
    case "AuthNotConfigured":
    case "Configuration":
      return "Sign-in is temporarily unavailable. Please try again later.";
    case "OAuthAccountNotLinked":
      return "This email is already linked to another sign-in method. Use the method you signed up with.";
    case "AccessDenied":
      return "Access was denied. Please try a different account.";
    case "SessionRequired":
      return "Please sign in to continue.";
    case "OAuthSignin":
    case "OAuthCallback":
    case "OAuthCreateAccount":
    case "Callback":
      return "Signing in with that provider failed. Please try again.";
    default:
      return "Sign-in failed. Please try again.";
  }
}

const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, { error: "Please enter your email" })
    .pipe(z.email({ error: "Please enter a valid email address" })),
  password: z.string().min(1, { error: "Please enter your password" }),
});

type Field = "email" | "password";

export function LoginForm({
  providers,
  callbackUrl,
  initialError,
  registered = false,
}: {
  providers: OAuthProviderInfo[];
  callbackUrl: string;
  initialError: string | null;
  registered?: boolean;
}) {
  const router = useRouter();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const [errors, setErrors] = React.useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = React.useState<string | null>(loginErrorMessage(initialError));
  const [submitting, setSubmitting] = React.useState(false);
  const emailRef = React.useRef<HTMLInputElement>(null);
  const passwordRef = React.useRef<HTMLInputElement>(null);

  const validate = (): boolean => {
    const result = loginSchema.safeParse({ email, password });
    if (result.success) {
      setErrors({});
      return true;
    }
    const next: Partial<Record<Field, string>> = {};
    for (const issue of result.error.issues) {
      const field = issue.path[0];
      if ((field === "email" || field === "password") && !next[field]) next[field] = issue.message;
    }
    setErrors(next);
    (next.email ? emailRef : passwordRef).current?.focus();
    return false;
  };

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    setFormError(null);
    if (!validate()) return;

    setSubmitting(true);
    try {
      const result = await signIn("credentials", {
        email: email.trim(),
        password,
        redirect: false,
        callbackUrl,
      });
      if (!result || result.error || !result.ok) {
        setFormError(loginErrorMessage(result?.error ?? "Default"));
        setSubmitting(false);
        passwordRef.current?.select();
        return;
      }
      router.replace(callbackUrl);
      router.refresh();
    } catch (error) {
      console.error("[login] sign-in request failed", error);
      setFormError(loginErrorMessage("AuthUnavailable"));
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {registered && !formError && (
        <Alert variant="success">
          <AlertDescription>Your account was created. Sign in to continue.</AlertDescription>
        </Alert>
      )}
      {formError && (
        <Alert variant="destructive">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}

      <OAuthButtons providers={providers} callbackUrl={callbackUrl} disabled={submitting} />

      <form noValidate onSubmit={onSubmit} className="space-y-5" aria-busy={submitting}>
        <div className="space-y-2">
          <Label htmlFor="login-email">Email</Label>
          <Input
            ref={emailRef}
            id="login-email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            required
            value={email}
            disabled={submitting}
            onChange={(event) => {
              setEmail(event.target.value);
              if (errors.email) setErrors((prev) => ({ ...prev, email: undefined }));
            }}
            aria-invalid={errors.email ? true : undefined}
            aria-describedby={errors.email ? "login-email-error" : undefined}
            placeholder="you@example.com"
            className={authInputClass}
          />
          {errors.email && (
            <p id="login-email-error" className="text-sm text-red-300">
              {errors.email}
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="login-password">Password</Label>
          <div className="relative">
            <Input
              ref={passwordRef}
              id="login-password"
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              required
              value={password}
              disabled={submitting}
              onChange={(event) => {
                setPassword(event.target.value);
                if (errors.password) setErrors((prev) => ({ ...prev, password: undefined }));
              }}
              aria-invalid={errors.password ? true : undefined}
              aria-describedby={errors.password ? "login-password-error" : undefined}
              placeholder="Your password"
              className={`${authInputClass} pr-11`}
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
          {errors.password && (
            <p id="login-password-error" className="text-sm text-red-300">
              {errors.password}
            </p>
          )}
        </div>

        <button type="submit" disabled={submitting} className={authPrimaryButtonClass}>
          {submitting ? (
            <Spinner size="sm" label="Signing in" showLabel className="text-white" />
          ) : (
            <>
              <LogIn aria-hidden="true" className="size-4" />
              Sign in
            </>
          )}
        </button>
      </form>
    </div>
  );
}
