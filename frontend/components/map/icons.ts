/**
 * Local Leaflet marker icons (`L.divIcon` with inline SVG/HTML).
 *
 * Replaces the v1 icons hot-linked from GitHub raw / cdnjs: nothing is fetched from third
 * parties, icons work offline (PWA) and colours match the layer panel.
 *
 * Client-only: importing Leaflet touches `window`. Only import from components that are
 * loaded with `next/dynamic(..., { ssr: false })`.
 */

import L from "leaflet";

import { ALERT_LEVEL_COLORS, disasterGlyph } from "@/components/map/layers";
import type { AlertLevel } from "@/lib/types";

/** Escapes text for interpolation into icon HTML (glyphs are constants, but be safe). */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** Only `#rgb` / `#rrggbb` colours are interpolated into styles. */
function safeColor(value: string): string {
  return /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(value) ? value : "#64748b";
}

// Leaflet adds `leaflet-div-icon` (white box) unless a className is given.
const ICON_CLASS = "resq-marker";
const SHADOW = "filter:drop-shadow(0 2px 3px rgba(15,23,42,.55));";

const cache = new Map<string, L.DivIcon>();

function cached(key: string, build: () => L.DivIcon): L.DivIcon {
  let icon = cache.get(key);
  if (!icon) {
    icon = build();
    cache.set(key, icon);
  }
  return icon;
}

/** Teardrop pin with a glyph (places, picked locations). */
export function pinIcon(color: string, glyph: string, { large = false } = {}): L.DivIcon {
  const fill = safeColor(color);
  return cached(`pin|${fill}|${glyph}|${large}`, () => {
    const scale = large ? 1.25 : 1;
    const width = Math.round(32 * scale);
    const height = Math.round(42 * scale);
    const html =
      `<div style="position:relative;width:${width}px;height:${height}px;${SHADOW}">` +
      `<svg width="${width}" height="${height}" viewBox="0 0 32 42" aria-hidden="true" focusable="false">` +
      `<path d="M16 1C7.72 1 1 7.6 1 15.74 1 26.5 14.3 39.9 15.2 40.7a1.15 1.15 0 0 0 1.6 0C17.7 39.9 31 26.5 31 15.74 31 7.6 24.28 1 16 1Z" fill="${fill}" stroke="#fff" stroke-width="2"/>` +
      `<circle cx="16" cy="15.5" r="10" fill="#fff" fill-opacity="0.94"/>` +
      `</svg>` +
      `<span aria-hidden="true" style="position:absolute;left:0;top:${Math.round(5.5 * scale)}px;width:${width}px;height:${Math.round(20 * scale)}px;display:flex;align-items:center;justify-content:center;font-size:${Math.round(13 * scale)}px;line-height:1">${escapeHtml(glyph)}</span>` +
      `</div>`;
    return L.divIcon({
      className: ICON_CLASS,
      html,
      iconSize: [width, height],
      iconAnchor: [width / 2, height],
      popupAnchor: [0, -height + 6],
      tooltipAnchor: [width / 2, -height / 2],
    });
  });
}

/** Rounded-square badge for community incidents (severity colour, type glyph). */
export function incidentIcon(
  color: string,
  glyph: string,
  { verified = false, highlighted = false } = {},
): L.DivIcon {
  const fill = safeColor(color);
  return cached(`incident|${fill}|${glyph}|${verified}|${highlighted}`, () => {
    const size = highlighted ? 38 : 30;
    const ring = highlighted ? "box-shadow:0 0 0 4px rgba(250,204,21,.85);" : "";
    const tick = verified
      ? `<span aria-hidden="true" style="position:absolute;right:-6px;top:-6px;width:16px;height:16px;border-radius:9999px;background:#2563eb;border:2px solid #fff;color:#fff;font-size:9px;font-weight:700;line-height:12px;text-align:center">✓</span>`
      : "";
    const html =
      `<div style="position:relative;width:${size}px;height:${size}px;${SHADOW}">` +
      `<div style="width:100%;height:100%;border-radius:10px;background:${fill};border:2px solid #fff;display:flex;align-items:center;justify-content:center;font-size:${highlighted ? 18 : 15}px;line-height:1;${ring}">${escapeHtml(glyph)}</div>` +
      tick +
      `</div>`;
    return L.divIcon({
      className: ICON_CLASS,
      html,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      popupAnchor: [0, -size / 2],
    });
  });
}

/** Round GDACS marker coloured by alert level; orange/red events pulse (unless reduced motion). */
export function disasterIcon(level: AlertLevel, eventType: string): L.DivIcon {
  const fill = ALERT_LEVEL_COLORS[level] ?? ALERT_LEVEL_COLORS.green;
  const glyph = disasterGlyph(eventType);
  return cached(`disaster|${level}|${glyph}`, () => {
    const size = 34;
    const pulse =
      level === "green"
        ? ""
        : `<span class="animate-ping motion-reduce:animate-none" style="position:absolute;inset:0;border-radius:9999px;background:${fill};opacity:.45"></span>`;
    const html =
      `<div style="position:relative;width:${size}px;height:${size}px">` +
      pulse +
      `<span style="position:absolute;inset:0;border-radius:9999px;background:${fill};border:2px solid #fff;display:flex;align-items:center;justify-content:center;font-size:16px;line-height:1;${SHADOW}">${escapeHtml(glyph)}</span>` +
      `</div>`;
    return L.divIcon({
      className: ICON_CLASS,
      html,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      popupAnchor: [0, -size / 2],
    });
  });
}

/** Pulsing blue dot for the device location. */
export function userLocationIcon(): L.DivIcon {
  return cached("user", () =>
    L.divIcon({
      className: ICON_CLASS,
      html:
        `<div style="position:relative;width:22px;height:22px">` +
        `<span class="animate-ping motion-reduce:animate-none" style="position:absolute;inset:0;border-radius:9999px;background:#3b82f6;opacity:.5"></span>` +
        `<span style="position:absolute;inset:2px;border-radius:9999px;background:#2563eb;border:3px solid #fff;box-shadow:0 0 0 1px rgba(15,23,42,.35)"></span>` +
        `</div>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
      popupAnchor: [0, -11],
    }),
  );
}

/** Crosshair for a search centre that is not the device location. */
export function searchCenterIcon(): L.DivIcon {
  return cached("search-center", () =>
    L.divIcon({
      className: ICON_CLASS,
      html:
        `<div style="width:24px;height:24px;border-radius:9999px;border:3px solid #0f172a;background:rgba(255,255,255,.9);display:flex;align-items:center;justify-content:center;${SHADOW}">` +
        `<span style="width:6px;height:6px;border-radius:9999px;background:#0f172a"></span>` +
        `</div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
      popupAnchor: [0, -12],
    }),
  );
}
