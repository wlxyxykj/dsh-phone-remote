/**
 * Dependency-free QR Code encoder (ISO/IEC 18004).
 *
 * Scope: byte mode (UTF-8) only, error-correction levels L/M/Q/H, versions 1..10,
 * automatic selection of the smallest version that fits and of the data mask that
 * minimises the standard four penalty rules.
 *
 * No npm dependencies, no build step — plain Node.js ESM.
 *
 * @module qr
 */

// ---------------------------------------------------------------------------
// GF(256) arithmetic — primitive polynomial 0x11D = x^8 + x^4 + x^3 + x^2 + 1
// ---------------------------------------------------------------------------

/** @type {Uint8Array} antilog table, doubled so index sums never need a modulo. */
const GF_EXP = new Uint8Array(512);
/** @type {Uint8Array} discrete logarithm table (GF_LOG[0] is unused / zero). */
const GF_LOG = new Uint8Array(256);

for (let i = 0, x = 1; i < 255; i++) {
  GF_EXP[i] = x;
  GF_LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];

/**
 * Multiply two elements of GF(256).
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/**
 * Multiply two polynomials with coefficients in GF(256).
 * Coefficients are ordered from the highest degree term to the constant term.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number[]}
 */
function polyMul(a, b) {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) out[i + j] ^= gfMul(a[i], b[j]);
  }
  return out;
}

/**
 * Build the standard Reed-Solomon generator polynomial of the given degree,
 * i.e. the product of (x - a^i) for i = 0 .. degree-1.
 * @param {number} degree number of error-correction codewords
 * @returns {number[]} coefficients, highest degree first, length degree + 1
 */
function rsGeneratorPoly(degree) {
  let g = [1];
  for (let i = 0; i < degree; i++) g = polyMul(g, [1, GF_EXP[i]]);
  return g;
}

/** Cache of generator polynomials, keyed by degree (max is 30 for versions <= 10). */
const GENERATOR_CACHE = new Map();

/**
 * Compute the Reed-Solomon error-correction codewords for one block.
 * @param {Uint8Array} data data codewords of the block
 * @param {number} ecLen number of error-correction codewords to produce
 * @returns {Uint8Array} ecLen error-correction codewords
 */
function rsEncode(data, ecLen) {
  let gen = GENERATOR_CACHE.get(ecLen);
  if (!gen) {
    gen = rsGeneratorPoly(ecLen);
    GENERATOR_CACHE.set(ecLen, gen);
  }
  // Polynomial long division of data * x^ecLen by the generator polynomial.
  const rem = new Uint8Array(data.length + ecLen);
  rem.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = rem[i];
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j++) rem[i + j] ^= gfMul(gen[j], factor);
  }
  return rem.slice(data.length);
}

// ---------------------------------------------------------------------------
// Version / error-correction tables (ISO/IEC 18004 tables 13-22)
// ---------------------------------------------------------------------------

/** Supported error-correction levels, weakest to strongest. */
const EC_LEVELS = /** @type {const} */ (['L', 'M', 'Q', 'H']);

/**
 * Error-correction block layout per version and level.
 * Shape: [ecCodewordsPerBlock, [[blockCount, dataCodewordsPerBlock], ...]].
 * Blocks are listed from the shortest data length to the longest, as required
 * by the interleaving order of the standard.
 * @type {Record<number, Record<'L'|'M'|'Q'|'H', [number, number[][]]>>}
 */
const EC_BLOCKS = {
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

/** Highest version supported by this module. */
const MAX_VERSION = 10;

/** Alignment-pattern centre coordinates per version (empty for version 1). */
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

/** Two-bit error-correction level indicator used inside the format information. */
const EC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

// ---------------------------------------------------------------------------
// BCH codes for format and version information
// ---------------------------------------------------------------------------

/**
 * Compute the 15-bit format information word: 5 data bits (2 EC level bits and
 * 3 mask bits) extended with a BCH(15,5) remainder and XORed with 0x5412.
 * @param {number} data 5-bit value
 * @returns {number} 15-bit format information
 */
function formatInfoBits(data) {
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

/**
 * Compute the 18-bit version information word for versions >= 7:
 * 6 version bits extended with a BCH(18,6) remainder.
 * @param {number} version 7..40
 * @returns {number} 18-bit version information
 */
function versionInfoBits(version) {
  let rem = version << 12;
  for (let i = 17; i >= 12; i--) {
    if ((rem >>> i) & 1) rem ^= 0x1f25 << (i - 12);
  }
  return (version << 12) | rem;
}

// ---------------------------------------------------------------------------
// Data encoding
// ---------------------------------------------------------------------------

/**
 * Encode a JavaScript string as UTF-8 bytes.
 * @param {string} text
 * @returns {Uint8Array}
 */
function utf8Encode(text) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text);
  return Uint8Array.from(Buffer.from(text, 'utf8'));
}

/**
 * Append the low `length` bits of `value` to `bits`, most significant bit first.
 * @param {number[]} bits
 * @param {number} value
 * @param {number} length
 */
function pushBits(bits, value, length) {
  for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

/**
 * Build the complete interleaved codeword sequence (data + error correction)
 * for one version and error-correction level.
 * @param {Uint8Array} bytes UTF-8 payload bytes
 * @param {number} version
 * @param {'L'|'M'|'Q'|'H'} ecLevel
 * @returns {number[]} final codewords in transmission order
 */
function buildCodewords(bytes, version, ecLevel) {
  const [ecPerBlock, groups] = EC_BLOCKS[version][ecLevel];
  const totalDataCodewords = groups.reduce((sum, [n, k]) => sum + n * k, 0);
  const capacityBits = totalDataCodewords * 8;
  // Byte mode: 4-bit mode indicator, then an 8-bit (v1-9) or 16-bit (v10+) count.
  const countBits = version <= 9 ? 8 : 16;
  const neededBits = 4 + countBits + bytes.length * 8;
  if (neededBits > capacityBits) {
    throw new Error(
      `qrMatrix: payload does not fit in version ${version} at EC level ${ecLevel} ` +
        `(need ${neededBits} bits, capacity ${capacityBits} bits)`,
    );
  }

  const bits = [];
  pushBits(bits, 0b0100, 4); // byte mode indicator
  pushBits(bits, bytes.length, countBits);
  for (const byte of bytes) pushBits(bits, byte, 8);

  pushBits(bits, 0, Math.min(4, capacityBits - bits.length)); // terminator
  while (bits.length % 8 !== 0) bits.push(0); // pad to codeword boundary

  const dataCodewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    dataCodewords.push(byte);
  }
  for (let i = 0; dataCodewords.length < totalDataCodewords; i++) {
    dataCodewords.push(i % 2 === 0 ? 0xec : 0x11); // standard pad codewords
  }

  // Split into blocks, add error correction, then interleave.
  const blocks = [];
  let offset = 0;
  for (const [blockCount, dataPerBlock] of groups) {
    for (let b = 0; b < blockCount; b++) {
      const data = Uint8Array.from(dataCodewords.slice(offset, offset + dataPerBlock));
      offset += dataPerBlock;
      blocks.push({ data, ec: rsEncode(data, ecPerBlock) });
    }
  }

  const out = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) {
    for (const block of blocks) if (i < block.data.length) out.push(block.data[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of blocks) out.push(block.ec[i]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Matrix construction
// ---------------------------------------------------------------------------

/** The eight standard data mask predicates, indexed 0..7. */
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
 * Build the final module matrix for a version, EC level, codeword sequence and mask.
 * @param {number} version
 * @param {'L'|'M'|'Q'|'H'} ecLevel
 * @param {number[]} codewords
 * @param {number} mask 0..7
 * @returns {{ size: number, modules: Uint8Array[] }}
 */
function buildMatrix(version, ecLevel, codewords, mask) {
  const size = version * 4 + 17;
  /** @type {Uint8Array[]} */
  const modules = [];
  /** @type {Uint8Array[]} 1 marks a module that belongs to a function pattern. */
  const isFunction = [];
  for (let r = 0; r < size; r++) {
    modules.push(new Uint8Array(size));
    isFunction.push(new Uint8Array(size));
  }

  const set = (row, col, dark) => {
    modules[row][col] = dark ? 1 : 0;
    isFunction[row][col] = 1;
  };
  const inBounds = (row, col) => row >= 0 && row < size && col >= 0 && col < size;

  // --- finder patterns and their separators (top-left, top-right, bottom-left)
  for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const row = r0 + dr;
        const col = c0 + dc;
        if (!inBounds(row, col)) continue;
        const inFinder = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const dark =
          inFinder &&
          (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        set(row, col, dark);
      }
    }
  }

  // --- timing patterns (row 6 and column 6), dark on even coordinates
  for (let i = 8; i <= size - 9; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  // --- alignment patterns, skipping the three that would overlap a finder
  const centers = ALIGNMENT_CENTERS[version];
  for (const row of centers) {
    for (const col of centers) {
      const overlapsFinder =
        (row <= 8 && col <= 8) || (row <= 8 && col >= size - 9) || (row >= size - 9 && col <= 8);
      if (overlapsFinder) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          // dark on the outer ring (Chebyshev distance 2) and at the centre
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          set(row + dr, col + dc, dark);
        }
      }
    }
  }

  // --- reserve the format information areas (values are written after masking)
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      set(8, i, false);
      set(i, 8, false);
    }
  }
  for (let i = 0; i < 8; i++) set(8, size - 1 - i, false);
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, false);

  // --- version information for versions >= 7
  if (version >= 7) {
    const bits = versionInfoBits(version);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(b, a, dark);
      set(a, b, dark);
    }
  }

  // --- dark module (always dark), at (4 * version + 9, 8) = (size - 8, 8)
  set(size - 8, 8, true);

  // --- place the data bits in the standard two-module-wide zigzag, applying the mask
  const maskFn = MASK_FUNCTIONS[mask];
  const totalBits = codewords.length * 8;
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing column
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const col = right - j;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - vert : vert;
        if (isFunction[row][col]) continue;
        // Remainder bits beyond the codeword stream are light before masking.
        const bit =
          bitIndex < totalBits ? (codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1 : 0;
        bitIndex++;
        modules[row][col] = bit ^ (maskFn(row, col) ? 1 : 0);
      }
    }
  }

  // --- write the format information for the chosen mask (both copies)
  const formatBits = formatInfoBits((EC_FORMAT_BITS[ecLevel] << 3) | mask);
  for (let i = 0; i < 15; i++) {
    const dark = ((formatBits >>> i) & 1) === 1;
    // copy 1: around the top-left finder
    if (i < 6) modules[i][8] = dark ? 1 : 0;
    else if (i === 6) modules[7][8] = dark ? 1 : 0;
    else if (i === 7) modules[8][8] = dark ? 1 : 0;
    else if (i === 8) modules[8][7] = dark ? 1 : 0;
    else modules[8][14 - i] = dark ? 1 : 0;
    // copy 2: split between the bottom-left and top-right finders
    if (i < 8) modules[8][size - 1 - i] = dark ? 1 : 0;
    else modules[size - 15 + i][8] = dark ? 1 : 0;
  }

  return { size, modules };
}

// ---------------------------------------------------------------------------
// Mask evaluation (ISO/IEC 18004 penalty rules N1..N4)
// ---------------------------------------------------------------------------

/**
 * Compute the total penalty score of a matrix under the four standard rules.
 * @param {Uint8Array[]} modules
 * @param {number} size
 * @returns {number}
 */
function penaltyScore(modules, size) {
  let penalty = 0;

  // Rule 1: runs of five or more same-coloured modules in a row or column.
  for (let i = 0; i < size; i++) {
    for (const line of [modules[i], modules.map((row) => row[i])]) {
      let runLength = 1;
      for (let j = 1; j < size; j++) {
        if (line[j] === line[j - 1]) {
          runLength++;
        } else {
          if (runLength >= 5) penalty += 3 + (runLength - 5);
          runLength = 1;
        }
      }
      if (runLength >= 5) penalty += 3 + (runLength - 5);
    }
  }

  // Rule 2: 2x2 blocks of a single colour.
  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      const v = modules[row][col];
      if (v === modules[row][col + 1] && v === modules[row + 1][col] && v === modules[row + 1][col + 1]) {
        penalty += 3;
      }
    }
  }

  // Rule 3: finder-like 1:1:3:1:1 patterns with four light modules on one side.
  const PATTERN_A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const PATTERN_B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const matchesAt = (line, start, pattern) => {
    for (let k = 0; k < pattern.length; k++) if (line[start + k] !== pattern[k]) return false;
    return true;
  };
  for (let i = 0; i < size; i++) {
    const rowLine = modules[i];
    const colLine = modules.map((row) => row[i]);
    for (const line of [rowLine, colLine]) {
      for (let j = 0; j + 11 <= size; j++) {
        if (matchesAt(line, j, PATTERN_A) || matchesAt(line, j, PATTERN_B)) penalty += 40;
      }
    }
  }

  // Rule 4: deviation of the dark-module proportion from 50%.
  let dark = 0;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) dark += modules[row][col];
  }
  const total = size * size;
  const k = Math.floor(Math.abs((dark * 100) / total - 50) / 5);
  penalty += 10 * k;

  return penalty;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encode a string as a QR Code symbol in byte mode (UTF-8) and return its final
 * module matrix, including function patterns, format information, version
 * information and the selected data mask.
 *
 * The smallest version (1..10) that can hold the payload at the requested error
 * correction level is selected automatically.
 *
 * @param {string} text payload to encode; encoded as UTF-8 bytes
 * @param {object} [options]
 * @param {'L'|'M'|'Q'|'H'} [options.ecLevel='M'] error-correction level
 * @param {number} [options.version] force a specific version (1..10) instead of
 *   auto-selecting the smallest one that fits; throws if the payload does not fit
 * @param {boolean} [options.booleans=false] when true, return rows of booleans
 *   (true = dark) instead of rows of 0/1 bytes
 * @param {number} [options.mask] testing/advanced hook: force a data mask 0..7
 *   instead of choosing the one with the lowest penalty score
 * @returns {{ version: number, ecLevel: 'L'|'M'|'Q'|'H', size: number, mask: number, modules: Uint8Array[]|boolean[][] }}
 *   `modules` holds `size` rows of `size` modules; 1 (or true) means dark.
 * @throws {Error} if the payload does not fit in version 10 at the given EC level
 * @throws {TypeError} if `options.ecLevel`, `options.version` or `options.mask` is invalid
 */
export function qrMatrix(text, options = {}) {
  if (typeof text !== 'string') throw new TypeError('qrMatrix: text must be a string');

  const { booleans = false } = options;
  const ecLevel = options.ecLevel === undefined ? 'M' : options.ecLevel;
  if (!EC_LEVELS.includes(ecLevel)) {
    throw new TypeError(`qrMatrix: ecLevel must be one of ${EC_LEVELS.join(', ')}, got ${String(ecLevel)}`);
  }

  const bytes = utf8Encode(text);

  let version = options.version;
  if (version === undefined) {
    version = 0;
    for (let v = 1; v <= MAX_VERSION; v++) {
      const countBits = v <= 9 ? 8 : 16;
      const [, groups] = EC_BLOCKS[v][ecLevel];
      const capacityBits = groups.reduce((sum, [n, k]) => sum + n * k, 0) * 8;
      if (4 + countBits + bytes.length * 8 <= capacityBits) {
        version = v;
        break;
      }
    }
    if (version === 0) {
      throw new Error(
        `qrMatrix: payload of ${bytes.length} UTF-8 byte(s) does not fit in any supported version ` +
          `(1..${MAX_VERSION}) at EC level ${ecLevel}; reduce the payload or use a lower EC level`,
      );
    }
  } else if (!Number.isInteger(version) || version < 1 || version > MAX_VERSION) {
    throw new TypeError(`qrMatrix: version must be an integer in 1..${MAX_VERSION}, got ${String(version)}`);
  }

  const codewords = buildCodewords(bytes, version, ecLevel);

  let mask = options.mask;
  if (mask === undefined) {
    let bestScore = Infinity;
    mask = 0;
    for (let m = 0; m < 8; m++) {
      const { modules, size } = buildMatrix(version, ecLevel, codewords, m);
      const score = penaltyScore(modules, size);
      if (score < bestScore) {
        bestScore = score;
        mask = m;
      }
    }
  } else if (!Number.isInteger(mask) || mask < 0 || mask > 7) {
    throw new TypeError(`qrMatrix: mask must be an integer in 0..7, got ${String(mask)}`);
  }

  const { size, modules } = buildMatrix(version, ecLevel, codewords, mask);

  if (!booleans) return { version, ecLevel, size, mask, modules };

  const boolModules = modules.map((row) => Array.from(row, (v) => v === 1));
  return { version, ecLevel, size, mask, modules: boolModules };
}
