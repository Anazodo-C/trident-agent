/**
 * Message builders that exist twice, once per package, and must not drift.
 *
 * `buildRotationMessage` and `buildVerifierMessage` are duplicated in the
 * backend's `auth/keySetup.ts` and the browser's `lib/crypto.ts`, because the
 * browser signs the message and the server verifies it. A signature is over
 * exact bytes: one changed word, one reordered line, one different separator,
 * and verification fails for every user at once.
 *
 * Comments saying "MUST stay byte-identical" do not enforce anything. This does,
 * by importing both and comparing their output. No network, no credentials.
 *
 * Run with:  npm run test:cross-package -w @trident/node-backend
 */
import {
  buildRotationMessage as backendRotation,
  buildVerifierMessage as backendVerifier,
  derivePassphraseVerifier as backendDerive,
} from '../src/auth/keySetup.ts'
import {
  buildRotationMessage as browserRotation,
  buildVerifierMessage as browserVerifier,
  derivePassphraseVerifier as browserDerive,
} from '../../frontend/src/lib/crypto.ts'

let failures = 0

function check(label: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures += 1
    console.error(
      `  FAIL  ${label}\n        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`,
    )
  } else {
    console.log(`  ok    ${label}`)
  }
}

console.log('\n  signed messages agree across packages\n')

/* Values chosen to catch a separator or ordering slip: a userId containing the
 * same punctuation the format uses would hide a bad join. */
const cases = [
  { userId: 'user-1', encryptedKey: 'deadbeef', iterations: 600000 },
  { userId: 'user: with colon', encryptedKey: 'ab'.repeat(32), iterations: 200000 },
  { userId: 'multi\nline', encryptedKey: '00', iterations: 1 },
]

for (const c of cases) {
  check(
    `rotation message for ${JSON.stringify(c.userId)}`,
    browserRotation(c),
    backendRotation(c),
  )
}

for (const verifier of ['0'.repeat(64), 'a1b2c3'.padEnd(64, 'f')]) {
  for (const userId of ['user-1', 'user: with colon']) {
    check(
      `verifier message for ${JSON.stringify(userId)}`,
      browserVerifier({ userId, verifier }),
      backendVerifier({ userId, verifier }),
    )
  }
}

/* The formats must also stay distinct from each other, or a signature collected
 * for one purpose could be replayed for the other. */
check(
  'a rotation signature cannot be replayed as a verifier one',
  backendRotation({ userId: 'u', encryptedKey: 'x', iterations: 1 }) ===
    backendVerifier({ userId: 'u', verifier: 'x' }),
  false,
)

/* Both must bind the userId, or one account's signature would work on another. */
check(
  'rotation binds the user',
  backendRotation({ userId: 'a', encryptedKey: 'x', iterations: 1 }) !==
    backendRotation({ userId: 'b', encryptedKey: 'x', iterations: 1 }),
  true,
)
check(
  'verifier binds the user',
  backendVerifier({ userId: 'a', verifier: 'x' }) !== backendVerifier({ userId: 'b', verifier: 'x' }),
  true,
)
check(
  'verifier binds the value being installed',
  backendVerifier({ userId: 'a', verifier: 'x' }) !== backendVerifier({ userId: 'a', verifier: 'y' }),
  true,
)

console.log('\n  the passphrase verifier derives identically in both packages\n')

/*
 * The server derives this at signup, the browser re-derives it at every unlock,
 * and they must agree exactly. A mismatch does not fail loudly: it rejects the
 * correct passphrase, for every user, with no way to tell why.
 *
 * Deliberately low iteration counts here. The real one is 600,000 and would
 * make this suite take minutes; the derivation is identical either way.
 */
{
  const cases: [string, string, number][] = [
    ['correct horse battery staple', 'a1b2c3d4e5f60718', 1000],
    ['short', '00'.repeat(32), 2048],
    // Non-ASCII: the two sides encode the passphrase separately, so a UTF-8
    // handling difference would only ever show up on input like this.
    ['pässwörd with ünicode 🔑', 'ff'.repeat(16), 1500],
    ['', 'deadbeef', 1000],
  ]
  for (const [passphrase, salt, iterations] of cases) {
    const expected = backendDerive(passphrase, salt, iterations)
    check(
      `verifier for ${JSON.stringify(passphrase.slice(0, 20))}`,
      await browserDerive(passphrase, salt, iterations),
      expected,
    )
    check(`  and it is 32 bytes of hex`, /^[0-9a-f]{64}$/.test(expected), true)
  }

  /* Each input must actually matter, or the check is not checking. */
  check(
    'a different passphrase gives a different verifier',
    backendDerive('a', 'aa', 1000) !== backendDerive('b', 'aa', 1000),
    true,
  )
  check(
    'a different salt gives a different verifier',
    backendDerive('a', 'aa', 1000) !== backendDerive('a', 'bb', 1000),
    true,
  )
  check(
    'a different iteration count gives a different verifier',
    backendDerive('a', 'aa', 1000) !== backendDerive('a', 'aa', 1001),
    true,
  )
}

console.log(failures === 0 ? '\nall cross-package tests passed\n' : `\n${failures} FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
