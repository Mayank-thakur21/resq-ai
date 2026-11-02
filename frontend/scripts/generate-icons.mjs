/**
 * Generates the ResQ AI PWA icons from SVG artwork with sharp (librsvg).
 *
 * Usage (from frontend/):
 *   npm run icons                          # writes into ./public/icons and ./app/favicon.ico
 *   node scripts/generate-icons.mjs <dir>  # writes into <dir>/public/icons (+ <dir>/app/favicon.ico)
 *
 * sharp is not a direct dependency: it is installed with Next.js (image optimisation), so it is
 * resolved from this project's node_modules.
 *
 * Writes into <dir>/public/icons/:
 *   icon.svg              source artwork (red shield with a white cross on dark slate)
 *   icon-192.png          purpose "any"
 *   icon-512.png          purpose "any"
 *   maskable-512.png      purpose "maskable" (full bleed, artwork inside the 80% safe zone)
 *   apple-touch-icon.png  180x180, full bleed (iOS applies its own rounded mask)
 *   badge-72.png          monochrome white silhouette on transparent (Android status bar)
 *   shortcut-{sos,map,chat,alerts}.png  96x96 manifest shortcut icons
 *   favicon-32.png, favicon.ico (16/32/48, PNG-embedded ICO; also copied to app/favicon.ico)
 *
 * Every output is verified (PNG signature, dimensions, alpha) before the script exits 0.
 * Bump SW_VERSION in public/sw.js after changing icons so installed clients refresh them.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The frontend project this script belongs to (resolves sharp from its node_modules). */
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const outRoot = resolve(process.argv[2] ?? projectRoot);
const require = createRequire(join(projectRoot, "package.json"));
const sharp = require("sharp");

const outDir = join(outRoot, "public", "icons");
mkdirSync(outDir, { recursive: true });

// ----------------------------------------------------------------------------------------
// Artwork (512 x 512 design grid)
// ----------------------------------------------------------------------------------------

const SHIELD =
  "M256 76 L398 126 Q408 130 408 141 L408 236 C408 334 346 404 262 438 Q256 440.5 250 438 " +
  "C166 404 104 334 104 236 L104 141 Q104 130 114 126 Z";
/** Cross as a single polygon (used as a knock-out in the monochrome badge). */
const CROSS_POLY = "M226 166 H286 V224 H344 V284 H286 V342 H226 V284 H168 V224 H226 Z";

const defs = `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1e293b"/>
      <stop offset="1" stop-color="#020617"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.45" r="0.55">
      <stop offset="0" stop-color="#dc2626" stop-opacity="0.35"/>
      <stop offset="1" stop-color="#dc2626" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="shield" x1="0.2" y1="0" x2="0.8" y2="1">
      <stop offset="0" stop-color="#f87171"/>
      <stop offset="0.45" stop-color="#dc2626"/>
      <stop offset="1" stop-color="#991b1b"/>
    </linearGradient>
  </defs>`;

/** Shield + cross, optionally scaled around the artwork centre (256, 258). */
function emblem(scale = 1) {
  const transform = scale === 1 ? "" : ` transform="translate(256 258) scale(${scale}) translate(-256 -258)"`;
  return `
  <g${transform}>
    <path d="${SHIELD}" fill="url(#shield)" stroke="#fca5a5" stroke-opacity="0.45" stroke-width="6" stroke-linejoin="round"/>
    <rect x="226" y="166" width="60" height="176" rx="12" fill="#ffffff"/>
    <rect x="168" y="224" width="176" height="60" rx="12" fill="#ffffff"/>
  </g>`;
}

/** "any" icon: rounded dark square (transparent corners) with the emblem. */
const iconAny = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <title>ResQ AI</title>${defs}
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  <rect width="512" height="512" rx="112" fill="url(#glow)"/>${emblem(1)}
</svg>
`;

/** Full-bleed variant: maskable / Apple touch icon (no transparency, emblem scaled down). */
function fullBleed(scale) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">${defs}
  <rect width="512" height="512" fill="url(#bg)"/>
  <rect width="512" height="512" fill="url(#glow)"/>${emblem(scale)}
</svg>`;
}

/** Monochrome badge: white shield with the cross knocked out, on transparent. */
const badge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="60 62 392 392" width="392" height="392">
  <path d="${SHIELD} ${CROSS_POLY}" fill="#ffffff" fill-rule="evenodd"/>
</svg>`;

// Lucide (ISC) glyphs, 24x24 stroke icons — same icon family as the app UI.
const GLYPHS = {
  sos: [
    "M7 18v-6a5 5 0 1 1 10 0v6",
    "M5 21a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-1a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2z",
    "M21 12h1",
    "M18.5 4.5 18 5",
    "M2 12h1",
    "M12 2v1",
    "m4.929 4.929.707.707",
    "M12 12v6",
  ],
  map: [
    "M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z",
    "M15 5.764v15",
    "M9 3.236v15",
  ],
  chat: [
    "M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z",
  ],
  alerts: [
    "M10.268 21a2 2 0 0 0 3.464 0",
    "M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326",
  ],
};

const SHORTCUT_COLORS = {
  sos: ["#ef4444", "#b91c1c"],
  map: ["#3b82f6", "#1d4ed8"],
  chat: ["#06b6d4", "#0e7490"],
  alerts: ["#f59e0b", "#b45309"],
};

function shortcut(name) {
  const [from, to] = SHORTCUT_COLORS[name];
  const paths = GLYPHS[name].map((d) => `<path d="${d}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>
  <rect width="96" height="96" fill="url(#g)"/>
  <g transform="translate(24 24) scale(2)" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</g>
</svg>`;
}

// ----------------------------------------------------------------------------------------
// Rendering + verification
// ----------------------------------------------------------------------------------------

async function renderPng(svg, size, file) {
  const buffer = await sharp(Buffer.from(svg), { density: 384 })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  writeFileSync(join(outDir, file), buffer);
  return buffer;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function verify(file, size, { opaque = false, monochrome = false } = {}) {
  const buffer = readFileSync(join(outDir, file));
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error(`${file}: not a PNG`);
  const meta = await sharp(buffer).metadata();
  if (meta.format !== "png" || meta.width !== size || meta.height !== size) {
    throw new Error(`${file}: expected ${size}x${size} png, got ${meta.width}x${meta.height} ${meta.format}`);
  }
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let transparent = 0;
  let coloured = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
    if (a < 255) transparent += 1;
    if (a > 0 && !(r > 245 && g > 245 && b > 245)) coloured += 1;
  }
  if (opaque && transparent > 0) throw new Error(`${file}: must be fully opaque (${transparent} px with alpha)`);
  if (monochrome && coloured > 0) throw new Error(`${file}: must be white-only (${coloured} coloured px)`);
  return `${file.padEnd(22)} ${meta.width}x${meta.height} ${String(buffer.length).padStart(6)} B${opaque ? " opaque" : ""}${monochrome ? " monochrome" : ""}`;
}

/** PNG-embedded ICO (supported by every current browser). */
function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, buffer } of pngs) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(buffer.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += buffer.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.buffer)]);
}

writeFileSync(join(outDir, "icon.svg"), iconAny);

await renderPng(iconAny, 192, "icon-192.png");
await renderPng(iconAny, 512, "icon-512.png");
await renderPng(fullBleed(0.72), 512, "maskable-512.png");
await renderPng(fullBleed(0.8), 180, "apple-touch-icon.png");
await renderPng(badge, 72, "badge-72.png");
for (const name of Object.keys(GLYPHS)) await renderPng(shortcut(name), 96, `shortcut-${name}.png`);

const favicons = [];
for (const size of [16, 32, 48]) {
  const buffer = await sharp(Buffer.from(iconAny), { density: 384 }).resize(size, size).png().toBuffer();
  favicons.push({ size, buffer });
}
writeFileSync(join(outDir, "favicon-32.png"), favicons[1].buffer);
const icoBuffer = buildIco(favicons);
writeFileSync(join(outDir, "favicon.ico"), icoBuffer);
// Next.js serves app/favicon.ico at /favicon.ico (file convention); keep it identical.
mkdirSync(join(outRoot, "app"), { recursive: true });
writeFileSync(join(outRoot, "app", "favicon.ico"), icoBuffer);

const report = [
  await verify("icon-192.png", 192),
  await verify("icon-512.png", 512),
  await verify("maskable-512.png", 512, { opaque: true }),
  await verify("apple-touch-icon.png", 180, { opaque: true }),
  await verify("badge-72.png", 72, { monochrome: true }),
  ...(await Promise.all(Object.keys(GLYPHS).map((n) => verify(`shortcut-${n}.png`, 96, { opaque: true })))),
  await verify("favicon-32.png", 32),
];
const ico = readFileSync(join(outDir, "favicon.ico"));
if (ico.readUInt16LE(2) !== 1 || ico.readUInt16LE(4) !== 3) throw new Error("favicon.ico: bad header");
report.push(`favicon.ico            16/32/48 ${String(ico.length).padStart(6)} B`);
console.log(report.join("\n"));
