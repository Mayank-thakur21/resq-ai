import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONTACTS_STORAGE_KEY,
  loadContacts,
  MAX_CUSTOM_CONTACTS,
  parseStoredContacts,
  resetContactsMemoryForTests,
  saveContacts,
  serializeContacts,
  toSosRecipients,
  useContacts,
  validateContactInput,
} from "@/lib/contacts";

beforeEach(() => {
  window.localStorage.clear();
  resetContactsMemoryForTests();
});

afterEach(() => {
  resetContactsMemoryForTests();
});

describe("parseStoredContacts", () => {
  it("reads the v1 format written by the old contacts page", () => {
    const raw = JSON.stringify([
      { name: "Mom", phone: "+91 98765 43210", custom: true },
      { name: "Dad", phone: "98765 01234", custom: true },
    ]);
    expect(parseStoredContacts(raw)).toEqual([
      { name: "Mom", phone: "+91 98765 43210", custom: true },
      { name: "Dad", phone: "98765 01234", custom: true },
    ]);
  });

  it("tolerates malformed data without throwing", () => {
    expect(parseStoredContacts("{not json")).toEqual([]);
    expect(parseStoredContacts(JSON.stringify({ name: "x" }))).toEqual([]);
    expect(parseStoredContacts(null)).toEqual([]);
    expect(
      parseStoredContacts(
        JSON.stringify([null, 42, { name: "", phone: "123" }, { name: "No digits", phone: "abc" }, { name: "Ok", phone: "123" }]),
      ),
    ).toEqual([{ name: "Ok", phone: "123", custom: true }]);
  });

  it("keeps legacy free-text numbers (so they are not deleted on the next save) and drops duplicates", () => {
    const raw = JSON.stringify([
      { name: "Aunt", phone: "call 98765 home" },
      { name: "Aunt", phone: "call 98765 home" },
    ]);
    expect(parseStoredContacts(raw)).toEqual([{ name: "Aunt", phone: "call 98765 home", custom: true }]);
  });
});

describe("validateContactInput", () => {
  it("normalises E.164 numbers before storing", () => {
    const result = validateContactInput({ name: "  Asha  ", phone: "+91 98765-43210" }, []);
    expect(result).toEqual({ ok: true, contact: { name: "Asha", phone: "+919876543210", custom: true } });
  });

  it("reports field errors", () => {
    const result = validateContactInput({ name: " ", phone: "ab" }, []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.name).toBe("Enter a name.");
      expect(result.errors.phone).toMatch(/digits only/);
    }
  });

  it("rejects a number that is already saved (in any format)", () => {
    const existing = [{ name: "Mom", phone: "+919876543210", custom: true }];
    const result = validateContactInput({ name: "Mother", phone: "0091 98765 43210" }, existing);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.phone).toContain("Mom");
  });

  it("enforces the contact limit", () => {
    const existing = Array.from({ length: MAX_CUSTOM_CONTACTS }, (_, i) => ({
      name: `C${i}`,
      phone: `+9198765${String(i).padStart(5, "0")}`,
      custom: true,
    }));
    const result = validateContactInput({ name: "One more", phone: "+14155552671" }, existing);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.form).toMatch(/up to/);
  });
});

describe("storage", () => {
  it("round-trips only the user's own contacts", () => {
    saveContacts([
      { name: "112", phone: "112" },
      { name: "Mom", phone: "+919876543210", custom: true },
    ]);
    expect(JSON.parse(window.localStorage.getItem(CONTACTS_STORAGE_KEY) ?? "[]")).toEqual([
      { name: "Mom", phone: "+919876543210", custom: true },
    ]);
    expect(loadContacts()).toEqual([{ name: "Mom", phone: "+919876543210", custom: true }]);
    expect(serializeContacts([])).toBe("[]");
  });

  it("keeps working in memory when localStorage throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    expect(saveContacts([{ name: "Mom", phone: "+919876543210", custom: true }])).toBe(false);
    expect(loadContacts()).toEqual([{ name: "Mom", phone: "+919876543210", custom: true }]);
  });
});

describe("toSosRecipients", () => {
  it("annotates the E.164 form and skips built-in services", () => {
    expect(
      toSosRecipients([
        { name: "Ambulance", phone: "108" },
        { name: "Mom", phone: "+91 98765 43210", custom: true },
        { name: "Dad", phone: "98765 01234", custom: true },
      ]),
    ).toEqual([
      { contact: { name: "Mom", phone: "+91 98765 43210", custom: true }, e164: "+919876543210" },
      { contact: { name: "Dad", phone: "98765 01234", custom: true }, e164: null },
    ]);
  });
});

describe("useContacts", () => {
  it("loads after mount, adds, removes and restores — and syncs other hook instances", () => {
    window.localStorage.setItem(CONTACTS_STORAGE_KEY, JSON.stringify([{ name: "Mom", phone: "+919876543210" }]));
    const first = renderHook(() => useContacts());
    const second = renderHook(() => useContacts());

    expect(first.result.current.ready).toBe(true);
    expect(first.result.current.contacts.map((c) => c.name)).toEqual(["Mom"]);

    let outcome: ReturnType<typeof first.result.current.add> | undefined;
    act(() => {
      outcome = first.result.current.add({ name: "Dad", phone: "+1 415 555 2671" });
    });
    expect(outcome?.ok).toBe(true);
    expect(second.result.current.contacts.map((c) => c.name)).toEqual(["Mom", "Dad"]);

    const mom = first.result.current.contacts[0];
    act(() => first.result.current.remove(mom));
    expect(second.result.current.contacts.map((c) => c.name)).toEqual(["Dad"]);

    act(() => first.result.current.restore(mom, 0));
    expect(first.result.current.contacts.map((c) => c.name)).toEqual(["Mom", "Dad"]);
    expect(first.result.current.persistent).toBe(true);
  });

  it("picks up changes made in another tab (storage event)", () => {
    const { result } = renderHook(() => useContacts());
    expect(result.current.contacts).toEqual([]);
    act(() => {
      window.localStorage.setItem(CONTACTS_STORAGE_KEY, JSON.stringify([{ name: "Neighbour", phone: "+447700900123" }]));
      window.dispatchEvent(new StorageEvent("storage", { key: CONTACTS_STORAGE_KEY }));
    });
    expect(result.current.contacts.map((c) => c.name)).toEqual(["Neighbour"]);
  });
});
