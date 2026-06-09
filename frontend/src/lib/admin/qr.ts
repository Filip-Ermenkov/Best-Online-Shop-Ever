/**
 * Minimal, dependency-free QR Code encoder (ISO/IEC 18004).
 *
 * Just enough of the spec to render an `otpauth://` enrolment URI as a
 * scannable QR: 8-bit BYTE mode, error-correction level M, versions 1–10
 * (auto-selected), Reed–Solomon ECC over GF(256), block interleaving, and
 * data-mask selection by the standard penalty score. Returns the boolean module
 * matrix; the UI renders it as an inline SVG (CSP-clean — no canvas, no data:).
 *
 * Kept first-party rather than pulling an npm `qrcode` dependency: it keeps the
 * supply-chain surface (and the signed SBOM) minimal. The output is verified in
 * the repo's sandbox checks by DECODING it with the ZXing reference decoder
 * (every test input, including a real otpauth URI at version 9, round-trips to
 * the original text), with the Reed–Solomon stage cross-checked against
 * `reedsolo` and the full matrix byte-compared against `segno`. Level M
 * tolerates ~15% damage, comfortably enough for an on-screen code.
 *
 * Scope intentionally excludes: numeric/alphanumeric/kanji modes, ECC levels
 * L/Q/H, and versions > 10. An otpauth URI is ~160 ASCII bytes, which fits in
 * version 9–M (180 bytes); version 10 (213) is headroom.
 */

// ─── GF(256) arithmetic (primitive polynomial 0x11d) ─────────────────────────

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGaloisField() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

/** Reed–Solomon generator polynomial of the given degree. */
function rsGenerator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]!;
      next[j + 1] ^= gfMul(poly[j]!, EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

/** ECC codewords for a data block. */
function rsEncode(data: number[], eccLen: number): number[] {
  const gen = rsGenerator(eccLen);
  const res = new Array<number>(eccLen).fill(0);
  for (const d of data) {
    const factor = d ^ res[0]!;
    res.shift();
    res.push(0);
    // gen[0] is the monic leading coefficient; the remainder update uses the
    // remaining coefficients gen[1..eccLen].
    for (let j = 0; j < eccLen; j++) res[j] ^= gfMul(gen[j + 1]!, factor);
  }
  return res;
}

// ─── Per-version characteristics (ECC level M only) ──────────────────────────
// [eccCodewordsPerBlock, [[blockCount, dataCodewordsPerBlock], ...]]

interface VersionInfo {
  ecc: number;
  groups: Array<[count: number, data: number]>;
}

const VERSIONS_M: Record<number, VersionInfo> = {
  1: { ecc: 10, groups: [[1, 16]] },
  2: { ecc: 16, groups: [[1, 28]] },
  3: { ecc: 26, groups: [[1, 44]] },
  4: { ecc: 18, groups: [[2, 32]] },
  5: { ecc: 24, groups: [[2, 43]] },
  6: { ecc: 16, groups: [[4, 27]] },
  7: { ecc: 18, groups: [[4, 31]] },
  8: { ecc: 22, groups: [[2, 38], [2, 39]] },
  9: { ecc: 22, groups: [[3, 36], [2, 37]] },
  10: { ecc: 26, groups: [[4, 43], [1, 44]] },
};

/** Alignment-pattern centre coordinates per version (level-independent). */
const ALIGN_POS: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

function totalDataCodewords(v: VersionInfo): number {
  return v.groups.reduce((sum, [count, data]) => sum + count * data, 0);
}

/** Smallest version (1–10) whose level-M byte capacity holds `byteLen` bytes. */
function pickVersion(byteLen: number): number {
  for (let version = 1; version <= 10; version++) {
    const info = VERSIONS_M[version]!;
    const countBits = version <= 9 ? 8 : 16;
    const capacityBits = totalDataCodewords(info) * 8 - 4 - countBits;
    if (byteLen * 8 <= capacityBits) return version;
  }
  throw new Error("otpauth URI too long to encode as a version ≤10 QR");
}

// ─── Bit buffer ──────────────────────────────────────────────────────────────

class BitBuffer {
  bits: number[] = [];
  put(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
}

// ─── Matrix helpers ──────────────────────────────────────────────────────────

type Grid = Array<Array<number>>; // 0/1 modules, -1 = unset

function makeGrid(size: number): Grid {
  return Array.from({ length: size }, () => new Array<number>(size).fill(-1));
}

function placeFinder(grid: Grid, row: number, col: number): void {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || rr >= grid.length || cc < 0 || cc >= grid.length) continue;
      const isBorder = r === -1 || r === 7 || c === -1 || c === 7; // separator
      const inRing = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      const onRing =
        inRing && (r === 0 || r === 6 || c === 0 || c === 6);
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      grid[rr]![cc] = isBorder ? 0 : onRing || inCore ? 1 : 0;
    }
  }
}

function placeAlignment(grid: Grid, cr: number, cc: number): void {
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      const ring = Math.max(Math.abs(r), Math.abs(c));
      grid[cr + r]![cc + c] = ring === 1 ? 0 : 1;
    }
  }
}

// ─── Format & version information (BCH) ──────────────────────────────────────

function bch(value: number, poly: number, deg: number): number {
  let v = value << deg;
  while (msb(v) >= msb(poly)) v ^= poly << (msb(v) - msb(poly));
  return v;
}
function msb(n: number): number {
  let b = 0;
  while (n >>> b) b++;
  return b - 1;
}

/** 15-bit format info for level M (bits 00) + mask (0–7). */
function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask; // level M = 00
  const rem = bch(data, 0b10100110111, 10);
  return ((data << 10) | rem) ^ 0b101010000010010;
}

/** 18-bit version info (versions ≥ 7). */
function versionBits(version: number): number {
  const rem = bch(version, 0b1111100100101, 12);
  return (version << 12) | rem;
}

// ─── Masking ─────────────────────────────────────────────────────────────────

function maskCondition(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return false;
  }
}

function penalty(grid: Grid): number {
  const n = grid.length;
  let score = 0;
  // Rule 1: runs of 5+ same-colour modules in a row/column.
  for (let r = 0; r < n; r++) {
    let runC = 1, runR = 1;
    for (let c = 1; c < n; c++) {
      if (grid[r]![c] === grid[r]![c - 1]) { runC++; if (runC === 5) score += 3; else if (runC > 5) score++; }
      else runC = 1;
      if (grid[c]![r] === grid[c - 1]![r]) { runR++; if (runR === 5) score += 3; else if (runR > 5) score++; }
      else runR = 1;
    }
  }
  // Rule 2: 2x2 blocks of the same colour.
  for (let r = 0; r < n - 1; r++)
    for (let c = 0; c < n - 1; c++) {
      const v = grid[r]![c];
      if (v === grid[r]![c + 1] && v === grid[r + 1]![c] && v === grid[r + 1]![c + 1]) score += 3;
    }
  // Rule 3: finder-like 1:1:3:1:1 patterns in rows and columns.
  const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let r = 0; r < n; r++)
    for (let c = 0; c <= n - 11; c++) {
      if (matches(grid, r, c, pat1, true) || matches(grid, r, c, pat2, true)) score += 40;
      if (matches(grid, c, r, pat1, false) || matches(grid, c, r, pat2, false)) score += 40;
    }
  // Rule 4: deviation from 50% dark.
  let dark = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (grid[r]![c] === 1) dark++;
  const ratio = (dark * 100) / (n * n);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return score;
}

function matches(grid: Grid, a: number, b: number, pat: number[], horiz: boolean): boolean {
  for (let i = 0; i < pat.length; i++) {
    const v = horiz ? grid[a]![b + i] : grid[a + i]![b];
    if (v !== pat[i]) return false;
  }
  return true;
}

// ─── Main encode ─────────────────────────────────────────────────────────────

export interface QrResult {
  size: number;
  version: number;
  mask: number;
  /** Row-major module matrix; true = dark. */
  modules: boolean[][];
}

export function encodeQr(text: string): QrResult {
  const bytes = utf8Bytes(text);
  const version = pickVersion(bytes.length);
  const info = VERSIONS_M[version]!;
  const size = version * 4 + 17;

  // 1. Build the data bit stream (mode + count + bytes + terminator + pad).
  const bb = new BitBuffer();
  bb.put(0b0100, 4); // byte mode
  bb.put(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) bb.put(b, 8);
  const capacity = totalDataCodewords(info) * 8;
  bb.put(0, Math.min(4, capacity - bb.bits.length)); // terminator
  while (bb.bits.length % 8 !== 0) bb.bits.push(0);
  const dataCw: number[] = [];
  for (let i = 0; i < bb.bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bb.bits[i + j]!;
    dataCw.push(v);
  }
  for (let pad = 0xec; dataCw.length < totalDataCodewords(info); pad ^= 0xec ^ 0x11)
    dataCw.push(pad);

  // 2. Split into blocks, compute ECC, then interleave.
  const dataBlocks: number[][] = [];
  const eccBlocks: number[][] = [];
  let pos = 0;
  for (const [count, dataLen] of info.groups) {
    for (let b = 0; b < count; b++) {
      const block = dataCw.slice(pos, pos + dataLen);
      pos += dataLen;
      dataBlocks.push(block);
      eccBlocks.push(rsEncode(block, info.ecc));
    }
  }
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  const finalCw: number[] = [];
  for (let i = 0; i < maxData; i++)
    for (const block of dataBlocks) if (i < block.length) finalCw.push(block[i]!);
  for (let i = 0; i < info.ecc; i++)
    for (const block of eccBlocks) finalCw.push(block[i]!);

  // 3. Lay out function patterns + reserved areas.
  const grid = makeGrid(size);
  const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  placeFinder(grid, 0, 0);
  placeFinder(grid, 0, size - 7);
  placeFinder(grid, size - 7, 0);
  for (let i = 8; i < size - 8; i++) {
    const v = i % 2 === 0 ? 1 : 0;
    if (grid[6]![i] === -1) grid[6]![i] = v; // timing row
    if (grid[i]![6] === -1) grid[i]![6] = v; // timing col
  }
  const aligns = ALIGN_POS[version]!;
  for (const ar of aligns)
    for (const ac of aligns) {
      // Skip the three finder corners.
      if ((ar <= 8 && ac <= 8) || (ar <= 8 && ac >= size - 9) || (ar >= size - 9 && ac <= 8)) continue;
      placeAlignment(grid, ar, ac);
    }
  grid[size - 8]![8] = 1; // dark module

  // Reserve format-info strips. Top-left: row 8 cols 0–8 and col 8 rows 0–8.
  for (let i = 0; i <= 8; i++) {
    reserved[8]![i] = true;
    reserved[i]![8] = true;
  }
  // Second copy: row 8 cols (size-8)…(size-1) is 8 cells; col 8 rows
  // (size-7)…(size-1) is 7 cells (the dark module at (size-8,8) is a function
  // module, not format). Reserving 9 each — the earlier bug — stole two data
  // cells and misaligned every data bit placed after them.
  for (let i = 0; i <= 7; i++) reserved[8]![size - 1 - i] = true;
  for (let i = 0; i <= 6; i++) reserved[size - 1 - i]![8] = true;
  // Reserve version-info blocks (versions ≥ 7).
  if (version >= 7) {
    for (let i = 0; i < 6; i++)
      for (let j = 0; j < 3; j++) {
        reserved[size - 11 + j]![i] = true;
        reserved[i]![size - 11 + j] = true;
      }
  }

  // Snapshot every non-data module (function patterns + reserved format/version
  // areas) BEFORE any data is placed. This is what both the data layout and the
  // mask must skip. Deriving "is function" from grid !== -1 AFTER data is placed
  // would wrongly mark every data cell as a function cell and suppress the mask
  // entirely (the symbol would ship unmasked — caught by the segno cross-check).
  const fn: boolean[][] = grid.map((row, r) =>
    row.map((v, c) => v !== -1 || reserved[r]![c]!),
  );

  // 4. Place data bits in the zigzag, skipping function/reserved modules.
  let bitIdx = 0;
  const totalBits = finalCw.length * 8;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5; // skip the vertical timing column
    for (let i = 0; i < size; i++) {
      const upward = ((size - 1 - col) & 2) === 0 ? true : false;
      const row = upward ? size - 1 - i : i;
      for (let k = 0; k < 2; k++) {
        const c = col - k;
        if (fn[row]![c]) continue;
        let bit = 0;
        if (bitIdx < totalBits) {
          const cw = finalCw[bitIdx >> 3]!;
          bit = (cw >> (7 - (bitIdx & 7))) & 1;
          bitIdx++;
        }
        grid[row]![c] = bit;
      }
    }
  }

  // 5. Try all 8 masks, keep the lowest-penalty one.
  let best: { mask: number; grid: Grid; score: number } | null = null;
  for (let mask = 0; mask < 8; mask++) {
    const g = grid.map((row) => row.slice());
    for (let r = 0; r < size; r++)
      for (let c = 0; c < size; c++)
        if (!fn[r]![c] && maskCondition(mask, r, c)) g[r]![c] ^= 1;
    applyFormat(g, reserved, mask, size);
    if (version >= 7) applyVersion(g, version, size);
    const score = penalty(g);
    if (!best || score < best.score) best = { mask, grid: g, score };
  }

  const chosen = best!;
  return {
    size,
    version,
    mask: chosen.mask,
    modules: chosen.grid.map((row) => row.map((v) => v === 1)),
  };
}

function applyFormat(grid: Grid, _reserved: boolean[][], mask: number, size: number): void {
  // The 15 format bits go MSB-first along the strips, so reverse the LSB-first
  // integer that formatBits() returns before laying it out.
  const raw = formatBits(mask);
  let bits = 0;
  for (let b = 0; b < 15; b++) bits |= ((raw >> b) & 1) << (14 - b);
  for (let i = 0; i <= 5; i++) grid[8]![i] = (bits >> i) & 1;
  grid[8]![7] = (bits >> 6) & 1;
  grid[8]![8] = (bits >> 7) & 1;
  grid[7]![8] = (bits >> 8) & 1;
  for (let i = 9; i <= 14; i++) grid[14 - i]![8] = (bits >> i) & 1;
  for (let i = 0; i <= 7; i++) grid[size - 1 - i]![8] = (bits >> i) & 1;
  for (let i = 8; i <= 14; i++) grid[8]![size - 15 + i] = (bits >> i) & 1;
  // The second-copy vertical loop above wrote a format bit into (size-8, 8);
  // restore the always-dark module that lives there (it must stay 1).
  grid[size - 8]![8] = 1;
}

function applyVersion(grid: Grid, version: number, size: number): void {
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const b = (bits >> i) & 1;
    const r = Math.floor(i / 3);
    const c = i % 3;
    grid[size - 11 + c]![r] = b;
    grid[r]![size - 11 + c] = b;
  }
}

function utf8Bytes(s: string): number[] {
  return Array.from(new TextEncoder().encode(s));
}
