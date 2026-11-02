/**
 * SERVER-ONLY: which optional OAuth providers are configured.
 *
 * Providers are enabled purely by environment variables, so the same build can run with or
 * without GitHub / Google sign-in. Server components (e.g. the login page) call
 * {@link getEnabledOAuthProviders} and pass the result to client components as props; the
 * secrets themselves never leave the server.
 */

export type OAuthProviderId = "github" | "google";

export interface OAuthProviderInfo {
  id: OAuthProviderId;
  /** Button label, e.g. "GitHub". */
  name: string;
}

function hasEnv(...names: string[]): boolean {
  return names.every((name) => Boolean(process.env[name]?.trim()));
}

export function isGitHubEnabled(): boolean {
  return hasEnv("GITHUB_ID", "GITHUB_SECRET");
}

export function isGoogleEnabled(): boolean {
  return hasEnv("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET");
}

/** Configured OAuth providers in display order. Email + password is always available. */
export function getEnabledOAuthProviders(): OAuthProviderInfo[] {
  const providers: OAuthProviderInfo[] = [];
  if (isGitHubEnabled()) providers.push({ id: "github", name: "GitHub" });
  if (isGoogleEnabled()) providers.push({ id: "google", name: "Google" });
  return providers;
}
