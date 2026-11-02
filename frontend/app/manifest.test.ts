// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import manifest from "@/app/manifest";

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width/height from a PNG's IHDR chunk (throws when the file is not a PNG). */
function pngSize(publicPath: string): { width: number; height: number } {
  const bytes = readFileSync(`${PUBLIC_DIR}${publicPath.replace(/^\//, "")}`);
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error(`${publicPath} is not a PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("web app manifest", () => {
  const data = manifest();

  it("describes an installable standalone app with the brand colours", () => {
    expect(data).toMatchObject({
      name: expect.stringContaining("ResQ AI"),
      short_name: "ResQ AI",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#0f172a",
      theme_color: "#dc2626",
    });
    expect(data.categories?.length).toBeGreaterThan(0);
  });

  it("has 192/512 'any' icons and a 512 maskable icon that exist with the declared sizes", () => {
    const icons = data.icons ?? [];
    expect(icons.map((icon) => `${icon.sizes} ${icon.purpose}`)).toEqual(
      expect.arrayContaining(["192x192 any", "512x512 any", "512x512 maskable"]),
    );
    for (const icon of icons) {
      const [width, height] = String(icon.sizes).split("x").map(Number);
      expect(pngSize(icon.src), icon.src).toEqual({ width, height });
      expect(icon.type).toBe("image/png");
    }
  });

  it("offers SOS, Map, Chat and Alerts shortcuts with real icons", () => {
    const shortcuts = data.shortcuts ?? [];
    expect(shortcuts.map((shortcut) => shortcut.url)).toEqual(["/sos", "/map", "/chat", "/alerts"]);
    for (const shortcut of shortcuts) {
      const icon = shortcut.icons?.[0];
      expect(icon, shortcut.name).toBeDefined();
      expect(pngSize(icon!.src)).toEqual({ width: 96, height: 96 });
    }
  });

  it("ships the icons referenced by the root layout and the service worker", () => {
    expect(pngSize("/icons/apple-touch-icon.png")).toEqual({ width: 180, height: 180 });
    expect(pngSize("/icons/badge-72.png")).toEqual({ width: 72, height: 72 });
    expect(existsSync(`${PUBLIC_DIR}icons/icon.svg`)).toBe(true);
    // The legacy static manifest was replaced by app/manifest.ts.
    expect(existsSync(`${PUBLIC_DIR}manifest.json`)).toBe(false);

    const sw = readFileSync(`${PUBLIC_DIR}sw.js`, "utf8");
    const precached = [...sw.matchAll(/"(\/icons\/[^"]+)"/g)].map((match) => match[1]);
    expect(precached.length).toBeGreaterThanOrEqual(5);
    for (const path of precached) expect(existsSync(`${PUBLIC_DIR}${path.slice(1)}`), path).toBe(true);
  });
});
