/**
 * A deterministic arithmetic evaluator for the responder's calculator tool.
 *
 * Financial figures must be exact. A model doing five-digit multiplication in
 * its head is not exact — in testing, 64999 x 0.8571 came back as three
 * different answers across three attempts, each wrong. So the model does not
 * do the arithmetic: it writes the expression, this evaluates it, and the
 * result it reports is the one computed here.
 *
 * Hand-written recursive descent rather than `eval` or `new Function`: this
 * evaluates strings composed by a model from third-party API payloads, and
 * that is not a place to hand over an execution context.
 */

export class ArithmeticError extends Error {}

type Token = { kind: 'number'; value: number } | { kind: 'op'; value: string }

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0

  while (i < input.length) {
    const char = input[i]!

    if (char === ' ' || char === '\t' || char === '_' || char === ',') {
      // Thousands separators and spacing are noise, not structure.
      i += 1
      continue
    }
    if (/[0-9.]/.test(char)) {
      let j = i
      while (j < input.length && /[0-9.,_]/.test(input[j]!)) j += 1
      const raw = input.slice(i, j).replace(/[,_]/g, '')
      const value = Number(raw)
      if (!Number.isFinite(value)) throw new ArithmeticError(`Not a number: ${raw}`)
      tokens.push({ kind: 'number', value })
      i = j
      continue
    }
    if ('+-*/%()^'.includes(char)) {
      tokens.push({ kind: 'op', value: char })
      i += 1
      continue
    }
    throw new ArithmeticError(`Unexpected character: ${char}`)
  }
  return tokens
}

/**
 * expression := term (('+' | '-') term)*
 * term       := power (('*' | '/' | '%') power)*
 * power      := unary ('^' power)?
 * unary      := ('-' | '+')? primary
 * primary    := number | '(' expression ')'
 */
function parse(tokens: Token[]): number {
  let pos = 0

  const peek = (): Token | undefined => tokens[pos]
  const eatOp = (...ops: string[]): string | null => {
    const token = peek()
    if (token?.kind === 'op' && ops.includes(token.value)) {
      pos += 1
      return token.value
    }
    return null
  }

  function primary(): number {
    const token = peek()
    if (!token) throw new ArithmeticError('Unexpected end of expression')
    if (token.kind === 'number') {
      pos += 1
      return token.value
    }
    if (token.value === '(') {
      pos += 1
      const value = expression()
      if (!eatOp(')')) throw new ArithmeticError('Missing closing parenthesis')
      return value
    }
    throw new ArithmeticError(`Unexpected token: ${token.value}`)
  }

  function unary(): number {
    const op = eatOp('-', '+')
    if (op === '-') return -unary()
    if (op === '+') return unary()
    return primary()
  }

  function power(): number {
    const base = unary()
    if (eatOp('^')) return base ** power()
    return base
  }

  function term(): number {
    let value = power()
    for (;;) {
      const op = eatOp('*', '/', '%')
      if (!op) return value
      const right = power()
      if ((op === '/' || op === '%') && right === 0) {
        throw new ArithmeticError('Division by zero')
      }
      value = op === '*' ? value * right : op === '/' ? value / right : value % right
    }
  }

  function expression(): number {
    let value = term()
    for (;;) {
      const op = eatOp('+', '-')
      if (!op) return value
      value = op === '+' ? value + term() : value - term()
    }
  }

  const result = expression()
  if (pos !== tokens.length) throw new ArithmeticError('Trailing input after expression')
  if (!Number.isFinite(result)) throw new ArithmeticError('Result is not a finite number')
  return result
}

/**
 * Formats without scientific notation or trailing zeros, so the value can be
 * pasted into the reply verbatim.
 *
 * Binary floating point cannot represent every decimal, so 64999 x 0.8571
 * lands on 55710.642899999996 and would be reported with a tail of noise. The
 * result is rounded to 15 significant digits, which absorbs that tail while
 * staying an order of magnitude past any precision a price carries. Digits, not
 * decimal places: a five-figure amount has far fewer decimals available than a
 * fractional one, and a fixed decimal count reintroduces the noise it removed.
 */
export function formatExact(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e21) return String(value)

  const normalised = Number(value.toPrecision(15))
  if (Number.isInteger(normalised)) return String(normalised)

  // toPrecision can emit exponent form for very large or small magnitudes;
  // expand it so the model never copies "5.5e+4" into a reply.
  const text = String(normalised)
  if (!text.includes('e')) return text === '-0' ? '0' : text

  const decimals = Math.min(20, Math.max(0, 15 - Math.ceil(Math.log10(Math.abs(normalised)))))
  return normalised.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '')
}

export function evaluate(expression: string): number {
  const trimmed = expression.trim()
  if (!trimmed) throw new ArithmeticError('Empty expression')
  if (trimmed.length > 500) throw new ArithmeticError('Expression is too long')
  return parse(tokenize(trimmed))
}

/** Evaluates and formats, returning the error text instead of throwing. */
export function calculate(expression: string): { ok: boolean; result: string } {
  try {
    return { ok: true, result: formatExact(evaluate(expression)) }
  } catch (err) {
    return { ok: false, result: err instanceof Error ? err.message : 'Invalid expression' }
  }
}
