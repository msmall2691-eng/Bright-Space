/**
 * Tiny QR encoder for the crew card's "join the house WiFi" QR.
 *
 * Why hand-vendored: the only consumer is one QR on the crew job card, and a
 * QR library is a dependency someone has to maintain alone (see the frontend
 * skill's dependency bar). This is a minimal, well-trodden subset of the QR
 * spec — byte mode only, ECC level M, versions 1–10 (up to 213 bytes, far
 * beyond any WIFI: string) — following the same algorithm as Nayuki's
 * public-domain qrcodegen, including proper mask selection.
 *
 * SECURITY: everything here is client-side maths on credentials the crew
 * payload already served to the assigned cleaner. Nothing is fetched, logged,
 * or put in a URL.
 */

// ── WIFI: payload ────────────────────────────────────────────────────────────

/** Escape a field for the WIFI: URI scheme: backslash-escape \ ; , " : */
export function escapeWifiField(s) {
  return String(s).replace(/([\\;,":])/g, '\\$1')
}

/** The standard WiFi-join QR payload (understood by iOS + Android cameras).
 *  T:WPA covers WPA/WPA2/WPA3-personal, which is every rental router. */
export function wifiQrPayload(ssid, password) {
  if (!ssid) return null
  if (!password) return `WIFI:T:nopass;S:${escapeWifiField(ssid)};;`
  return `WIFI:T:WPA;S:${escapeWifiField(ssid)};P:${escapeWifiField(password)};;`
}

// ── QR encoding (byte mode, ECC M, versions 1–10) ────────────────────────────

// Per-version tables for ECC level M, versions 1..10 (index 0 = version 1).
const TOTAL_CODEWORDS = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346]
const ECC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26]
const NUM_BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5]
const ALIGN_POS = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
]

// GF(256) multiply, reducing by the QR polynomial 0x11D.
function gfMul(x, y) {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}

function rsDivisor(degree) {
  const result = new Array(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root)
      if (j + 1 < degree) result[j] ^= result[j + 1]
    }
    root = gfMul(root, 2)
  }
  return result
}

function rsRemainder(data, divisor) {
  const result = new Array(divisor.length).fill(0)
  for (const b of data) {
    const factor = b ^ result.shift()
    result.push(0)
    for (let i = 0; i < divisor.length; i++) result[i] ^= gfMul(divisor[i], factor)
  }
  return result
}

const getBit = (x, i) => ((x >>> i) & 1) !== 0

/** Byte-mode segment + padding → data codewords for `version`, or null if the
 *  bytes don't fit. */
function makeDataCodewords(bytes, version) {
  const vi = version - 1
  const dataCw = TOTAL_CODEWORDS[vi] - ECC_PER_BLOCK[vi] * NUM_BLOCKS[vi]
  const countBits = version <= 9 ? 8 : 16
  if (4 + countBits + bytes.length * 8 > dataCw * 8) return null

  const bits = []
  const appendBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1)
  }
  appendBits(4, 4)                    // byte-mode indicator 0100
  appendBits(bytes.length, countBits)
  for (const b of bytes) appendBits(b, 8)
  appendBits(0, Math.min(4, dataCw * 8 - bits.length))       // terminator
  appendBits(0, (8 - (bits.length % 8)) % 8)                 // byte align
  for (let pad = 0xec; bits.length < dataCw * 8; pad ^= 0xec ^ 0x11) {
    appendBits(pad, 8)
  }
  const out = []
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]
    out.push(b)
  }
  return out
}

/** Split data into blocks, compute ECC, interleave — the final codeword
 *  sequence placed into the matrix. */
function addEccAndInterleave(data, version) {
  const vi = version - 1
  const numBlocks = NUM_BLOCKS[vi]
  const blockEccLen = ECC_PER_BLOCK[vi]
  const rawCodewords = TOTAL_CODEWORDS[vi]
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks)
  const shortBlockLen = Math.floor(rawCodewords / numBlocks)

  const blocks = []
  const div = rsDivisor(blockEccLen)
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1))
    k += dat.length
    const ecc = rsRemainder(dat, div)
    if (i < numShortBlocks) dat.push(0)
    blocks.push(dat.concat(ecc))
  }
  const result = []
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i])
    })
  }
  return result
}

// Mask predicates: module (x, y) is flipped when the predicate is true.
const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]

class QrBuilder {
  constructor(version) {
    this.version = version
    this.size = version * 4 + 17
    this.modules = Array.from({ length: this.size }, () => new Array(this.size).fill(false))
    this.isFunction = Array.from({ length: this.size }, () => new Array(this.size).fill(false))
  }

  setFunction(x, y, dark) {
    this.modules[y][x] = dark
    this.isFunction[y][x] = true
  }

  drawFunctionPatterns() {
    const { size, version } = this
    for (let i = 0; i < size; i++) {         // timing patterns
      this.setFunction(6, i, i % 2 === 0)
      this.setFunction(i, 6, i % 2 === 0)
    }
    this.drawFinder(3, 3)
    this.drawFinder(size - 4, 3)
    this.drawFinder(3, size - 4)

    const align = ALIGN_POS[version - 1]
    const n = align.length
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        // Skip the three corners occupied by finder patterns.
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue
        this.drawAlignment(align[i], align[j])
      }
    }
    this.drawFormatBits(0)   // placeholder: reserves the modules as functional
    this.drawVersionInfo()
  }

  drawFinder(cx, cy) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy))
        const x = cx + dx
        const y = cy + dy
        if (x >= 0 && x < this.size && y >= 0 && y < this.size) {
          this.setFunction(x, y, dist !== 2 && dist !== 4)
        }
      }
    }
  }

  drawAlignment(cx, cy) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
      }
    }
  }

  drawFormatBits(mask) {
    // ECC level M has format bits 00; append the mask, then the 10 BCH bits.
    const data = (0 << 3) | mask
    let rem = data
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const bits = ((data << 10) | rem) ^ 0x5412

    for (let i = 0; i <= 5; i++) this.setFunction(8, i, getBit(bits, i))
    this.setFunction(8, 7, getBit(bits, 6))
    this.setFunction(8, 8, getBit(bits, 7))
    this.setFunction(7, 8, getBit(bits, 8))
    for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, getBit(bits, i))

    const { size } = this
    for (let i = 0; i < 8; i++) this.setFunction(size - 1 - i, 8, getBit(bits, i))
    for (let i = 8; i < 15; i++) this.setFunction(8, size - 15 + i, getBit(bits, i))
    this.setFunction(8, size - 8, true)   // the always-dark module
  }

  drawVersionInfo() {
    const { version, size } = this
    if (version < 7) return
    let rem = version
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const bits = (version << 12) | rem
    for (let i = 0; i < 18; i++) {
      const dark = getBit(bits, i)
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      this.setFunction(a, b, dark)
      this.setFunction(b, a, dark)
    }
  }

  drawCodewords(data) {
    const { size } = this
    let i = 0
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j
          const upward = ((right + 1) & 2) === 0
          const y = upward ? size - 1 - vert : vert
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = getBit(data[i >> 3], 7 - (i & 7))
            i++
          }
        }
      }
    }
  }

  applyMask(mask) {
    const fn = MASKS[mask]
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (!this.isFunction[y][x] && fn(x, y)) this.modules[y][x] = !this.modules[y][x]
      }
    }
  }

  penaltyScore() {
    const { modules: m, size } = this
    let score = 0
    const line = new Array(size)

    // Rules 1 (runs ≥5) and 3 (finder-lookalike 1011101 with 0000 wing),
    // applied to every row and every column.
    for (let pass = 0; pass < 2; pass++) {
      for (let a = 0; a < size; a++) {
        for (let b = 0; b < size; b++) line[b] = pass === 0 ? m[a][b] : m[b][a]
        let run = 1
        for (let b = 1; b <= size; b++) {
          if (b < size && line[b] === line[b - 1]) run++
          else {
            if (run >= 5) score += 3 + (run - 5)
            run = 1
          }
        }
        for (let b = 0; b + 11 <= size; b++) {
          const w = line.slice(b, b + 11).map(Boolean)
          const p1 = [true, false, true, true, true, false, true, false, false, false, false]
          const p2 = [false, false, false, false, true, false, true, true, true, false, true]
          if (p1.every((v, k) => v === w[k]) || p2.every((v, k) => v === w[k])) score += 40
        }
      }
    }
    // Rule 2: 2×2 blocks of the same color.
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = m[y][x]
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3
      }
    }
    // Rule 4: dark-module proportion.
    let dark = 0
    for (const row of m) for (const cell of row) if (cell) dark++
    score += 10 * Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5)
    return score
  }
}

/**
 * Encode `text` (UTF-8) → boolean matrix (array of rows; true = dark module).
 * Returns null when the text is too long for version 10 or anything fails —
 * the caller simply doesn't show a QR.
 */
export function qrMatrix(text) {
  try {
    const bytes = Array.from(new TextEncoder().encode(text))
    let version = null
    let data = null
    for (let v = 1; v <= 10; v++) {
      data = makeDataCodewords(bytes, v)
      if (data) { version = v; break }
    }
    if (!version) return null

    const codewords = addEccAndInterleave(data, version)
    const qr = new QrBuilder(version)
    qr.drawFunctionPatterns()
    qr.drawCodewords(codewords)

    // Pick the mask with the lowest penalty (spec-required selection).
    let best = 0
    let bestScore = Infinity
    for (let mask = 0; mask < 8; mask++) {
      qr.applyMask(mask)
      qr.drawFormatBits(mask)
      const score = qr.penaltyScore()
      if (score < bestScore) { bestScore = score; best = mask }
      qr.applyMask(mask)   // XOR twice = undo
    }
    qr.applyMask(best)
    qr.drawFormatBits(best)
    return qr.modules
  } catch {
    return null
  }
}

/** SVG path ("d") covering every dark module at 1 unit per module — render
 *  inside a viewBox of `size × size` (add your own quiet-zone margin). */
export function qrSvgPath(matrix) {
  const parts = []
  for (let y = 0; y < matrix.length; y++) {
    for (let x = 0; x < matrix[y].length; x++) {
      if (matrix[y][x]) parts.push(`M${x} ${y}h1v1h-1z`)
    }
  }
  return parts.join('')
}
