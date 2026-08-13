/**
 * The Trident brand mark.
 *
 * A PNG rather than inline SVG because the artwork carries its own blue
 * gradient, it is not a single-colour glyph, so `currentColor` does not apply.
 * The asset is a square canvas with the mark centred, so a caller passing equal
 * width and height classes gets the correct aspect ratio without extra styling.
 */
export function TridentMark({ className = '' }: { className?: string }) {
  return (
    <img
      src="/trident-mark.png"
      alt=""
      aria-hidden="true"
      draggable={false}
      className={`select-none object-contain ${className}`}
    />
  )
}
