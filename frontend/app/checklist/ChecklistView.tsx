"use client";

/**
 * `/checklist` — AI-tailored preparedness checklists.
 *
 * Calls `POST /api/checklist` through the same-origin proxy (`lib/api.getChecklist`), so it
 * works behind Docker / a remote host. The backend always answers (built-in lists when Gemini
 * is off), so failures here are transport problems: shown inline with a retry, never `alert()`.
 * The last checklist and its ticked items are kept in localStorage, so progress survives a
 * reload and the list stays readable offline.
 */

import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { Check, Download, ListChecks, Loader2, Printer, RotateCcw, Sparkles } from "lucide-react";
import * as React from "react";

import {
  CHECKLIST_PRESETS,
  type SavedChecklist,
  checklistFileName,
  cleanItems,
  displayDisaster,
  isPdfFontSafe,
  loadSavedChecklist,
  MAX_DISASTER_LENGTH,
  normalizeDisasterInput,
  storeChecklist,
  writeChecklistPdf,
} from "@/app/checklist/checklist-helpers";
import { CHAT_LANGUAGES } from "@/app/chat/chat-helpers";
import { EmptyState } from "@/components/EmptyState";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ErrorState } from "@/components/ErrorState";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { type ApiError, getChecklist, getErrorMessage, isApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

type Status = "idle" | "loading" | "ready" | "error";

interface Request {
  disaster: string;
  language: string;
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function ChecklistSkeleton() {
  return (
    <div role="status" className="space-y-3 rounded-3xl border border-slate-800 bg-slate-950/60 p-6 md:p-8">
      <span className="sr-only">Generating checklist…</span>
      {Array.from({ length: 6 }, (_, index) => (
        <Skeleton key={index} className="h-14 rounded-xl" />
      ))}
    </div>
  );
}

function ChecklistItem({
  index,
  text,
  checked,
  onToggle,
}: {
  index: number;
  text: string;
  checked: boolean;
  onToggle: (index: number) => void;
}) {
  return (
    <motion.li
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: Math.min(index * 0.05, 0.5) }}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        onClick={() => onToggle(index)}
        className={cn(
          "group flex w-full items-center gap-4 rounded-xl border p-4 text-left transition-colors focus-visible:ring-3 focus-visible:ring-emerald-400/50 focus-visible:outline-none",
          checked
            ? "border-emerald-700/60 bg-emerald-950/30"
            : "border-slate-800 bg-slate-900 hover:border-emerald-500/70",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-md border-2 transition-colors",
            checked ? "border-emerald-500 bg-emerald-500" : "border-slate-600 group-hover:border-emerald-400",
          )}
        >
          {checked && <Check className="size-4 text-white" strokeWidth={3} />}
        </span>
        <span
          className={cn(
            "text-base transition-colors md:text-lg",
            checked ? "text-slate-400 line-through" : "text-slate-200",
          )}
        >
          {text}
        </span>
      </button>
    </motion.li>
  );
}

export default function ChecklistView() {
  const [input, setInput] = React.useState("");
  const [language, setLanguage] = React.useState("en");
  const [status, setStatus] = React.useState<Status>("idle");
  const [error, setError] = React.useState<ApiError | Error | null>(null);
  const [current, setCurrent] = React.useState<Request | null>(null);
  const [items, setItems] = React.useState<string[]>([]);
  const [checked, setChecked] = React.useState<ReadonlySet<number>>(() => new Set());
  const [exportNotice, setExportNotice] = React.useState<{ tone: "info" | "destructive"; text: string } | null>(null);
  const [exporting, setExporting] = React.useState(false);
  const abortRef = React.useRef<AbortController | null>(null);
  const restoredRef = React.useRef(false);

  // Restore the last checklist (client only: localStorage is not available during SSR).
  React.useEffect(() => {
    const saved = loadSavedChecklist(safeLocalStorage());
    restoredRef.current = true;
    if (!saved) return;
    setInput(saved.disaster);
    setLanguage(saved.language);
    setCurrent({ disaster: saved.disaster, language: saved.language });
    setItems(saved.items);
    setChecked(new Set(saved.checked));
    setStatus("ready");
  }, []);

  // Persist progress whenever the list or the ticks change.
  React.useEffect(() => {
    if (!restoredRef.current || status !== "ready" || !current || items.length === 0) return;
    const value: SavedChecklist = {
      disaster: current.disaster,
      language: current.language,
      items,
      checked: [...checked].sort((a, b) => a - b),
      savedAt: Date.now(),
    };
    storeChecklist(safeLocalStorage(), value);
  }, [status, current, items, checked]);

  // Abort an in-flight request when the page unmounts.
  React.useEffect(() => () => abortRef.current?.abort(), []);

  const generate = React.useCallback(
    async (rawDisaster: string, lang: string) => {
      const disaster = normalizeDisasterInput(rawDisaster);
      if (!disaster) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setInput(disaster);
      setCurrent({ disaster, language: lang });
      setStatus("loading");
      setError(null);
      setExportNotice(null);
      try {
        const response = await getChecklist(
          { disaster_type: disaster, language: lang },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setItems(cleanItems(response.checklist));
        setChecked(new Set());
        setStatus("ready");
      } catch (err) {
        // A newer request (or unmount) superseded this one: its outcome is irrelevant.
        if (controller.signal.aborted || (isApiError(err) && err.code === "aborted")) return;
        console.warn("[checklist] request failed", err);
        setError(err instanceof Error ? err : new Error(String(err)));
        setStatus("error");
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [],
  );

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void generate(input, language);
  };

  const toggle = React.useCallback((index: number) => {
    setChecked((previous) => {
      const next = new Set(previous);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const resetProgress = () => setChecked(new Set());

  const clearChecklist = () => {
    abortRef.current?.abort();
    setItems([]);
    setChecked(new Set());
    setCurrent(null);
    setStatus("idle");
    setError(null);
    setExportNotice(null);
    storeChecklist(safeLocalStorage(), null);
  };

  const handlePrint = () => window.print();

  const handleDownloadPdf = async () => {
    if (!current || items.length === 0) return;
    setExportNotice(null);
    if (!isPdfFontSafe([current.disaster, ...items])) {
      // The PDF fonts cannot draw this script; the browser's print dialog can ("Save as PDF").
      setExportNotice({
        tone: "info",
        text: "PDF download supports Latin-script text only. Use “Save as PDF” in the print dialog for this language.",
      });
      window.print();
      return;
    }
    setExporting(true);
    try {
      const { jsPDF } = await import("jspdf");
      const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
      writeChecklistPdf(pdf, { disaster: current.disaster, items, checked });
      pdf.save(checklistFileName(current.disaster));
    } catch (err) {
      console.warn("[checklist] PDF export failed", err);
      setExportNotice({
        tone: "destructive",
        text: "The PDF couldn't be created. Try Print instead, and choose “Save as PDF”.",
      });
    } finally {
      setExporting(false);
    }
  };

  const loading = status === "loading";
  const done = checked.size;
  const title = current ? displayDisaster(current.disaster) : "Emergency";

  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-[calc(100dvh-7.5rem)] bg-gradient-to-b from-slate-900 via-slate-800 to-black p-4 text-white md:p-8">
        <div className="mx-auto w-full max-w-4xl space-y-8">
          <header className="space-y-4 text-center print:hidden">
            <div className="mb-2 inline-flex items-center justify-center rounded-full bg-emerald-900/30 p-4">
              <ListChecks aria-hidden="true" className="size-10 text-emerald-400" />
            </div>
            <h1 className="text-4xl font-bold tracking-tight md:text-5xl">Smart Checklists</h1>
            <p className="mx-auto max-w-2xl text-lg text-slate-400">
              Generate AI-tailored emergency kits and preparedness steps. Tick off what you have; your
              progress is saved on this device.
            </p>
          </header>

          {/* Input */}
          <section
            aria-label="Choose a disaster type"
            className="rounded-3xl border border-slate-800 bg-slate-950/70 p-6 shadow-sm backdrop-blur-md print:hidden"
          >
            <form onSubmit={onSubmit} className="mb-6 flex flex-col gap-4 md:flex-row md:items-end">
              <div className="flex-1 space-y-2">
                <Label htmlFor="checklist-disaster" className="text-slate-300">
                  Disaster type
                </Label>
                <Input
                  id="checklist-disaster"
                  value={input}
                  maxLength={MAX_DISASTER_LENGTH}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder="e.g. Flood, Earthquake…"
                  autoComplete="off"
                  className="h-14 rounded-2xl bg-slate-900 text-lg"
                />
              </div>
              <div className="space-y-2 md:w-48">
                <Label htmlFor="checklist-language" className="text-slate-300">
                  Language
                </Label>
                <Select
                  id="checklist-language"
                  value={language}
                  onChange={(event) => setLanguage(event.target.value)}
                  className="[&_select]:h-14 [&_select]:rounded-2xl [&_select]:text-base"
                >
                  {CHAT_LANGUAGES.map((option) => (
                    <option key={option.code} value={option.code}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </div>
              <Button
                type="submit"
                disabled={loading || !normalizeDisasterInput(input)}
                className="h-14 min-w-[160px] rounded-2xl bg-emerald-600 px-8 text-lg text-white hover:bg-emerald-700"
              >
                {loading ? (
                  <>
                    <Loader2 aria-hidden="true" className="size-6 animate-spin" />
                    <span className="sr-only">Generating</span>
                  </>
                ) : (
                  "Generate"
                )}
              </Button>
            </form>

            <div className="flex flex-wrap items-center gap-2">
              <span className="mr-2 py-2 text-sm font-medium text-slate-400">Quick select:</span>
              {CHECKLIST_PRESETS.map((preset) => (
                <Button
                  key={preset}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                  aria-pressed={current?.disaster.toLowerCase() === preset.toLowerCase()}
                  onClick={() => void generate(preset, language)}
                  disabled={loading}
                >
                  {preset}
                </Button>
              ))}
            </div>
          </section>

          {/* Result */}
          <ErrorBoundary title="The checklist couldn't be displayed" resetKeys={[current?.disaster, items]}>
            <div aria-live="polite" aria-busy={loading}>
              {loading && <ChecklistSkeleton />}

              {status === "error" && current && (
                <ErrorState
                  title="Couldn't generate the checklist"
                  message={getErrorMessage(error, "Please check your connection and try again.")}
                  offline={isApiError(error) && error.isNetworkError}
                  details={isApiError(error) && error.requestId ? `Request ID: ${error.requestId}` : null}
                  onRetry={() => void generate(current.disaster, current.language)}
                />
              )}

              {status === "idle" && (
                <EmptyState
                  icon={<Sparkles aria-hidden="true" className="size-6" />}
                  title="Pick a disaster to get started"
                  message="Choose a quick-select option or type any hazard — we'll build a kit and the steps to take."
                />
              )}

              {status === "ready" && items.length === 0 && (
                <EmptyState
                  icon={<ListChecks aria-hidden="true" className="size-6" />}
                  title="No checklist items"
                  message={`We couldn't put together a checklist for “${title}”. Try a more common disaster type.`}
                />
              )}

              <AnimatePresence>
                {status === "ready" && items.length > 0 && (
                  <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
                    <div className="flex flex-col gap-3 rounded-2xl border border-slate-800 bg-slate-950/70 p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between print:hidden">
                      <p className="text-sm font-medium text-slate-400">
                        <span className="text-slate-200">{title}</span> · {done} of {items.length} ready
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button variant="outline" onClick={resetProgress} disabled={done === 0} className="gap-2">
                          <RotateCcw aria-hidden="true" className="size-4" /> Reset
                        </Button>
                        <Button variant="outline" onClick={handlePrint} className="gap-2">
                          <Printer aria-hidden="true" className="size-4" /> Print
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => void handleDownloadPdf()}
                          disabled={exporting}
                          className="gap-2 border-emerald-900 hover:bg-emerald-900/30"
                        >
                          {exporting ? (
                            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                          ) : (
                            <Download aria-hidden="true" className="size-4 text-emerald-500" />
                          )}
                          PDF
                        </Button>
                        <Button variant="ghost" onClick={clearChecklist} className="text-slate-400">
                          Clear
                        </Button>
                      </div>
                    </div>

                    {exportNotice && (
                      <Alert variant={exportNotice.tone} className="print:hidden">
                        <AlertDescription>{exportNotice.text}</AlertDescription>
                      </Alert>
                    )}

                    <div className="rounded-3xl border border-slate-800 bg-slate-950/70 p-6 shadow-sm md:p-8 print:border-0 print:bg-white print:p-0 print:text-black">
                      <h2 className="mb-6 hidden text-2xl font-bold print:block">{title} emergency checklist</h2>
                      <ul aria-label={`${title} checklist`} className="space-y-3">
                        {items.map((item, index) => (
                          <ChecklistItem
                            key={`${index}-${item}`}
                            index={index}
                            text={item}
                            checked={checked.has(index)}
                            onToggle={toggle}
                          />
                        ))}
                      </ul>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </ErrorBoundary>
        </div>
      </div>
    </MotionConfig>
  );
}
