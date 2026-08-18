// pack-zip.mjs — package dist/ into a portable extension zip with FORWARD-SLASH entry paths.
// Exists because PowerShell's Compress-Archive writes backslash separators (a long-standing bug):
// non-Windows unzip tools then extract flat files literally named "assets\index.js", Chrome's
// Load-Unpacked sees no manifest/assets, and the extension is dead on arrival. The zip spec
// (APPNOTE 4.4.17) requires forward slashes; this writer emits exactly that. STORE-only (no
// compression) — the payload is ~700KB and Chrome only needs correct structure.
//   bun scripts/pack-zip.mjs <dist-dir> <out-zip>
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const [, , distDir, outZip] = process.argv;
if (!distDir || !outZip) {
  console.error("usage: bun scripts/pack-zip.mjs <dist-dir> <out-zip>");
  process.exit(1);
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

// CRC-32 (the zip polynomial), table-driven.
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const files = [...walk(distDir)].map((p) => ({
  name: relative(distDir, p).split("\\").join("/"),
  data: readFileSync(p),
}));

const localParts = [];
const centralParts = [];
let offset = 0;
for (const f of files) {
  const nameBuf = Buffer.from(f.name, "utf8");
  const crc = crc32(f.data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // local file header
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(0, 8); // method: STORE
  local.writeUInt16LE(0, 10); // mod time
  local.writeUInt16LE(0x21, 12); // mod date (1980-01-01)
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(f.data.length, 18);
  local.writeUInt32LE(f.data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  localParts.push(local, nameBuf, f.data);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); // central directory header
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0x21, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(f.data.length, 20);
  central.writeUInt32LE(f.data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(offset, 42);
  centralParts.push(central, nameBuf);
  offset += 30 + nameBuf.length + f.data.length;
}
const centralSize = centralParts.reduce((n, b) => n + b.length, 0);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(centralSize, 12);
eocd.writeUInt32LE(offset, 16);

mkdirSync(dirname(outZip), { recursive: true });
writeFileSync(outZip, Buffer.concat([...localParts, ...centralParts, eocd]));
const sha = createHash("sha256").update(readFileSync(outZip)).digest("hex").slice(0, 12);
console.log(`packed ${files.length} files -> ${outZip} (sha256 ${sha}…)`);
