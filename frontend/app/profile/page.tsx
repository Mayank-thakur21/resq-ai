import { UserRound } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";

import ProfileView from "@/app/profile/ProfileView";
import { authOptions } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Profile",
  description: "Your ResQ AI account, alert notifications and SOS history.",
  robots: { index: false },
};

// Reads the session on every request (also keeps the page out of shared caches).
export const dynamic = "force-dynamic";

/**
 * `/profile` (protected by `middleware.ts`; the session check here is a second line of
 * defence, e.g. if the matcher changes).
 */
export default async function ProfilePage() {
  const session = await getServerSession(authOptions).catch((error: unknown) => {
    console.error("[profile] could not read the session", error);
    return null;
  });
  if (!session?.user?.id) redirect("/login?callbackUrl=%2Fprofile");

  const user = {
    id: session.user.id,
    name: session.user.name ?? null,
    email: session.user.email ?? null,
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-slate-800 to-black pb-12 text-white">
      <div className="container mx-auto max-w-5xl px-4 pt-8 lg:pt-12">
        <header className="mb-8 flex items-center gap-3">
          <span
            aria-hidden="true"
            className="inline-flex size-11 items-center justify-center rounded-xl border border-cyan-500/30 bg-cyan-600/20 text-cyan-300"
          >
            <UserRound className="size-6" />
          </span>
          <h1 className="bg-gradient-to-r from-blue-300 via-cyan-200 to-emerald-200 bg-clip-text text-3xl font-extrabold tracking-tight text-transparent md:text-4xl">
            Your profile
          </h1>
        </header>
        <ProfileView user={user} />
      </div>
    </div>
  );
}
