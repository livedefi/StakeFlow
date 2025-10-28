import * as anchor from '@coral-xyz/anchor'
export const { BN } = anchor

// Parse a UI string amount into BN with given decimals
export function parseAmountToBN(input: string, decimals: number): anchor.BN {
  const s = (input || '').trim()
  if (!s) throw new Error('Empty amount')
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('Invalid format. Use only numbers and a decimal point.')
  const [wholeRaw, fractionRaw = ''] = s.split('.')
  const frac = (fractionRaw + '0'.repeat(decimals)).slice(0, decimals)
  const base = '1' + '0'.repeat(decimals)
  const wholePart = BigInt(wholeRaw) * BigInt(base)
  const fracPart = BigInt(frac || '0')
  const total = wholePart + fracPart
  return new BN(total.toString())
}

// Convert raw integer amount to UI string with decimals
export function toUiAmount(raw: string | number | anchor.BN, decimals: number): string {
  const s = raw instanceof BN ? raw.toString(10) : typeof raw === 'number' ? Math.floor(raw).toString() : raw
  if (!s) return '0'
  const neg = s.startsWith('-')
  const digits = neg ? s.slice(1) : s
  const pad = digits.padStart(decimals + 1, '0')
  const splitPos = pad.length - decimals
  const whole = pad.slice(0, splitPos)
  let frac = pad.slice(splitPos)
  frac = frac.replace(/0+$/, '')
  const res = frac.length ? `${whole}.${frac}` : whole
  return neg ? `-${res}` : res
}

export function bpsToPercent(bps: number): string {
  const pct = bps / 100
  return `${pct.toFixed(2)}%`
}

export function formatAmount(n: number): string {
  const s = n.toString()
  if (!s.includes('.')) return s
  const [whole, frac] = s.split('.')
  return `${whole}.${frac.slice(0, 2)}`
}