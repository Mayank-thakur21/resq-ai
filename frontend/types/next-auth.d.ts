/**
 * NextAuth type augmentation.
 *
 * `session.user.id` is always set for signed-in users (see the `session` callback in
 * `lib/auth.ts`); `token.uid` is the stable user id stored in the JWT.
 */
import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      /** Backend user UUID, or `github:<id>` / `google:<id>` for OAuth users. */
      id: string;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    /** Stable user id, see `Session.user.id`. */
    uid?: string;
  }
}
