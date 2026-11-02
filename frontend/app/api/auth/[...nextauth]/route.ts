/**
 * NextAuth (v4) endpoints: /api/auth/signin, /callback/*, /session, /csrf, /signout, ...
 * Configuration lives in `lib/auth.ts`.
 */
import NextAuth from "next-auth";

import { authOptions } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };
