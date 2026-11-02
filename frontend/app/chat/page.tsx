import type { Metadata } from "next";

import ChatView from "@/app/chat/ChatView";

export const metadata: Metadata = {
  title: "Emergency AI Chat",
  description:
    "Ask ResQ AI's multi-agent assistant for safety steps, local weather advisories and the nearest hospitals and shelters — by text or voice.",
};

/** `/chat` — static shell around the interactive multi-agent chat. */
export default function ChatPage() {
  return <ChatView />;
}
