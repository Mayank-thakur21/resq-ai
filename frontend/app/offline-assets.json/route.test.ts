// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const fs = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock("node:fs/promises", () => ({ readFile: fs.readFile, default: { readFile: fs.readFile } }));

import { GET } from "./route";

beforeEach(() => {
  fs.readFile.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("GET /offline-assets.json", () => {
  it("lists the lazily loaded chunks of /map from the build manifest", async () => {
    fs.readFile.mockResolvedValueOnce(
      JSON.stringify({
        "app/map/MapView.tsx -> @/components/map/ReliefMap": {
          files: ["static/css/a.css", "static/chunks/leaflet.js", "../../etc/passwd", 42],
        },
        "app/checklist/ChecklistView.tsx -> jspdf": { files: ["static/chunks/jspdf.js"] },
      }),
    );
    const body = await (await GET()).json();
    expect(body).toEqual({ pages: { "/map": ["/_next/static/chunks/leaflet.js", "/_next/static/css/a.css"] } });
  });

  it("degrades to empty lists when the manifest is unavailable", async () => {
    fs.readFile.mockRejectedValueOnce(new Error("ENOENT"));
    expect(await (await GET()).json()).toEqual({ pages: { "/map": [] } });
  });
});
