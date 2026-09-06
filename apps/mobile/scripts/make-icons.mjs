// Generates the app icon, Android adaptive-icon foreground and splash glyph
// with no image dependencies: a tiny PNG encoder over Node's zlib.
// Run: node scripts/make-icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "assets");
mkdirSync(out, { recursive: true });

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ------------------------------ tiny rasteriser ---------------------------- */

const ACCENT = [0x7c, 0x5c, 0xff];
const BG = [0x0b, 0x0b, 0x10];
const WHITE = [0xff, 0xff, 0xff];

// Signed-distance helpers, all in unit coordinates (0..1) relative to the canvas.
const sdRoundRect = (x, y, cx, cy, hw, hh, r) => {
  const dx = Math.abs(x - cx) - hw + r;
  const dy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
};
const sdCircle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;
const sdRing = (x, y, cx, cy, r, w) => Math.abs(sdCircle(x, y, cx, cy, r)) - w / 2;
// Equilateral-ish play triangle pointing right, centred at (cx, cy) with "radius" r.
function sdTriangle(x, y, cx, cy, r) {
  const pts = [
    [cx - r * 0.75, cy - r],
    [cx - r * 0.75, cy + r],
    [cx + r * 0.95, cy],
  ];
  let d = Infinity;
  let s = 1;
  for (let i = 0, j = 2; i < 3; j = i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[j];
    const ex = bx - ax, ey = by - ay;
    const wx = x - ax, wy = y - ay;
    const t = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey)));
    const px = wx - ex * t, py = wy - ey * t;
    d = Math.min(d, px * px + py * py);
    const c1 = y >= ay, c2 = y < by, c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * Math.sqrt(d);
}

function render(size, layers, background) {
  const buf = Buffer.alloc(size * size * 4);
  const aa = 1.2 / size; // anti-alias width in unit space
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = (px + 0.5) / size, y = (py + 0.5) / size;
      let [r, g, b, a] = background ? [...background, 255] : [0, 0, 0, 0];
      for (const { sd, color, alpha = 1 } of layers) {
        const d = sd(x, y);
        const cov = Math.max(0, Math.min(1, 0.5 - d / aa)) * alpha;
        if (cov <= 0) continue;
        const na = cov + (a / 255) * (1 - cov);
        r = (color[0] * cov + r * (a / 255) * (1 - cov)) / na;
        g = (color[1] * cov + g * (a / 255) * (1 - cov)) / na;
        b = (color[2] * cov + b * (a / 255) * (1 - cov)) / na;
        a = na * 255;
      }
      const o = (py * size + px) * 4;
      buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = a;
    }
  }
  return buf;
}

// The glyph: a play triangle with two "sonar" arcs to its right, like a signal being caught.
// Arcs open to the right, the direction the triangle points, so it reads as a signal being caught.
const glyph = (cx, cy, s, color) => {
  const tx = cx - s * 0.3; // triangle centre; arcs are centred on it
  return [
    { sd: (x, y) => sdTriangle(x, y, tx, cy, s * 0.42), color },
    { sd: (x, y) => Math.max(sdRing(x, y, tx, cy, s * 0.68, s * 0.09), tx + s * 0.25 - x), color, alpha: 0.9 },
    { sd: (x, y) => Math.max(sdRing(x, y, tx, cy, s * 0.95, s * 0.09), tx + s * 0.35 - x), color, alpha: 0.6 },
  ];
};

// 1. App icon: dark rounded tile, accent glyph.
writeFileSync(
  join(out, "icon.png"),
  png(1024, render(1024, [
    { sd: (x, y) => sdRoundRect(x, y, 0.5, 0.5, 0.5, 0.5, 0.18), color: BG },
    { sd: (x, y) => sdCircle(x, y, 0.5, 0.5, 0.38), color: ACCENT, alpha: 0.16 },
    ...glyph(0.53, 0.5, 0.34, ACCENT),
  ], null)),
);

// 2. Android adaptive icon foreground: glyph only, on transparent, inside the safe zone.
writeFileSync(
  join(out, "adaptive-icon.png"),
  png(1024, render(1024, glyph(0.52, 0.5, 0.26, ACCENT), null)),
);

// 3. Splash glyph: white, transparent background.
writeFileSync(
  join(out, "splash-icon.png"),
  png(512, render(512, glyph(0.53, 0.5, 0.34, WHITE), null)),
);

console.log("wrote icon.png, adaptive-icon.png, splash-icon.png to", out);
