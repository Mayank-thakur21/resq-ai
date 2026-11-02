import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";

import { AuthCard } from "@/app/login/_components/AuthCard";
import { LoginForm } from "@/app/login/LoginForm";
import { firstParam, sanitizeCallbackUrl } from "@/app/login/callback-url";
import { authOptions } from "@/lib/auth";
import { getEnabledOAuthProviders } from "@/lib/auth-providers";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to ResQ AI to report incidents, get push alerts and view your SOS history.",
};

// Providers depend on runtime env vars and the page reads the session: never prerender.
export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const callbackUrl = sanitizeCallbackUrl(params.callbackUrl);

  const session = await getServerSession(authOptions).catch(() => null);
  if (session?.user) redirect(callbackUrl);

  const registerHref =
    callbackUrl === "/" ? "/register" : `/register?callbackUrl=${encodeURIComponent(callbackUrl)}`;

  return (
    <AuthCard
      title="Welcome back"
      subtitle="Sign in to report incidents, receive nearby alerts and keep your SOS history."
      footer={
        <>
          New to ResQ AI?{" "}
          <Link href={registerHref} className="font-semibold text-cyan-300 hover:text-cyan-200 hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <LoginForm
        providers={getEnabledOAuthProviders()}
        callbackUrl={callbackUrl}
        initialError={firstParam(params.error) ?? null}
        registered={firstParam(params.registered) === "1"}
      />
    </AuthCard>
  );
}
