/**
 * What counts as an acceptable agent-wallet passphrase.
 *
 * This is not a login password. It is the only thing standing between a leaked
 * database and every user's funds: the encrypted key, its salt and its IV all
 * sit in the same row, so an attacker who obtains the file can guess offline,
 * with no rate limit and no lockout. Guess rates against PBKDF2 are measured in
 * tens of thousands per second per GPU, so a password that would be fine behind
 * a login form is not fine here.
 *
 * The rule is deliberately blunt — a length floor plus a denylist — because it
 * has to be enforced identically on the server, and anything cleverer invites
 * drift between the two. The strength meter in the browser is guidance layered
 * on top; this is the part that cannot be bypassed.
 *
 * Mirrored in `apps/frontend/src/lib/passphrase.ts`. Keep them in step.
 */

/**
 * Twelve, not eight. Eight characters of human-chosen password falls to a
 * wordlist-and-rules attack in hours at these guess rates.
 */
export const MIN_PASSPHRASE_LENGTH = 12

/**
 * The passwords attackers try first. Not a substitute for a real breach corpus
 * — it exists to catch the handful of choices that a length floor alone would
 * happily accept, like "password1234".
 */
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
  // Ones this product invites specifically.
  'tridentagent',
  'trident12345',
  'tridentwallet',
  'myagentwallet',
  'agentwallet1',
])

/** Collapse the cosmetic variation attackers strip anyway before comparing. */
function normalise(passphrase: string): string {
  return passphrase.toLowerCase().replace(/[\s\-_.!]/g, '')
}

/**
 * The single reason this passphrase is unacceptable, or null if it passes.
 * Returns a message written for the person choosing it, not for a log.
 */
export function passphraseProblem(passphrase: string): string | null {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    return `Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`
  }

  const flat = normalise(passphrase)

  if (DENYLIST.has(flat)) {
    return 'That passphrase is one of the first an attacker would try. Choose another.'
  }

  // "aaaaaaaaaaaa" clears twelve characters and is worth about two.
  if (new Set(flat).size < 5) {
    return 'Passphrase repeats too few distinct characters. Choose something less repetitive.'
  }

  return null
}
