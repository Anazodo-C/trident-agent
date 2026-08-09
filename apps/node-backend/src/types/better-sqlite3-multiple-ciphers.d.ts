/**
 * Types for `better-sqlite3-multiple-ciphers`, which ships none of its own.
 *
 * It is better-sqlite3 with SQLite3MultipleCiphers compiled in, so the surface
 * is exactly what @types/better-sqlite3 already describes — the additions are
 * cipher pragmas, which go through the existing untyped `pragma()` call.
 *
 * Wired up through `paths` in tsconfig rather than as an ambient `declare
 * module`: under NodeNext the specifier resolves to real untyped JS in
 * node_modules, and that resolution wins over an ambient declaration. `paths`
 * is typecheck-only, so the runtime still loads the real package.
 */
import type { Database, Options } from 'better-sqlite3'

declare const Ctor: new (filename: string, options?: Options) => Database
export default Ctor
export type { Database, Options }
