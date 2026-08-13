/**
 * Browser half of the passphrase rules.
 *
 * `passphraseProblem` MUST stay identical to
 * `apps/node-backend/src/auth/passphrase.ts`; the server enforces it and will
 * reject anything this misses, so drift shows up as a form that submits and
 * then fails.
 *
 * `estimateStrength` has no server counterpart. It is guidance only: it shapes
 * what people choose, but it never decides what is accepted.
 */

export const MIN_PASSPHRASE_LENGTH = 12

const DENYLIST = new Set([
  'password',
  'password1',
  'password12',
  'password123',
  'password1234',
  'passw0rd123',
  'letmein',
  'letmein123',
  'qwertyuiop',
  'qwerty12345',
  'administrator',
  'iloveyou123',
  'welcome1234',
  'welcome12345',
  'trustno1234',
  'monkey123456',
  'dragon123456',
  'baseball1234',
  'football1234',
  'superman1234',
  'sunshine1234',
  'princess1234',
  'starwars1234',
  'whatever1234',
  'freedom12345',
  'computer1234',
  'changeme1234',
  'secret123456',
  'abcd12345678',
  'abcdefghijkl',
  '123456789012',
  '1234567890123',
  'qwertyuiop123',
  'thisisapassword',
  'correcthorsebatterystaple',
  'tridentagent',
  'trident12345',
  'tridentwallet',
  'myagentwallet',
  'agentwallet1',
])

function normalise(passphrase: string): string {
  return passphrase.toLowerCase().replace(/[\s\-_.!]/g, '')
}

export function passphraseProblem(passphrase: string): string | null {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    return `Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`
  }
  const flat = normalise(passphrase)
  if (DENYLIST.has(flat)) {
    return 'That passphrase is one of the first an attacker would try. Choose another.'
  }
  if (new Set(flat).size < 5) {
    return 'Passphrase repeats too few distinct characters. Choose something less repetitive.'
  }
  return null
}

export type StrengthLevel = 'weak' | 'fair' | 'good' | 'strong'

export interface Strength {
  bits: number
  level: StrengthLevel
  /** What would most improve this particular passphrase. */
  hint: string
}

/**
 * A conservative estimate of guessing difficulty, in bits.
 *
 * Deliberately pessimistic. A character-pool calculation says "correct horse
 * battery staple" is worth 130-odd bits, which is nonsense; nobody guesses it
 * character by character. So anything that looks like words is also costed as
 * words, at roughly 11 bits each (a generous view of how unpredictable a
 * human-chosen word is), and the lower of the two estimates wins.
 *
 * This is a heuristic, not a breach-corpus lookup. It is labelled "estimated"
 * in the UI for that reason. A real zxcvbn-style check would be better and
 * would cost a sizeable dependency on the auth bundle.
 */
export function estimateStrength(passphrase: string): Strength {
  if (!passphrase) return { bits: 0, level: 'weak', hint: '' }

  // "hunter2hunter2" is one guess for an attacker who tries doubled words, but
  // fourteen characters to a naive length calculation. Cost a repeated string
  // as the unit it repeats.
  const effectiveLength = repeatingUnit(passphrase).length
  const charsetBits = effectiveLength * Math.log2(poolSize(passphrase))

  // Word-shaped: three or more alphabetic runs of real length.
  const words = passphrase.split(/[^A-Za-z]+/).filter((w) => w.length >= 3)
  const wordBits = words.length >= 3 ? words.length * 11 : Infinity

  // Long runs of one character add length without adding difficulty.
  const distinctRatio = new Set(passphrase.toLowerCase()).size / passphrase.length
  const repetitionPenalty = distinctRatio < 0.5 ? 0.6 : 1

  const bits = Math.round(Math.min(charsetBits, wordBits) * repetitionPenalty)

  return { bits, level: levelFor(bits), hint: hintFor(passphrase, words.length, bits) }
}

/**
 * The shortest string that, repeated, produces the whole input, or the input
 * itself when it does not repeat.
 */
function repeatingUnit(passphrase: string): string {
  const lower = passphrase.toLowerCase()
  for (let size = 1; size <= lower.length / 2; size += 1) {
    if (lower.length % size !== 0) continue
    const unit = lower.slice(0, size)
    if (unit.repeat(lower.length / size) === lower) return unit
  }
  return passphrase
}

function poolSize(passphrase: string): number {
  let pool = 0
  if (/[a-z]/.test(passphrase)) pool += 26
  if (/[A-Z]/.test(passphrase)) pool += 26
  if (/[0-9]/.test(passphrase)) pool += 10
  if (/[^A-Za-z0-9]/.test(passphrase)) pool += 33
  return Math.max(pool, 2)
}

/**
 * Banded against what an offline attacker can actually do here. At PBKDF2
 * guess rates of roughly 10^4-10^5 per second per GPU, 40 bits falls to a
 * determined attacker, 55 is uncomfortable, and 70 is out of reach even for a
 * large cluster. The old thresholds called a solid four-word passphrase "weak",
 * which pushed people back towards short clever strings, the opposite of the
 * point.
 */
function levelFor(bits: number): StrengthLevel {
  if (bits < 40) return 'weak'
  if (bits < 55) return 'fair'
  if (bits < 70) return 'good'
  return 'strong'
}

function hintFor(passphrase: string, wordCount: number, bits: number): string {
  if (bits >= 70) return 'Strong enough to resist offline guessing.'
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    return `${MIN_PASSPHRASE_LENGTH - passphrase.length} more characters needed.`
  }
  if (wordCount >= 3) return 'Add another word. Each one roughly doubles the work twice over.'
  return 'Four or five unrelated words beat a short complicated string, and are easier to remember.'
}
