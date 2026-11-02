import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";

import { AuthCard } from "@/app/login/_components/AuthCard";
import { sanitizeCallbackUrl } from "@/app/login/callback-url";
import { RegisterForm } from "@/app/register/RegisterForm";
import { authOptions } from "@/lib/auth";
import { getEnabledOAuthProviders } from "@/lib/auth-providers";

export const metadata: Metadata = {
  title: "Create account",
  description: "Create a free ResQ AI account to report incidents and receive nearby alerts.",
};

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function RegisterPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const callbackUrl = sanitizeCallbackUrl(params.callbackUrl);

  const session = await getServerSession(authOptions).catch(() => null);
  if (session?.user) redirect(callbackUrl);

  const loginHref =
    callbackUrl === "/" ? "/login" : `/login?callbackUrl=${encodeURIComponent(callbackUrl)}`;

  return (
    <AuthCard
      title="Create your account"
      subtitle="Free and takes a minute. Report incidents, upvote nearby reports and get push alerts."
      footer={
        <>
          Already have an account?{" "}
          <Link href={loginHref} className="font-semibold text-cyan-300 hover:text-cyan-200 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <RegisterForm providers={getEnabledOAuthProviders()} callbackUrl={callbackUrl} loginHref={loginHref} />
    </AuthCard>
  );
}
