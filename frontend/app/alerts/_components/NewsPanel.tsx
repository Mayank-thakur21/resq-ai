"use client";

import { Search, X } from "lucide-react";
import * as React from "react";

import { DisasterFeed } from "@/components/DisasterFeed";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Label } from "@/components/ui/label";

/** Backend limit for the `query` parameter of `/api/alerts/news`. */
const MAX_QUERY_LENGTH = 200;
const SEARCH_DEBOUNCE_MS = 400;
const NEWS_LIMIT = 30;

/**
 * "News" tab of `/alerts`: humanitarian news (ReliefWeb, or GDACS-derived) with a debounced
 * search box. Pressing Enter searches immediately.
 */
export function NewsPanel() {
  const inputId = React.useId();
  const [input, setInput] = React.useState("");
  const [query, setQuery] = React.useState("");

  React.useEffect(() => {
    const timer = window.setTimeout(() => setQuery(input.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [input]);

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setQuery(input.trim());
  };

  const clear = () => {
    setInput("");
    setQuery("");
  };

  return (
    <div className="space-y-4">
      <form
        role="search"
        onSubmit={submit}
        className="rounded-2xl border border-slate-700 bg-slate-800/40 p-4 backdrop-blur-md"
      >
        <Label htmlFor={inputId} className="mb-2">
          Search disaster news
        </Label>
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400"
          />
          <input
            id={inputId}
            type="search"
            value={input}
            maxLength={MAX_QUERY_LENGTH}
            onChange={(event) => setInput(event.target.value)}
            placeholder="e.g. flood, cyclone, India, earthquake Japan"
            autoComplete="off"
            enterKeyHint="search"
            className="h-10 w-full rounded-lg border border-slate-700 bg-slate-900/60 pr-10 pl-9 text-sm text-slate-100 placeholder:text-slate-500 transition-colors outline-none focus-visible:border-blue-400 focus-visible:ring-3 focus-visible:ring-blue-500/40 [&::-webkit-search-cancel-button]:hidden"
          />
          {input && (
            <button
              type="button"
              onClick={clear}
              aria-label="Clear search"
              className="absolute top-1/2 right-2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-700/60 hover:text-white focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:outline-none"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          )}
        </div>
      </form>

      <ErrorBoundary title="News is unavailable" resetKeys={[query]}>
        <DisasterFeed variant="list" limit={NEWS_LIMIT} query={query} />
      </ErrorBoundary>
    </div>
  );
}

export default NewsPanel;
