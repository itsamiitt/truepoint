// Generates the TruePoint toolbar/app icons (16/32/48/128) for the manifest — the BRAND MARK (three rising
// chevrons; the apex earns the Cobalt accent, the lower two are Ink) on a white rounded tile, so it reads on
// any toolbar theme. Kept as a script so icons are reproducible from the brand geometry rather than committed
// as opaque binaries. Pure Node (no image libs): the mark is rendered by a per-pixel distance field at 4×
// supersampling for anti-aliasing, then box-downsampled to an RGBA PNG. Run: `bun scripts/gen-icons.mjs`.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const COBALT = [37, 99, 201]; // --tp-cobalt #2563c9 — the apex point
const INK = [17, 24, 39]; // --tp-ink #111827 — the lower two points
const WHITE = [255, 255, 255];
const SIZES = [16, 32, 48, 128];
const SS = 4; // supersampling factor for anti-aliasing
const STROKE = 8.5; // mark stroke-width, in the 0..100 viewBox
const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "assets", "icons");

// The three chevrons in viewBox units (Guidelines/assets/truepoint-mark.svg). Apex first is the accent.
const APEX = [
  [22, 43],
  [50, 28],
  [78, 43],
];
const LOWER = [
  [
    [22, 60],
    [50, 45],
    [78, 60],
  ],
  [
    [22, 77],
    [50, 62],
    [78, 77],
  ],
];

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let tt = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  tt = Math.max(0, Math.min(1, tt));
  return Math.hypot(px - (ax + tt * dx), py - (ay + tt * dy));
}

// Min distance to a chevron polyline (2 segments) — round caps + joins fall out of the min-distance test.
function distToChevron(px, py, pts) {
  let d = Number.POSITIVE_INFINITY;
  for (let i = 0; i < pts.length - 1; i++) {
    d = Math.min(d, distToSegment(px, py, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
  }
  return d;
}

// Inside a centered rounded rectangle [0,w]×[0,h] with corner radius r (SDF <= 0).
function insideRoundRect(px, py, w, h, r) {
  const qx = Math.abs(px - w / 2) - (w / 2 - r);
  const qy = Math.abs(py - h / 2) - (h / 2 - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
  return outside <= 0;
}

function renderRGBA(size) {
  const hs = size * SS;
  const hi = new Uint8Array(hs * hs * 4);
  const scale = (size * 0.9) / 100; // viewBox→icon; 90% of the tile, mark's built-in padding does the rest
  const tx = (vx) => hs / 2 + (vx - 50) * scale * SS;
  const ty = (vy) => hs / 2 + (vy - 52.5) * scale * SS; // 52.5 = mark content vertical centroid
  const half = (STROKE / 2) * scale * SS;
  const radius = hs * 0.22;

  const apex = APEX.map(([x, y]) => [tx(x), ty(y)]);
  const lower = LOWER.map((c) => c.map(([x, y]) => [tx(x), ty(y)]));

  for (let y = 0; y < hs; y++) {
    for (let x = 0; x < hs; x++) {
      const cx = x + 0.5;
      const cy = y + 0.5;
      let color = null;
      if (distToChevron(cx, cy, apex) <= half) {
        color = COBALT;
      } else if (lower.some((c) => distToChevron(cx, cy, c) <= half)) {
        color = INK;
      } else if (insideRoundRect(cx, cy, hs, hs, radius)) {
        color = WHITE;
      }
      if (color) {
        const p = (y * hs + x) * 4;
        hi[p] = color[0];
        hi[p + 1] = color[1];
        hi[p + 2] = color[2];
        hi[p + 3] = 255;
      }
    }
  }

  // Box-downsample SS×SS → the final size, averaging RGBA (edges get fractional alpha = anti-aliasing).
  const out = new Uint8Array(size * size * 4);
  const n = SS * SS;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const p = ((y * SS + sy) * hs + (x * SS + sx)) * 4;
          r += hi[p];
          g += hi[p + 1];
          b += hi[p + 2];
          a += hi[p + 3];
        }
      }
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

// ── Minimal RGBA PNG encoder (color type 6) ──────────────────────────────────────────────────────────────
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function pngRGBA(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: truecolor + alpha
  const stride = 1 + size * 4;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    const off = y * stride;
    raw[off] = 0; // filter: none
    for (let x = 0; x < size * 4; x++) {
      raw[off + 1 + x] = rgba[y * size * 4 + x];
    }
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(outDir, { recursive: true });
for (const size of SIZES) {
  writeFileSync(join(outDir, `${size}.png`), pngRGBA(size, renderRGBA(size)));
}
process.stdout.write(`wrote ${SIZES.length} brand-mark icons to ${outDir}\n`);
