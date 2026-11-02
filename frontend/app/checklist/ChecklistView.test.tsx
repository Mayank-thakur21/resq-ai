import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ChecklistView from "@/app/checklist/ChecklistView";
import {
  CHECKLIST_STORAGE_KEY,
  checklistFileName,
  cleanItems,
  displayDisaster,
  isPdfFontSafe,
  normalizeDisasterInput,
  parseSavedChecklist,
  type PdfWriter,
  writeChecklistPdf,
} from "@/app/checklist/checklist-helpers";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const FLOOD = ["Drinking water (3 days)", "First-aid kit", "Torch and spare batteries"];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.localStorage.clear();
  fetchMock = vi.fn().mockResolvedValue(jsonResponse({ checklist: FLOOD }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ChecklistView", () => {
  it("generates a checklist through the same-origin API proxy (never the backend directly)", async () => {
    const user = userEvent.setup();
    render(<ChecklistView />);
    expect(screen.getByText("Pick a disaster to get started")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Flood" }));

    expect(await screen.findByRole("checkbox", { name: "First-aid kit" })).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/backend/checklist");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ disaster_type: "Flood", language: "en" });
    expect(screen.getByText(/0 of 3 ready/)).toBeInTheDocument();
  });

  it("sends the typed disaster and the chosen language", async () => {
    const user = userEvent.setup();
    render(<ChecklistView />);
    await user.type(screen.getByLabelText("Disaster type"), "  heat   wave ");
    await user.selectOptions(screen.getByLabelText("Language"), "hi");
    await user.click(screen.getByRole("button", { name: "Generate" }));
    await screen.findByRole("checkbox", { name: "First-aid kit" });
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({
      disaster_type: "heat wave",
      language: "hi",
    });
  });

  it("ticks items and persists progress on this device", async () => {
    const user = userEvent.setup();
    render(<ChecklistView />);
    await user.click(screen.getByRole("button", { name: "Flood" }));
    const item = await screen.findByRole("checkbox", { name: "First-aid kit" });
    expect(item).toHaveAttribute("aria-checked", "false");

    await user.click(item);
    expect(item).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/1 of 3 ready/)).toBeInTheDocument();
    await waitFor(() => {
      const saved = JSON.parse(window.localStorage.getItem(CHECKLIST_STORAGE_KEY) ?? "null");
      expect(saved).toMatchObject({ disaster: "Flood", language: "en", items: FLOOD, checked: [1] });
    });

    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(item).toHaveAttribute("aria-checked", "false");
  });

  it("restores the saved checklist without calling the backend", async () => {
    window.localStorage.setItem(
      CHECKLIST_STORAGE_KEY,
      JSON.stringify({ disaster: "Earthquake", language: "en", items: ["Helmet", "Whistle"], checked: [1], savedAt: 1 }),
    );
    render(<ChecklistView />);
    expect(await screen.findByRole("checkbox", { name: "Whistle" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("checkbox", { name: "Helmet" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByLabelText("Disaster type")).toHaveValue("Earthquake");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows an inline error with retry instead of alert()", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const user = userEvent.setup();
    render(<ChecklistView />);

    await user.click(screen.getByRole("button", { name: "Cyclone" }));
    expect(await screen.findByText("Couldn't generate the checklist")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/can't reach resq ai/i);
    expect(alertSpy).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("checkbox", { name: "First-aid kit" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    alertSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("shows an empty state when the backend returns no items", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ checklist: [] }));
    const user = userEvent.setup();
    render(<ChecklistView />);
    await user.click(screen.getByRole("button", { name: "Fire" }));
    expect(await screen.findByText("No checklist items")).toBeInTheDocument();
  });

  it("clears the checklist and its saved progress", async () => {
    const user = userEvent.setup();
    render(<ChecklistView />);
    await user.click(screen.getByRole("button", { name: "Flood" }));
    await screen.findByRole("checkbox", { name: "First-aid kit" });
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByText("Pick a disaster to get started")).toBeInTheDocument();
    expect(window.localStorage.getItem(CHECKLIST_STORAGE_KEY)).toBeNull();
  });
});

describe("checklist helpers", () => {
  it("normalises user input and headings", () => {
    expect(normalizeDisasterInput("  heat \n wave ")).toBe("heat wave");
    expect(normalizeDisasterInput("x".repeat(100))).toHaveLength(64);
    expect(displayDisaster("flood")).toBe("Flood");
    expect(displayDisaster("   ")).toBe("Emergency");
  });

  it("cleans odd backend payloads", () => {
    expect(cleanItems(["Water", " water ", "", 3, null, "Radio"])).toEqual(["Water", "Radio"]);
    expect(cleanItems("nope")).toEqual([]);
  });

  it("parses saved progress defensively", () => {
    expect(parseSavedChecklist(null)).toBeNull();
    expect(parseSavedChecklist("{not json")).toBeNull();
    expect(parseSavedChecklist(JSON.stringify({ disaster: "Flood", items: [] }))).toBeNull();
    expect(
      parseSavedChecklist(JSON.stringify({ disaster: "Flood", items: ["A", "B"], checked: [1, 1, 7, -1, "x"] })),
    ).toEqual({ disaster: "Flood", language: "en", items: ["A", "B"], checked: [1], savedAt: 0 });
  });

  it("builds safe PDF file names and detects scripts the PDF fonts cannot draw", () => {
    expect(checklistFileName("Heat wave!")).toBe("resq-checklist-heat-wave.pdf");
    expect(checklistFileName("बाढ़")).toBe("resq-checklist-emergency.pdf");
    expect(isPdfFontSafe(["Flood", "Café – “water” …"])).toBe(true);
    expect(isPdfFontSafe(["पीने का पानी"])).toBe(false);
  });

  it("writes one checkbox per item and breaks pages", () => {
    const calls: { text: unknown[]; rect: number; addPage: number } = { text: [], rect: 0, addPage: 0 };
    const pdf: PdfWriter = {
      internal: { pageSize: { getWidth: () => 210, getHeight: () => 60 } },
      setFont: () => undefined,
      setFontSize: () => undefined,
      setTextColor: () => undefined,
      setDrawColor: () => undefined,
      text: (text) => void calls.text.push(text),
      rect: () => void (calls.rect += 1),
      line: () => undefined,
      splitTextToSize: (text) => [text],
      addPage: () => void (calls.addPage += 1),
    };
    const pages = writeChecklistPdf(pdf, {
      disaster: "flood",
      items: ["Water", "Food", "Radio", "Torch"],
      checked: new Set([0]),
      generatedAt: new Date("2026-11-02T10:00:00Z"),
    });
    expect(calls.rect).toBe(4);
    expect(pages).toBe(calls.addPage + 1);
    expect(pages).toBeGreaterThan(1);
    expect(calls.text[0]).toBe("Flood emergency checklist");
    expect(String(calls.text[1])).toContain("2026-11-02");
    expect(String(calls.text[1])).toContain("1 of 4 ready");
  });
});
