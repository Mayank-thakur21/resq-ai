import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  session: null as null | { user: { id: string } },
  status: "unauthenticated" as "authenticated" | "unauthenticated" | "loading",
}));
vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: auth.session, status: auth.status }),
  signOut: vi.fn(),
}));
const signOutModule = vi.hoisted(() => ({ forgetUserData: vi.fn(async () => {}) }));
vi.mock("@/lib/sign-out", () => signOutModule);

import { DATA_OWNER_STORAGE_KEY, SessionDataGuard } from "@/components/SessionDataGuard";
import { identityTag } from "@/lib/identity";

function signedInAs(id: string | null, status: typeof auth.status = id ? "authenticated" : "unauthenticated") {
  auth.session = id ? { user: { id } } : null;
  auth.status = status;
  cleanup();
  render(<SessionDataGuard />);
}

beforeEach(() => {
  window.localStorage.clear();
  signOutModule.forgetUserData.mockClear();
});

afterEach(() => cleanup());

describe("SessionDataGuard", () => {
  it("forgets the previous account's data when another account signs in", async () => {
    // Regression: an expired session followed by someone else's sign-in kept the first
    // user's cached incidents (upvoted_by_me) and last location on the device.
    signedInAs("alice");
    expect(window.localStorage.getItem(DATA_OWNER_STORAGE_KEY)).toBe(identityTag("alice"));
    expect(signOutModule.forgetUserData).not.toHaveBeenCalled();

    signedInAs(null); // session expired (or offline): nothing is cleared
    expect(signOutModule.forgetUserData).not.toHaveBeenCalled();

    signedInAs("bob");
    await waitFor(() => expect(signOutModule.forgetUserData).toHaveBeenCalledTimes(1));
    expect(window.localStorage.getItem(DATA_OWNER_STORAGE_KEY)).toBe(identityTag("bob"));
  });

  it("keeps the data of the same account, and waits for the session", () => {
    signedInAs("alice");
    signedInAs(null, "loading");
    signedInAs("alice");
    expect(signOutModule.forgetUserData).not.toHaveBeenCalled();
  });

  it("tags identities without storing the account id", () => {
    expect(identityTag("google:1234567890")).toMatch(/^u[0-9a-f]{8}$/);
    expect(identityTag("google:1234567890")).not.toContain("1234567890");
    expect(identityTag("alice")).not.toBe(identityTag("bob"));
    expect(identityTag(null)).toBe("");
  });
});
