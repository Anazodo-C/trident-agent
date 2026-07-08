/** Shared turbo-mode flag. Set via POST /admin/turbo from the frontend. */
let _turbo = false;

export function isTurbo()          { return _turbo; }
export function setTurbo(v: boolean) { _turbo = v; console.log(`[Turbo] Mode ${v ? "🔥 ON" : "OFF"}`); }
