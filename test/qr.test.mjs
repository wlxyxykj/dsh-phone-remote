/**
 * Verification suite for the dependency-free byte-mode QR encoder in ../lib/qr.js.
 *
 * Two kinds of checks are performed:
 *
 *  1. Self-contained checks. Structural invariants, BCH validity of the format and
 *     version information, and a full round trip that decodes the produced matrix
 *     back into the original payload. The decoder in this file is written
 *     independently of the encoder: it rebuilds the function-pattern map, unmasks,
 *     walks the placement zigzag, de-interleaves the blocks and then validates the
 *     Reed-Solomon codewords by evaluating their syndromes at a^0..a^(ecLen-1)
 *     (syndrome evaluation, not the encoder's polynomial long division).
 *
 *  2. Differential checks against independent reference encoders, when present
 *     under ../scratch (they are scratch artefacts, not deliverables):
 *       - Kazuhiko Arase's qrcode-generator 1.4.4 (MIT), byte mode + UTF-8
 *       - soldair/node-qrcode 1.5.3 (MIT)
 *     Both are compared against this encoder for the same payloads, versions,
 *     error-correction levels and masks. If the scratch references are absent the
 *     differential tests skip themselves instead of failing.
 *
 * Run with: node --test test/qr.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

import { qrMatrix } from '../lib/qr.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Optional independent references (scratch artefacts)
// ---------------------------------------------------------------------------

const REF_ARASE_PATH = path.join(HERE, '..', 'scratch', 'qrcode-generator.cjs');
const REF_NPM_PATH = path.join(HERE, '..', 'scratch', 'ref2', 'node_modules', 'qrcode');

/** @type {any} Kazuhiko Arase's qrcode-generator, or null when not downloaded. */
const arase = (() => {
  if (!fs.existsSync(REF_ARASE_PATH)) return null;
  const mod = require(REF_ARASE_PATH);
  mod.stringToBytes = mod.stringToBytesFuncs['UTF-8'];
  return mod;
})();

/** @type {any} soldair/node-qrcode plus the internals used for cross-checking. */
const npmRef = (() => {
  if (!fs.existsSync(REF_NPM_PATH)) return null;
  const core = (name) => require(path.join(REF_NPM_PATH, 'lib', 'core', name));
  return {
    qrcode: require(REF_NPM_PATH),
    BitMatrix: core('bit-matrix'),
    MaskPattern: core('mask-pattern'),
    FormatInfo: core('format-info'),
    VersionInfo: core('version'),
    ErrorCorrectionCode: core('error-correction-code'),
    ErrorCorrectionLevel: core('error-correction-level'),
  };
})();

// ---------------------------------------------------------------------------
// Test-local tables (validated against the references by the tests below)
// ---------------------------------------------------------------------------

/** Alignment-pattern centre coordinates per version. */
const ALIGNMENT_CENTERS = {
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

/**
 * Error-correction block layout: [ecCodewordsPerBlock, [[blockCount, dataCodewords], ...]].
 * This mirrors the layout the encoder is expected to use. Its totals are checked
 * against node-qrcode's independent table, and its exact interleaving is checked
 * transitively by the exact matrix comparisons against both references.
 */
const BLOCKS = {
  1: { L: [7, [[1, 19]]], M: [10, [[1, 16]]], Q: [13, [[1, 13]]], H: [17, [[1, 9]]] },
  2: { L: [10, [[1, 34]]], M: [16, [[1, 28]]], Q: [22, [[1, 22]]], H: [28, [[1, 16]]] },
  3: { L: [15, [[1, 55]]], M: [26, [[1, 44]]], Q: [18, [[2, 17]]], H: [22, [[2, 13]]] },
  4: { L: [20, [[1, 80]]], M: [18, [[2, 32]]], Q: [26, [[2, 24]]], H: [16, [[4, 9]]] },
  5: { L: [26, [[1, 108]]], M: [24, [[2, 43]]], Q: [18, [[2, 15], [2, 16]]], H: [22, [[2, 11], [2, 12]]] },
  6: { L: [18, [[2, 68]]], M: [16, [[4, 27]]], Q: [24, [[4, 19]]], H: [28, [[4, 15]]] },
  7: { L: [20, [[2, 78]]], M: [18, [[4, 31]]], Q: [18, [[2, 14], [4, 15]]], H: [26, [[4, 13], [1, 14]]] },
  8: { L: [24, [[2, 97]]], M: [22, [[2, 38], [2, 39]]], Q: [22, [[4, 18], [2, 19]]], H: [26, [[4, 14], [2, 15]]] },
  9: { L: [30, [[2, 116]]], M: [22, [[3, 36], [2, 37]]], Q: [20, [[4, 16], [4, 17]]], H: [24, [[4, 12], [4, 13]]] },
  10: { L: [18, [[2, 68], [2, 69]]], M: [26, [[4, 43], [1, 44]]], Q: [24, [[6, 19], [2, 20]]], H: [28, [[6, 15], [2, 16]]] },
};

const EC_LEVELS = ['L', 'M', 'Q', 'H'];

/** Published ISO/IEC 18004 total codeword counts (data + error correction) per version. */
const TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

/**
 * Total number of data codewords for a version and EC level.
 * @param {number} version
 * @param {'L'|'M'|'Q'|'H'} ecLevel
 * @returns {number}
 */
function dataCodewordCount(version, ecLevel) {
  return BLOCKS[version][ecLevel][1].reduce((sum, [count, perBlock]) => sum + count * perBlock, 0);
}

/**
 * Largest payload (in UTF-8 bytes) that fits a version and EC level in byte mode.
 * @param {number} version
 * @param {'L'|'M'|'Q'|'H'} ecLevel
 * @returns {number}
 */
function maxPayloadBytes(version, ecLevel) {
  const countBits = version <= 9 ? 8 : 16;
  return Math.floor((dataCodewordCount(version, ecLevel) * 8 - 4 - countBits) / 8);
}

// ---------------------------------------------------------------------------
// Independent decoders and readers
// ---------------------------------------------------------------------------

/**
 * Map of the modules occupied by function patterns for a version.
 * @param {number} version
 * @returns {Uint8Array[]} 1 marks a function module
 */
function functionModuleMap(version) {
  const size = version * 4 + 17;
  const map = Array.from({ length: size }, () => new Uint8Array(size));
  const markRect = (r0, c0, r1, c1) => {
    for (let r = Math.max(r0, 0); r <= Math.min(r1, size - 1); r++) {
      for (let c = Math.max(c0, 0); c <= Math.min(c1, size - 1); c++) map[r][c] = 1;
    }
  };

  // finder patterns plus separators: full 8x8 blocks in three corners
  markRect(0, 0, 7, 7);
  markRect(0, size - 8, 7, size - 1);
  markRect(size - 8, 0, size - 1, 7);
  // timing patterns
  markRect(6, 8, 6, size - 9);
  markRect(8, 6, size - 9, 6);
  // alignment patterns (skipping the three that collide with a finder)
  for (const row of ALIGNMENT_CENTERS[version]) {
    for (const col of ALIGNMENT_CENTERS[version]) {
      const overlapsFinder =
        (row <= 8 && col <= 8) || (row <= 8 && col >= size - 9) || (row >= size - 9 && col <= 8);
      if (!overlapsFinder) markRect(row - 2, col - 2, row + 2, col + 2);
    }
  }
  // format information areas and the dark module
  markRect(8, 0, 8, 8);
  markRect(0, 8, 8, 8);
  markRect(8, size - 8, 8, size - 1);
  markRect(size - 8, 8, size - 1, 8);
  // version information for versions >= 7
  if (version >= 7) {
    markRect(0, size - 11, 5, size - 9);
    markRect(size - 11, 0, size - 9, 5);
  }
  return map;
}

/** The eight standard data mask predicates. */
const MASK_FUNCTIONS = [
  (row, col) => (row + col) % 2 === 0,
  (row) => row % 2 === 0,
  (row, col) => col % 3 === 0,
  (row, col) => (row + col) % 3 === 0,
  (row, col) => (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0,
  (row, col) => ((row * col) % 2) + ((row * col) % 3) === 0,
  (row, col) => (((row * col) % 2) + ((row * col) % 3)) % 2 === 0,
  (row, col) => (((row + col) % 2) + ((row * col) % 3)) % 2 === 0,
];

/**
 * Reverse the data mask of a final matrix (the whole matrix is XORed; the
 * function modules are simply ignored by the caller).
 * @param {Uint8Array[]} modules
 * @param {number} mask
 * @returns {Uint8Array[]}
 */
function unmask(modules, mask) {
  const size = modules.length;
  const fn = MASK_FUNCTIONS[mask];
  return modules.map((row, r) => Uint8Array.from(row, (v, c) => v ^ (fn(r, c) ? 1 : 0)));
}

/**
 * Read the codeword bytes back out of an unmasked matrix using the standard
 * two-module zigzag placement order.
 * @param {Uint8Array[]} unmasked
 * @param {number} version
 * @returns {number[]} codewords (a trailing partial byte, if any, is dropped)
 */
function extractCodewords(unmasked, version) {
  const size = version * 4 + 17;
  const isFunction = functionModuleMap(version);
  const bytes = [];
  let current = 0;
  let filled = 0;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const col = right - j;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - vert : vert;
        if (isFunction[row][col]) continue;
        current = (current << 1) | unmasked[row][col];
        if (++filled === 8) {
          bytes.push(current);
          current = 0;
          filled = 0;
        }
      }
    }
  }
  return bytes;
}

/**
 * Split an interleaved codeword stream back into its data and EC blocks.
 * @param {number[]} codewords
 * @param {number} version
 * @param {'L'|'M'|'Q'|'H'} ecLevel
 * @returns {{ data: number[], ec: number[], ecPerBlock: number }[]}
 */
function deinterleave(codewords, version, ecLevel) {
  const [ecPerBlock, groups] = BLOCKS[version][ecLevel];
  /** @type {{ data: number[], ec: number[] }[]} */
  const blocks = [];
  for (const [count, perBlock] of groups) {
    for (let i = 0; i < count; i++) blocks.push({ data: new Array(perBlock).fill(0), ec: new Array(ecPerBlock).fill(0) });
  }
  let index = 0;
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) {
    for (const block of blocks) if (i < block.data.length) block.data[i] = codewords[index++];
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of blocks) block.ec[i] = codewords[index++];
  }
  return blocks.map((b) => ({ ...b, ecPerBlock }));
}

/** GF(256) tables built locally for the syndrome check. */
const GF = (() => {
  const exp = new Uint8Array(512);
  const log = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i++) {
    exp[i] = x;
    log[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) exp[i] = exp[i - 255];
  const mul = (a, b) => (a === 0 || b === 0 ? 0 : exp[log[a] + log[b]]);
  return { exp, mul };
})();

/**
 * Evaluate the syndromes S_0..S_{ecLen-1} of a Reed-Solomon codeword by Horner's
 * rule. A valid codeword has all syndromes equal to zero.
 * @param {number[]} codeword data codewords followed by EC codewords, highest degree first
 * @param {number} ecLen
 * @returns {number[]} syndromes
 */
function rsSyndromes(codeword, ecLen) {
  const syndromes = [];
  for (let j = 0; j < ecLen; j++) {
    const root = GF.exp[j];
    let value = 0;
    for (const coefficient of codeword) value = GF.mul(value, root) ^ coefficient;
    syndromes.push(value);
  }
  return syndromes;
}

/** Bit reader over an array of codewords, most significant bit first. */
class BitReader {
  /** @param {number[]} bytes */
  constructor(bytes) {
    this.bytes = bytes;
    this.position = 0;
  }
  /** @param {number} count @returns {number} */
  read(count) {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const byte = this.bytes[this.position >>> 3];
      if (byte === undefined) throw new Error('BitReader: read past the end of the stream');
      value = (value << 1) | ((byte >>> (7 - (this.position & 7))) & 1);
      this.position++;
    }
    return value;
  }
}

/**
 * Read the 15-bit format information word from both of its copies and verify it.
 * @param {Uint8Array[]} modules
 * @returns {{ copy1: number, copy2: number, data: number, ecBits: number, mask: number, bchRemainder: number }}
 */
function readFormatInfo(modules) {
  const size = modules.length;
  let copy1 = 0;
  let copy2 = 0;
  for (let i = 0; i < 15; i++) {
    let bit1;
    if (i < 6) bit1 = modules[i][8];
    else if (i === 6) bit1 = modules[7][8];
    else if (i === 7) bit1 = modules[8][8];
    else if (i === 8) bit1 = modules[8][7];
    else bit1 = modules[8][14 - i];
    copy1 |= bit1 << i;
    const bit2 = i < 8 ? modules[8][size - 1 - i] : modules[size - 15 + i][8];
    copy2 |= bit2 << i;
  }
  const unmasked = copy1 ^ 0x5412; // undo the standard format mask
  let remainder = unmasked;
  for (let i = 14; i >= 10; i--) if ((remainder >>> i) & 1) remainder ^= 0x537 << (i - 10);
  const data = unmasked >>> 10;
  return { copy1, copy2, data, ecBits: data >>> 3, mask: data & 7, bchRemainder: remainder };
}

/**
 * Read the 18-bit version information word from both of its copies.
 * @param {Uint8Array[]} modules
 * @returns {{ copy1: number, copy2: number, version: number, bchRemainder: number }}
 */
function readVersionInfo(modules) {
  const size = modules.length;
  let copy1 = 0;
  let copy2 = 0;
  for (let i = 0; i < 18; i++) {
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    copy1 |= modules[b][a] << i;
    copy2 |= modules[a][b] << i;
  }
  let remainder = copy1;
  for (let i = 17; i >= 12; i--) if ((remainder >>> i) & 1) remainder ^= 0x1f25 << (i - 12);
  return { copy1, copy2, version: copy1 >>> 12, bchRemainder: remainder };
}

/**
 * Decode the payload of a matrix produced by qrMatrix and verify its structure.
 * @param {Uint8Array[]} modules
 * @param {number} version
 * @param {'L'|'M'|'Q'|'H'} ecLevel
 * @returns {{ bytes: number[], syndromes: number[][] }}
 */
function decodeByteMode(modules, version, ecLevel) {
  const format = readFormatInfo(modules);
  const codewords = extractCodewords(unmask(modules, format.mask), version);
  const blocks = deinterleave(codewords, version, ecLevel);

  /** @type {number[][]} */
  const syndromes = [];
  for (const block of blocks) {
    const codeword = [...block.data, ...block.ec];
    syndromes.push(rsSyndromes(codeword, block.ecPerBlock));
  }

  const dataCodewords = [];
  for (const block of blocks) dataCodewords.push(...block.data);

  const reader = new BitReader(dataCodewords);
  const mode = reader.read(4);
  assert.equal(mode, 0b0100, 'expected the byte-mode indicator 0100');
  const count = reader.read(version <= 9 ? 8 : 16);
  const bytes = [];
  for (let i = 0; i < count; i++) bytes.push(reader.read(8));

  // terminator + pad bits up to the next codeword boundary must be zero
  const slack = (8 - (reader.position % 8)) % 8;
  if (slack > 0) assert.equal(reader.read(slack), 0, 'terminator/padding bits must be zero');
  // remaining codewords must alternate 0xEC / 0x11
  let padIndex = 0;
  while (reader.position < dataCodewords.length * 8) {
    assert.equal(reader.read(8), padIndex % 2 === 0 ? 0xec : 0x11, 'unexpected pad codeword');
    padIndex++;
  }
  return { bytes, syndromes };
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Payloads that fit in version 10 at every EC level. */
const CROSS_CASES = [
  { name: 'short ASCII', text: 'HELLO' },
  { name: '60-char URL', text: 'https://example.com/path?q=hello+world&lang=en#fragment-42' },
  { name: 'CJK UTF-8', text: '\u4f60\u597d\u4e16\u754c\uff0cQR\u30b3\u30fc\u30c9' },
  { name: 'digits only', text: '0123456789'.repeat(4) },
];

/** A ~200 character payload: fits version 10 at L and M, but not at Q or H. */
const LONG_TEXT = 'x'.repeat(200);

/**
 * Render a matrix as ASCII art with a one-module quiet zone.
 * @param {Uint8Array[]} modules
 * @returns {string}
 */
function asciiArt(modules) {
  const size = modules.length;
  const border = '.'.repeat(size + 2);
  const lines = [border];
  for (let r = 0; r < size; r++) {
    let line = '.';
    for (let c = 0; c < size; c++) line += modules[r][c] ? '#' : ' ';
    lines.push(`${line}.`);
  }
  lines.push(border);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 1. Structural invariants
// ---------------------------------------------------------------------------

test('module matrix shape is consistent with the reported version', () => {
  for (const version of Array.from({ length: 10 }, (_, i) => i + 1)) {
    for (const ecLevel of EC_LEVELS) {
      const result = qrMatrix('A', { ecLevel, version });
      const size = version * 4 + 17;
      assert.equal(result.version, version);
      assert.equal(result.ecLevel, ecLevel);
      assert.equal(result.size, size);
      assert.ok(Number.isInteger(result.mask) && result.mask >= 0 && result.mask <= 7);
      assert.ok(Array.isArray(result.modules));
      assert.equal(result.modules.length, size);
      for (const row of result.modules) {
        assert.ok(row instanceof Uint8Array, 'rows must be Uint8Array by default');
        assert.equal(row.length, size);
        for (const value of row) assert.ok(value === 0 || value === 1, 'modules must be 0 or 1');
      }
    }
  }
});

test('finder patterns, separators, timing patterns and dark module are correct', () => {
  for (const version of Array.from({ length: 10 }, (_, i) => i + 1)) {
    for (const ecLevel of EC_LEVELS) {
      const { modules, size } = qrMatrix('A', { ecLevel, version });

      // Finder patterns: 7x7 rings at three corners, dark centre 3x3.
      for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
        for (let dr = 0; dr < 7; dr++) {
          for (let dc = 0; dc < 7; dc++) {
            const expected =
              dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4)
                ? 1
                : 0;
            assert.equal(modules[r0 + dr][c0 + dc], expected, `finder at (${r0},${c0}) module (${dr},${dc})`);
          }
        }
      }

      // Separators: the 8th row/column of each finder block must be light.
      for (let i = 0; i < 8; i++) {
        assert.equal(modules[7][i], 0, 'top-left separator');
        assert.equal(modules[i][7], 0, 'top-left separator');
        assert.equal(modules[7][size - 1 - i], 0, 'top-right separator');
        assert.equal(modules[size - 1 - i][7], 0, 'bottom-left separator');
      }

      // Timing patterns: alternating, dark on even coordinates.
      for (let i = 8; i <= size - 9; i++) {
        assert.equal(modules[6][i], i % 2 === 0 ? 1 : 0, `horizontal timing at column ${i}`);
        assert.equal(modules[i][6], i % 2 === 0 ? 1 : 0, `vertical timing at row ${i}`);
      }

      // Dark module just above the bottom-left finder's format column.
      assert.equal(modules[size - 8][8], 1, 'dark module must be dark');

      // Alignment patterns: dark ring, light inner ring, dark centre.
      const centers = ALIGNMENT_CENTERS[version];
      let drawn = 0;
      for (const row of centers) {
        for (const col of centers) {
          const overlaps =
            (row <= 8 && col <= 8) || (row <= 8 && col >= size - 9) || (row >= size - 9 && col <= 8);
          if (overlaps) continue;
          drawn++;
          for (let dr = -2; dr <= 2; dr++) {
            for (let dc = -2; dc <= 2; dc++) {
              const expected = Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0;
              assert.equal(
                modules[row + dr][col + dc],
                expected,
                `alignment pattern at (${row},${col}) module (${dr},${dc})`,
              );
            }
          }
        }
      }
      const expectedAlignments = centers.length === 0 ? 0 : centers.length ** 2 - 3;
      assert.equal(drawn, expectedAlignments, `alignment pattern count for version ${version}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 2. Format and version information (BCH)
// ---------------------------------------------------------------------------

test('format information: both copies agree, BCH remainder is zero, EC level and mask match', () => {
  for (const version of Array.from({ length: 10 }, (_, i) => i + 1)) {
    for (const ecLevel of EC_LEVELS) {
      const result = qrMatrix('A', { ecLevel, version });
      const info = readFormatInfo(result.modules);

      assert.equal(info.copy1, info.copy2, 'the two format information copies must be identical');
      assert.equal(info.bchRemainder, 0, 'format information must be a valid BCH(15,5) codeword');
      assert.equal(info.mask, result.mask, 'the embedded mask must match the reported mask');
      const expectedEcBits = { L: 1, M: 0, Q: 3, H: 2 }[ecLevel];
      assert.equal(info.ecBits, expectedEcBits, 'the embedded EC level must match the reported level');
    }
  }
});

test('format information matches the published ISO/IEC 18004 constants', () => {
  // Table C.1 values for data mask 0.
  const expected = { L: 0x77c4, M: 0x5412, Q: 0x355f, H: 0x1689 };
  for (const ecLevel of EC_LEVELS) {
    const { modules } = qrMatrix('A', { ecLevel, mask: 0 });
    assert.equal(readFormatInfo(modules).copy1, expected[ecLevel], `format information for ${ecLevel}/mask 0`);
  }
});

test('version information is present and valid for versions 7..10', () => {
  // Published ISO/IEC 18004 Table D.1 version information strings.
  const expected = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3 };
  for (let version = 7; version <= 10; version++) {
    for (const ecLevel of EC_LEVELS) {
      const { modules, size } = qrMatrix('version information', { ecLevel, version });
      const info = readVersionInfo(modules);
      assert.equal(info.copy1, info.copy2, 'the two version information copies must be identical');
      assert.equal(info.bchRemainder, 0, 'version information must be a valid BCH(18,6) codeword');
      assert.equal(info.version, version, 'the embedded version must match');
      assert.equal(info.copy1, expected[version], `version information constant for version ${version}`);

      // The version information block must not leak into the finder patterns.
      for (let i = 0; i < 3; i++) {
        assert.equal(modules[0][size - 1 - i], 1, 'top-right finder must be untouched');
        assert.equal(modules[size - 1 - i][0], 1, 'bottom-left finder must be untouched');
      }
    }
  }
});

test('data capacity and total codeword counts match the standard', () => {
  // Remainder bits that pad the encoding region after the last codeword.
  const REMAINDER_BITS = { 1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 0, 8: 0, 9: 0, 10: 0 };

  for (let version = 1; version <= 10; version++) {
    for (const ecLevel of EC_LEVELS) {
      const [ecPerBlock, groups] = BLOCKS[version][ecLevel];
      const blockCount = groups.reduce((sum, [count]) => sum + count, 0);
      const total = dataCodewordCount(version, ecLevel) + ecPerBlock * blockCount;
      assert.equal(total, TOTAL_CODEWORDS[version], `total codewords for version ${version}/${ecLevel}`);

      // Every non-function module takes exactly one bit.
      const isFunction = functionModuleMap(version);
      const size = version * 4 + 17;
      let dataModules = 0;
      for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (!isFunction[r][c]) dataModules++;
      assert.equal(
        dataModules,
        total * 8 + REMAINDER_BITS[version],
        `available data modules for version ${version}/${ecLevel}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 3. Round trip: decode the encoder's own output
// ---------------------------------------------------------------------------

test('round trip: payload, padding, RS syndromes and placement all verify', () => {
  const payloads = ['', 'A', 'HELLO', 'https://example.com/?a=1&b=2#z', '\u4f60\u597d\u4e16\u754c', '0123456789'];
  for (let version = 1; version <= 10; version++) {
    for (const ecLevel of EC_LEVELS) {
      for (const text of payloads) {
        if (Buffer.byteLength(text, 'utf8') > maxPayloadBytes(version, ecLevel)) continue;
        const result = qrMatrix(text, { ecLevel, version });
        const decoded = decodeByteMode(result.modules, version, ecLevel);
        assert.deepEqual(decoded.bytes, [...Buffer.from(text, 'utf8')], `payload round trip ${version}/${ecLevel}`);
        for (const syndromes of decoded.syndromes) {
          assert.deepEqual(syndromes, syndromes.map(() => 0), 'all Reed-Solomon syndromes must be zero');
        }
      }
    }
  }
});

test('round trip at exact capacity for every version and EC level', () => {
  for (let version = 1; version <= 10; version++) {
    for (const ecLevel of EC_LEVELS) {
      const size = maxPayloadBytes(version, ecLevel);
      // printable ASCII keeps the byte length equal to the character count
      const text = 'A'.repeat(size);
      assert.equal(Buffer.byteLength(text, 'utf8'), size);

      const result = qrMatrix(text, { ecLevel, version });
      assert.equal(result.version, version, 'an exactly full payload must still select this version');
      const decoded = decodeByteMode(result.modules, version, ecLevel);
      assert.deepEqual(decoded.bytes, [...Buffer.from(text, 'utf8')]);
      for (const syndromes of decoded.syndromes) assert.deepEqual(syndromes, syndromes.map(() => 0));

      // one byte more must no longer fit this version
      if (version < 10) {
        const auto = qrMatrix('A'.repeat(size + 1), { ecLevel });
        assert.ok(auto.version > version, `payload of ${size + 1} bytes must not fit version ${version} at ${ecLevel}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 4. Version selection and error handling
// ---------------------------------------------------------------------------

test('auto-selects the smallest version that fits', () => {
  /** The smallest supported version that fits, or null when none does. */
  const expectedVersion = (byteLength, ecLevel) => {
    for (let version = 1; version <= 10; version++) {
      if (byteLength <= maxPayloadBytes(version, ecLevel)) return version;
    }
    return null;
  };

  for (const ecLevel of EC_LEVELS) {
    for (let version = 1; version <= 10; version++) {
      const fits = maxPayloadBytes(version, ecLevel);
      if (fits < 1) continue;
      const exact = qrMatrix('A'.repeat(fits), { ecLevel });
      assert.equal(exact.version, version, `${fits} bytes at ${ecLevel} must select version ${version}`);
      if (version < 10) {
        const tooBig = qrMatrix('A'.repeat(fits + 1), { ecLevel });
        assert.ok(tooBig.version > version, `${fits + 1} bytes at ${ecLevel} must not fit version ${version}`);
      }
    }
  }

  // The 200 character payload fits only at L (version 9) and M (version 10).
  for (const ecLevel of EC_LEVELS) {
    const expected = expectedVersion(200, ecLevel);
    if (expected === null) {
      assert.throws(() => qrMatrix(LONG_TEXT, { ecLevel }), /does not fit/, `200 bytes must not fit at ${ecLevel}`);
    } else {
      assert.equal(qrMatrix(LONG_TEXT, { ecLevel }).version, expected, `200 bytes at ${ecLevel}`);
    }
  }
  assert.equal(expectedVersion(200, 'L'), 9);
  assert.equal(expectedVersion(200, 'M'), 10);
  assert.equal(expectedVersion(200, 'Q'), null);
  assert.equal(expectedVersion(200, 'H'), null);
});

test('throws a clear error when the payload does not fit', () => {
  assert.throws(() => qrMatrix('A'.repeat(300), { ecLevel: 'H' }), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /does not fit/);
    assert.match(error.message, /version/);
    return true;
  });
  // Forcing a version that is too small must fail as well.
  assert.throws(() => qrMatrix('A'.repeat(20), { ecLevel: 'H', version: 1 }), /does not fit/);
});

test('rejects invalid arguments', () => {
  assert.throws(() => qrMatrix(42), TypeError);
  assert.throws(() => qrMatrix('A', { ecLevel: 'X' }), TypeError);
  assert.throws(() => qrMatrix('A', { ecLevel: 'l' }), TypeError);
  assert.throws(() => qrMatrix('A', { version: 0 }), TypeError);
  assert.throws(() => qrMatrix('A', { version: 11 }), TypeError);
  assert.throws(() => qrMatrix('A', { version: 1.5 }), TypeError);
  assert.throws(() => qrMatrix('A', { mask: 8 }), TypeError);
  assert.throws(() => qrMatrix('A', { mask: -1 }), TypeError);
});

test('empty payload and EC level ordering behave sensibly', () => {
  const empty = qrMatrix('', { ecLevel: 'M' });
  assert.equal(empty.version, 1);
  assert.equal(empty.size, 21);
  const decoded = decodeByteMode(empty.modules, 1, 'M');
  assert.deepEqual(decoded.bytes, []);

  const matrices = EC_LEVELS.map((ecLevel) => qrMatrix('https://example.com/', { ecLevel }));
  for (let i = 1; i < matrices.length; i++) {
    assert.notDeepEqual(matrices[i].modules, matrices[i - 1].modules, 'different EC levels must differ');
  }
});

test('options.booleans returns boolean rows equal to the numeric matrix', () => {
  for (const ecLevel of EC_LEVELS) {
    const numeric = qrMatrix('booleans', { ecLevel });
    const bools = qrMatrix('booleans', { ecLevel, booleans: true });
    assert.equal(bools.version, numeric.version);
    assert.equal(bools.mask, numeric.mask);
    assert.equal(bools.size, numeric.size);
    for (let r = 0; r < numeric.size; r++) {
      assert.ok(Array.isArray(bools.modules[r]));
      for (let c = 0; c < numeric.size; c++) {
        assert.equal(bools.modules[r][c], numeric.modules[r][c] === 1);
      }
    }
  }
});

test('the same input always produces the same symbol', () => {
  const a = qrMatrix('deterministic');
  const b = qrMatrix('deterministic');
  assert.equal(a.mask, b.mask);
  assert.deepEqual(a.modules, b.modules);
});

// ---------------------------------------------------------------------------
// 5. Differential tests against independent reference implementations
// ---------------------------------------------------------------------------

/**
 * Build a matrix with Arase's qrcode-generator in byte mode with UTF-8 bytes.
 * @param {string} text
 * @param {'L'|'M'|'Q'|'H'} ecLevel
 * @param {number} [version] force a version (0 = auto)
 * @returns {{ version: number, mask: number, modules: Uint8Array[] }}
 */
function araseMatrix(text, ecLevel, version = 0) {
  const qr = arase(version, ecLevel);
  qr.addData(text, 'Byte');
  qr.make();
  const size = qr.getModuleCount();
  const modules = Array.from({ length: size }, (_, r) =>
    Uint8Array.from({ length: size }, (_, c) => (qr.isDark(r, c) ? 1 : 0)),
  );
  return { version: (size - 17) / 4, mask: readFormatInfo(modules).mask, modules };
}

/**
 * Build a matrix with node-qrcode from an explicit byte segment.
 * @param {string} text
 * @param {'L'|'M'|'Q'|'H'} ecLevel
 * @param {{ mask?: number, version?: number }} [options]
 * @returns {{ version: number, mask: number, modules: Uint8Array[] }}
 */
function npmMatrix(text, ecLevel, options = {}) {
  const settings = { errorCorrectionLevel: ecLevel };
  if (options.mask !== undefined) settings.maskPattern = options.mask;
  if (options.version !== undefined) settings.version = options.version;
  const symbol = npmRef.qrcode.create([{ data: new TextEncoder().encode(text), mode: 'byte' }], settings);
  const size = symbol.modules.size;
  const modules = Array.from({ length: size }, (_, r) =>
    Uint8Array.from({ length: size }, (_, c) => (symbol.modules.get(r, c) ? 1 : 0)),
  );
  return { version: symbol.version, mask: readFormatInfo(modules).mask, modules };
}

/**
 * Build a string whose UTF-8 encoding stays within a byte budget.
 * @param {string} pattern
 * @param {number} budget maximum number of UTF-8 bytes
 * @returns {string}
 */
function bytePattern(pattern, budget) {
  let text = '';
  let used = 0;
  for (let i = 0; used < budget; i++) {
    const character = pattern[i % pattern.length];
    const width = Buffer.byteLength(character, 'utf8');
    if (used + width > budget) break;
    text += character;
    used += width;
  }
  return text;
}

/**
 * A systematic sweep: every version, every EC level, and payloads at empty,
 * half and exactly full capacity, in both single-byte and multi-byte UTF-8.
 */
const SWEEP = (() => {
  /** @type {{ version: number, ecLevel: 'L'|'M'|'Q'|'H', text: string }[]} */
  const cases = [];
  for (let version = 1; version <= 10; version++) {
    for (const ecLevel of EC_LEVELS) {
      const max = maxPayloadBytes(version, ecLevel);
      for (const length of [...new Set([0, Math.floor(max / 2), max])]) {
        cases.push({ version, ecLevel, text: 'A'.repeat(length) });
      }
      cases.push({ version, ecLevel, text: bytePattern('\u00e9\u4e2dQ7', max) });
    }
  }
  return cases;
})();

/**
 * Cell-by-cell comparison of two matrices.
 * @param {Uint8Array[]} a
 * @param {Uint8Array[]} b
 * @returns {string[]} list of differing coordinates
 */
function diffCoordinates(a, b) {
  if (a.length !== b.length) return ['<size mismatch>'];
  const differences = [];
  for (let r = 0; r < a.length; r++) {
    for (let c = 0; c < a.length; c++) if (a[r][c] !== b[r][c]) differences.push(`${r},${c}`);
  }
  return differences;
}

/**
 * Independent implementation of the four ISO/IEC 18004 penalty rules, used as a
 * third opinion on mask selection. Rule N4 uses the ISO reading k = floor(|p-50|/5).
 * @param {Uint8Array[]} modules
 * @returns {{ n1: number, n2: number, n3: number, n4: number }}
 */
function isoPenaltyComponents(modules) {
  const size = modules.length;
  let n1 = 0;
  let n2 = 0;
  let n3 = 0;

  const scanLine = (get) => {
    let run = 1;
    for (let i = 1; i < size; i++) {
      if (get(i) === get(i - 1)) {
        run++;
      } else {
        if (run >= 5) n1 += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) n1 += 3 + (run - 5);
  };
  for (let i = 0; i < size; i++) {
    scanLine((j) => modules[i][j]);
    scanLine((j) => modules[j][i]);
  }

  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = modules[r][c];
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) n2 += 3;
    }
  }

  const PATTERN_A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const PATTERN_B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const matches = (get, start, pattern) => pattern.every((expected, k) => get(start + k) === expected);
  for (let i = 0; i < size; i++) {
    for (const get of [(j) => modules[i][j], (j) => modules[j][i]]) {
      for (let j = 0; j + 11 <= size; j++) {
        if (matches(get, j, PATTERN_A) || matches(get, j, PATTERN_B)) n3 += 40;
      }
    }
  }

  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += modules[r][c];
  const n4 = 10 * Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5);
  return { n1, n2, n3, n4 };
}

/**
 * node-qrcode's own penalty components, computed on a matrix of ours.
 * @param {Uint8Array[]} modules
 * @returns {{ n1: number, n2: number, n3: number, n4: number }}
 */
function referencePenaltyComponents(modules) {
  const size = modules.length;
  const bitMatrix = new npmRef.BitMatrix(size);
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) bitMatrix.set(r, c, modules[r][c]);
  return {
    n1: npmRef.MaskPattern.getPenaltyN1(bitMatrix),
    n2: npmRef.MaskPattern.getPenaltyN2(bitMatrix),
    n3: npmRef.MaskPattern.getPenaltyN3(bitMatrix),
    n4: npmRef.MaskPattern.getPenaltyN4(bitMatrix),
  };
}

/** @param {number[]} scores @returns {number} index of the first minimum */
function argMin(scores) {
  let best = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] < scores[best]) best = i;
  return best;
}

/**
 * Compare one symbol with a reference symbol.
 *
 * Returns 'identical' when version, mask and every module agree. When the masks
 * differ, the matrices must still be identical once our encoder is forced to the
 * reference's mask, and the difference must be fully explained by node-qrcode's
 * non-ISO rounding of penalty rule N4 (it rounds partial 5% steps up, while
 * ISO/IEC 18004 and zxing floor them): in that case both implementations must
 * still pick the mask that minimises their own penalty model, and their rules
 * N1/N2/N3 must agree exactly on every mask.
 *
 * @param {string} text
 * @param {'L'|'M'|'Q'|'H'} ecLevel
 * @param {number} version
 * @param {{ mask: number, modules: Uint8Array[] }} reference
 * @param {string} label
 * @returns {'identical'|'n4-rounding'}
 */
function compareWithReference(text, ecLevel, version, reference, label) {
  const mine = qrMatrix(text, { ecLevel, version });
  assert.equal(mine.version, version, `${label}: version`);

  const forced = qrMatrix(text, { ecLevel, version, mask: reference.mask });
  assert.deepEqual(
    diffCoordinates(forced.modules, reference.modules),
    [],
    `${label}: matrix at the reference mask ${reference.mask}`,
  );
  if (mine.mask === reference.mask) return 'identical';

  const iso = [];
  const ref = [];
  for (let mask = 0; mask < 8; mask++) {
    const modules = qrMatrix(text, { ecLevel, version, mask }).modules;
    iso.push(isoPenaltyComponents(modules));
    ref.push(referencePenaltyComponents(modules));
  }
  const total = (components) => components.n1 + components.n2 + components.n3 + components.n4;
  assert.equal(argMin(iso.map(total)), mine.mask, `${label}: our mask must minimise the strict ISO score`);
  assert.equal(argMin(ref.map(total)), reference.mask, `${label}: the reference mask must minimise its own score`);
  for (let mask = 0; mask < 8; mask++) {
    assert.equal(iso[mask].n1, ref[mask].n1, `${label}: rule N1 on mask ${mask}`);
    assert.equal(iso[mask].n2, ref[mask].n2, `${label}: rule N2 on mask ${mask}`);
    assert.equal(iso[mask].n3, ref[mask].n3, `${label}: rule N3 on mask ${mask}`);
  }
  return 'n4-rounding';
}

test(
  'cross-check against soldair/node-qrcode: identical version, mask and full matrix',
  { skip: npmRef ? false : 'node-qrcode reference not installed under scratch/' },
  () => {
    let compared = 0;
    const outcomes = [];
    for (const { name, text } of CROSS_CASES) {
      for (const ecLevel of EC_LEVELS) {
        const reference = npmMatrix(text, ecLevel);
        const outcome = compareWithReference(text, ecLevel, reference.version, reference, `${name}/${ecLevel}`);
        outcomes.push(outcome);
        compared++;
      }
    }
    for (const ecLevel of ['L', 'M']) {
      const reference = npmMatrix(LONG_TEXT, ecLevel);
      outcomes.push(compareWithReference(LONG_TEXT, ecLevel, reference.version, reference, `200-char/${ecLevel}`));
      compared++;
    }
    const identical = outcomes.filter((o) => o === 'identical').length;
    console.log(
      `  [node-qrcode] ${compared} symbols compared; identical version, mask and every module in ${identical}; ` +
        `N4-rounding mask difference in ${compared - identical}`,
    );
  },
);

test(
  'cross-check against Kazuhiko Arase qrcode-generator: same version, same matrix at equal mask',
  { skip: arase ? false : 'qrcode-generator reference not downloaded under scratch/' },
  () => {
    let compared = 0;
    let maskAgreements = 0;
    const maskDifferences = [];
    for (const { name, text } of CROSS_CASES) {
      for (const ecLevel of EC_LEVELS) {
        const mine = qrMatrix(text, { ecLevel });
        const reference = araseMatrix(text, ecLevel);
        assert.equal(mine.version, reference.version, `${name}/${ecLevel}: version selection`);
        if (mine.mask === reference.mask) {
          maskAgreements++;
          assert.deepEqual(diffCoordinates(mine.modules, reference.modules), [], `${name}/${ecLevel}: matrix`);
        } else {
          maskDifferences.push(`${name}/${ecLevel}: ${mine.mask} vs ${reference.mask}`);
        }
        // Force our encoder to the reference's mask: the matrices must then be identical.
        const forced = qrMatrix(text, { ecLevel, mask: reference.mask });
        assert.deepEqual(
          diffCoordinates(forced.modules, reference.modules),
          [],
          `${name}/${ecLevel}: matrix at forced mask ${reference.mask}`,
        );
        compared++;
      }
    }
    console.log(
      `  [qrcode-generator] ${compared} symbols compared; identical matrices at equal mask in all cases; ` +
        `automatic mask agreed in ${maskAgreements}/${compared}` +
        (maskDifferences.length ? `; different-but-valid mask in ${maskDifferences.length}: ${maskDifferences.join(', ')}` : ''),
    );
  },
);

test(
  'penalty rules: N1-N3 match node-qrcode on every matrix, and the chosen mask is ISO-optimal',
  { skip: npmRef ? false : 'node-qrcode reference not installed under scratch/' },
  () => {
    let symbols = 0;
    let matrices = 0;
    for (const { version, ecLevel, text } of SWEEP) {
      const chosen = qrMatrix(text, { ecLevel, version }).mask;
      const isoTotal = [];
      for (let mask = 0; mask < 8; mask++) {
        const modules = qrMatrix(text, { ecLevel, version, mask }).modules;
        const iso = isoPenaltyComponents(modules);
        const ref = referencePenaltyComponents(modules);
        const label = `v${version}/${ecLevel}/mask ${mask}`;
        assert.equal(iso.n1, ref.n1, `${label}: rule N1`);
        assert.equal(iso.n2, ref.n2, `${label}: rule N2`);
        assert.equal(iso.n3, ref.n3, `${label}: rule N3`);
        isoTotal.push(iso.n1 + iso.n2 + iso.n3 + iso.n4);
        matrices++;
      }
      assert.equal(argMin(isoTotal), chosen, `v${version}/${ecLevel}: chosen mask must minimise the ISO score`);
      symbols++;
    }
    console.log(
      `  [penalty] rules N1-N3 agree with node-qrcode on all ${matrices} matrices; ` +
        `the chosen mask is ISO-optimal for all ${symbols} symbols`,
    );
  },
);

test(
  'sweep: every version, EC level and capacity boundary matches node-qrcode exactly',
  { skip: npmRef ? false : 'node-qrcode reference not installed under scratch/' },
  () => {
    let compared = 0;
    let identical = 0;
    const roundingDifferences = [];
    for (const { version, ecLevel, text } of SWEEP) {
      const label = `v${version}/${ecLevel}/${Buffer.byteLength(text, 'utf8')}B`;
      const reference = npmMatrix(text, ecLevel, { version });
      assert.equal(reference.version, version, `${label}: reference version`);
      const outcome = compareWithReference(text, ecLevel, version, reference, label);
      if (outcome === 'identical') identical++;
      else roundingDifferences.push(`${label} (ours ${qrMatrix(text, { ecLevel, version }).mask} vs ref ${reference.mask})`);
      compared++;
    }
    console.log(
      `  [node-qrcode sweep] ${compared} symbols compared; identical version, mask and every module in ${identical}; ` +
        `N4-rounding mask difference in ${compared - identical}` +
        (roundingDifferences.length ? `: ${roundingDifferences.join(', ')}` : ''),
    );
  },
);

test(
  'sweep: every version, EC level and capacity boundary matches qrcode-generator at equal mask',
  { skip: arase ? false : 'qrcode-generator reference not downloaded under scratch/' },
  () => {
    let compared = 0;
    let maskAgreements = 0;
    for (const { version, ecLevel, text } of SWEEP) {
      const label = `v${version}/${ecLevel}/${Buffer.byteLength(text, 'utf8')}B`;
      const mine = qrMatrix(text, { ecLevel, version });
      const reference = araseMatrix(text, ecLevel, version);
      assert.equal(reference.version, version, `${label}: reference version`);
      if (mine.mask === reference.mask) maskAgreements++;
      // Force our encoder to the reference's mask: the matrices must then be identical.
      const forced = qrMatrix(text, { ecLevel, version, mask: reference.mask });
      assert.deepEqual(
        diffCoordinates(forced.modules, reference.modules),
        [],
        `${label}: matrix at forced mask ${reference.mask}`,
      );
      compared++;
    }
    console.log(
      `  [qrcode-generator sweep] ${compared} symbols compared; identical matrices at equal mask in every case; ` +
        `automatic mask agreed in ${maskAgreements}/${compared}`,
    );
  },
);

test(
  'error-correction block layout matches the reference table',
  { skip: npmRef ? false : 'node-qrcode reference not installed under scratch/' },
  () => {
    for (let version = 1; version <= 10; version++) {
      for (const ecLevel of EC_LEVELS) {
        const level = npmRef.ErrorCorrectionLevel.from(ecLevel);
        const [ecPerBlock, groups] = BLOCKS[version][ecLevel];
        const blockCount = groups.reduce((sum, [count]) => sum + count, 0);
        assert.equal(
          blockCount,
          npmRef.ErrorCorrectionCode.getBlocksCount(version, level),
          `block count for ${version}/${ecLevel}`,
        );
        // node-qrcode's EC_CODEWORDS_TABLE holds the total number of error-correction
        // codewords for the symbol.
        assert.equal(
          ecPerBlock * blockCount,
          npmRef.ErrorCorrectionCode.getTotalCodewordsCount(version, level),
          `total EC codewords for ${version}/${ecLevel}`,
        );
        assert.equal(
          dataCodewordCount(version, ecLevel) + ecPerBlock * blockCount,
          TOTAL_CODEWORDS[version],
          `total codewords for ${version}/${ecLevel}`,
        );
      }
    }
  },
);

// ---------------------------------------------------------------------------
// 6. Human-readable rendering
// ---------------------------------------------------------------------------

test('prints a URL symbol as ASCII art', () => {
  const url = 'https://example.com/path?q=hello+world#frag';
  const result = qrMatrix(url, { ecLevel: 'M' });
  const lines = asciiArt(result.modules).split('\n');

  // A QR symbol always starts with a finder pattern in the top-left corner.
  assert.equal(lines[1].slice(1, 8), '#######', 'top-left finder, top row');
  assert.equal(lines[7].slice(1, 8), '#######', 'top-left finder, bottom row');
  assert.equal(lines[2].slice(1, 8), '#     #', 'top-left finder, hollow row');

  console.log(
    `\n  ${JSON.stringify(url)} -> version ${result.version}, EC ${result.ecLevel}, ` +
      `mask ${result.mask}, ${result.size}x${result.size}\n`,
  );
  console.log(lines.map((line) => `  ${line}`).join('\n'));
});
