import type { Metadata } from "next";

import ChecklistView from "@/app/checklist/ChecklistView";

export const metadata: Metadata = {
  title: "Checklists",
  description:
    "Generate an emergency kit and preparedness checklist for floods, earthquakes, cyclones, heatwaves and more — tick items off, print or save as PDF.",
};

/** `/checklist` — static shell; the interactive checklist is a client component. */
export default function ChecklistPage() {
  return <ChecklistView />;
}
