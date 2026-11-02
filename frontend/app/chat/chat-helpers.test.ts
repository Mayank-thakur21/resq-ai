import { describe, expect, it } from "vitest";

import {
  buildChatRequest,
  describeSpeechError,
  extractPlaces,
  findLanguage,
  MAX_CHAT_MESSAGE_LENGTH,
  MAX_STORED_MESSAGES,
  normalizeUrgency,
  parseChatHistory,
  parseEmergencyNumber,
  serializeChatHistory,
  toAssistantMeta,
  toSpeechText,
} from "@/app/chat/chat-helpers";
import type { ChatResponse } from "@/lib/types";

describe("buildChatRequest", () => {
  it("trims the message and only attaches a shared location", () => {
    expect(buildChatRequest("  flood here  ", "hi", null)).toEqual({ message: "flood here", language: "hi" });
    expect(buildChatRequest("help", "en", { lat: 1.5, lon: 2.5 })).toEqual({
      message: "help",
      language: "en",
      location: { lat: 1.5, lon: 2.5 },
    });
    expect(buildChatRequest("x".repeat(3000), "", null).message).toHaveLength(MAX_CHAT_MESSAGE_LENGTH);
    expect(buildChatRequest("x", "", null).language).toBe("en");
  });
});

describe("toAssistantMeta", () => {
  const response: ChatResponse = {
    response: "Move to higher ground.",
    agent_used: "safety_agent",
    // Not a valid RiskLevel: the helper must still cope with unexpected values.
    urgency_level: "critical" as unknown as ChatResponse["urgency_level"],
    detected_disaster: "unknown",
    advisory: "  ",
    recommended_actions: ["Move up", "", 3 as unknown as string],
    emergency_numbers: ["112 (International Emergency)"],
    steps_taken: ["Router Agent classified the request"],
    data: {
      hospitals: [
        { id: "h1", name: "City Hospital", type: "hospital", lat: 28.6, lon: 77.2, distance_km: 1.2, address: "MG Road", phone: "+911123456789" },
        { name: "No coords" },
        { lat: 95, lon: 0 },
      ],
      shelters: "not a list",
    } as unknown as ChatResponse["data"],
  };

  it("normalises the backend response defensively", () => {
    const meta = toAssistantMeta(response);
    expect(meta.urgency).toBe("high");
    expect(meta.disaster).toBeNull();
    expect(meta.advisory).toBeNull();
    expect(meta.actions).toEqual(["Move up"]);
    expect(meta.emergencyNumbers).toEqual(["112 (International Emergency)"]);
    expect(meta.hospitals).toEqual([
      {
        id: "h1",
        name: "City Hospital",
        type: "hospital",
        lat: 28.6,
        lon: 77.2,
        distance_km: 1.2,
        address: "MG Road",
        phone: "+911123456789",
      },
    ]);
    expect(meta.shelters).toEqual([]);
  });

  it("tolerates a null data field and a null detected_disaster", () => {
    const meta = toAssistantMeta({
      ...response,
      data: null as unknown as ChatResponse["data"],
      detected_disaster: null,
    });
    expect(meta.hospitals).toEqual([]);
    expect(meta.disaster).toBeNull();
  });
});

describe("small helpers", () => {
  it("maps urgency levels", () => {
    expect(normalizeUrgency("HIGH")).toBe("high");
    expect(normalizeUrgency("moderate")).toBe("medium");
    expect(normalizeUrgency(undefined)).toBe("low");
  });

  it("extracts places with fallbacks for missing fields", () => {
    expect(extractPlaces([{ lat: 1, lon: 2 }], "shelter")).toEqual([
      { id: "shelter-1,2", name: "Unnamed place", type: "shelter", lat: 1, lon: 2, distance_km: Number.NaN, address: null, phone: null },
    ]);
    expect(extractPlaces(Array.from({ length: 9 }, (_, i) => ({ lat: i, lon: i })), "hospital")).toHaveLength(5);
  });

  it("parses emergency number labels", () => {
    expect(parseEmergencyNumber("112 (International Emergency)")).toEqual({ number: "112", label: "International Emergency" });
    expect(parseEmergencyNumber("911")).toEqual({ number: "911", label: "" });
    expect(parseEmergencyNumber("Call your local police")).toEqual({ number: "", label: "Call your local police" });
  });

  it("turns markdown into speakable text", () => {
    expect(toSpeechText("## Stay safe\n- **Move** to [higher ground](https://x.org)\n- Call 112")).toBe(
      "Stay safe Move to higher ground Call 112",
    );
  });

  it("explains speech recognition errors", () => {
    expect(describeSpeechError("not-allowed")).toMatch(/microphone access is blocked/i);
    expect(describeSpeechError("aborted")).toBe("");
    expect(describeSpeechError("weird")).toMatch(/stopped unexpectedly/);
  });

  it("falls back to English for unknown languages", () => {
    expect(findLanguage("hi").speech).toBe("hi-IN");
    expect(findLanguage("xx").code).toBe("en");
  });
});

describe("chat history", () => {
  it("round-trips valid messages and drops junk", () => {
    const messages = [
      { id: "1", role: "user" as const, content: "hi", createdAt: 1 },
      { id: "2", role: "error" as const, content: "failed", createdAt: 2, retryOf: "1", network: true },
    ];
    expect(parseChatHistory(serializeChatHistory(messages))).toEqual(messages);
    expect(parseChatHistory(JSON.stringify([{ id: 1 }, { id: "x", role: "system", content: "", createdAt: 0 }]))).toEqual([]);
    expect(parseChatHistory("{oops")).toEqual([]);
  });

  it("keeps only the most recent messages", () => {
    const many = Array.from({ length: MAX_STORED_MESSAGES + 10 }, (_, i) => ({
      id: String(i),
      role: "user" as const,
      content: `m${i}`,
      createdAt: i,
    }));
    const restored = parseChatHistory(serializeChatHistory(many));
    expect(restored).toHaveLength(MAX_STORED_MESSAGES);
    expect(restored[0].id).toBe("10");
  });
});
