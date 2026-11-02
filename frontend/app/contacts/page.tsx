import type { Metadata } from "next";

import ContactsView from "@/app/contacts/ContactsView";

export const metadata: Metadata = {
  title: "Contacts",
  description:
    "Your trusted emergency contacts, saved on this device: call or text them, share that you're safe, or send an SOS with your location.",
};

/** `/contacts` — static shell; contacts live in this device's localStorage (client only). */
export default function ContactsPage() {
  return <ContactsView />;
}
