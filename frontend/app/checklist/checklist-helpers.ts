/**
 * Pure helpers for the `/checklist` page: preset list, input normalisation, saved progress
 * (localStorage) and the PDF export. React-free so they are unit-testable in isolation.
 */

/** Quick-select presets (labels; the backend accepts free text and maps synonyms). */
export const CHECKLIST_PRESETS: readonly string[] = [
  "Flood",
  "Earthquake",
  "Fire",
  "Cyclone",
  "Heatwave",
  "Landslide",
  "Tsunami",
  "Coldwave",
];

/** Backend limit for `ChecklistRequest.disaster_type`. */
export const MAX_DISASTER_LENGTH = 64;

/** localStorage key holding the last generated checklist and which items are ticked. */
export const CHECKLIST_STORAGE_KEY = "resq_checklist";

/** Checklist + progress persisted on this device so it survives reloads and works offline. */
export interface SavedChecklist {
  disaster: string;
  language: string;
  items: string[];
  /** Indexes of ticked items. */
  checked: number[];
  /** Epoch milliseconds of the last change. */
  savedAt: number;
}

/** Collapses whitespace and trims to the backend's length limit. */
export function normalizeDisasterInput(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_DISASTER_LENGTH);
}

/** Capitalises the first letter for headings ("flood" -> "Flood"). */
export function displayDisaster(value: string): string {
  const text = normalizeDisasterInput(value);
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Emergency";
}

/** Keeps only non-empty, de-duplicated strings (defensive against odd backend payloads). */
export function cleanItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const items: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const text = entry.trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    items.push(text);
  }
  return items;
}

/** Parses a stored checklist; returns null for anything malformed. Never throws. */
export function parseSavedChecklist(raw: string | null | undefined): SavedChecklist | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const v = value as Partial<SavedChecklist>;
    const items = cleanItems(v.items);
    if (typeof v.disaster !== "string" || !v.disaster.trim() || items.length === 0) return null;
    const checked = Array.isArray(v.checked)
      ? [...new Set(v.checked.filter((i): i is number => Number.isInteger(i) && i >= 0 && i < items.length))]
      : [];
    return {
      disaster: normalizeDisasterInput(v.disaster),
      language: typeof v.language === "string" && v.language ? v.language : "en",
      items,
      checked: checked.sort((a, b) => a - b),
      savedAt: typeof v.savedAt === "number" && Number.isFinite(v.savedAt) ? v.savedAt : 0,
    };
  } catch {
    return null;
  }
}

/** Reads the saved checklist; storage may be unavailable (private mode, blocked). */
export function loadSavedChecklist(storage: Pick<Storage, "getItem"> | null | undefined): SavedChecklist | null {
  try {
    return parseSavedChecklist(storage?.getItem(CHECKLIST_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** Persists (or clears, with `null`) the checklist. Failures are ignored: progress is a convenience. */
export function storeChecklist(
  storage: Pick<Storage, "setItem" | "removeItem"> | null | undefined,
  value: SavedChecklist | null,
): void {
  try {
    if (!storage) return;
    if (value === null) storage.removeItem(CHECKLIST_STORAGE_KEY);
    else storage.setItem(CHECKLIST_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Quota exceeded / storage disabled: keep working in memory.
  }
}

/** Safe file-name slug ("Heat wave!" -> "heat-wave"). */
export function checklistFileName(disaster: string): string {
  const slug = normalizeDisasterInput(disaster)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `resq-checklist-${slug || "emergency"}.pdf`;
}

/**
 * jsPDF's built-in fonts only cover Latin-1 (WinAnsi). Text outside it (Devanagari, Bengali,
 * Tamil ...) would come out garbled, so the page uses the browser's print dialog instead.
 */
export function isPdfFontSafe(texts: readonly string[]): boolean {
  return texts.every((text) => /^[\u0000-ÿ–—‘’“”•…]*$/.test(text));
}

/** Replaces typographic characters jsPDF's WinAnsi fonts may not map consistently. */
function toPdfText(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/•/g, "-");
}

/** Minimal slice of the jsPDF API used by {@link writeChecklistPdf} (keeps tests light). */
export interface PdfWriter {
  internal: { pageSize: { getWidth(): number; getHeight(): number } };
  setFont(fontName: string, fontStyle?: string): unknown;
  setFontSize(size: number): unknown;
  setTextColor(r: number, g?: number, b?: number): unknown;
  setDrawColor(r: number, g?: number, b?: number): unknown;
  text(text: string | string[], x: number, y: number): unknown;
  rect(x: number, y: number, w: number, h: number, style?: string): unknown;
  line(x1: number, y1: number, x2: number, y2: number): unknown;
  splitTextToSize(text: string, maxWidth: number): string[];
  addPage(): unknown;
}

/**
 * Draws a printable checklist (title, date, one checkbox per item, page breaks) as real text,
 * so it is searchable, small and crisp on paper. Returns the number of pages written.
 */
export function writeChecklistPdf(
  pdf: PdfWriter,
  { disaster, items, checked, generatedAt = new Date() }: {
    disaster: string;
    items: readonly string[];
    checked: ReadonlySet<number>;
    generatedAt?: Date;
  },
): number {
  const margin = 16;
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const textX = margin + 9;
  const textWidth = pageWidth - textX - margin;
  const lineHeight = 6;
  let pages = 1;

  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(20);
  pdf.setTextColor(15, 23, 42);
  pdf.text(toPdfText(`${displayDisaster(disaster)} emergency checklist`), margin, margin + 6);
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(10);
  pdf.setTextColor(100, 116, 139);
  pdf.text(
    `ResQ AI - generated ${generatedAt.toISOString().slice(0, 10)} - ${checked.size} of ${items.length} ready`,
    margin,
    margin + 13,
  );
  pdf.setDrawColor(203, 213, 225);
  pdf.line(margin, margin + 17, pageWidth - margin, margin + 17);

  let y = margin + 27;
  pdf.setFontSize(12);
  items.forEach((item, index) => {
    const lines = pdf.splitTextToSize(toPdfText(item), textWidth);
    const blockHeight = lines.length * lineHeight + 3;
    if (y + blockHeight > pageHeight - margin) {
      pdf.addPage();
      pages += 1;
      y = margin + 6;
    }
    const done = checked.has(index);
    pdf.setDrawColor(100, 116, 139);
    pdf.rect(margin, y - 4, 5, 5, "S");
    if (done) {
      // Tick mark inside the box.
      pdf.setDrawColor(5, 150, 105);
      pdf.line(margin + 1, y - 1.5, margin + 2.2, y - 0.2);
      pdf.line(margin + 2.2, y - 0.2, margin + 4.2, y - 3.2);
    }
    if (done) pdf.setTextColor(100, 116, 139);
    else pdf.setTextColor(15, 23, 42);
    pdf.text(lines, textX, y);
    y += blockHeight;
  });
  return pages;
}
