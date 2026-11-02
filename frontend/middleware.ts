/**
 * Route protection (Edge middleware).
 *
 * Signed-out visitors of protected pages are redirected to
 * `/login?callbackUrl=<original path + query>`; after signing in they come straight back.
 * Authorization here is "has a valid NextAuth session JWT"; the backend still enforces
 * ownership rules on every API call.
 */
import { withAuth } from "next-auth/middleware";

export default withAuth({
  pages: { signIn: "/login" },
});

export const config = {
  matcher: ["/profile", "/profile/:path*", "/incidents/new"],
};
