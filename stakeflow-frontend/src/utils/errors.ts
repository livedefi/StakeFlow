export function isUserRejected(e: unknown): boolean {
  const msg = (() => {
    const obj = e as { message?: unknown; toString?: () => string }
    if (typeof obj?.message === 'string') return obj.message
    try { return typeof obj?.toString === 'function' ? String(obj.toString()) : '' } catch { return '' }
  })().toLowerCase()
  return (
    msg.includes('user rejected') ||
    msg.includes('rejected the request') ||
    msg.includes('user canceled') ||
    msg.includes('user cancelled') ||
    (() => { const code = (e as { code?: unknown })?.code; return typeof code === 'number' && code === 4001 })() // EIP-1193 style (some adapters emulate)
  )
}

export function buildFriendlyMessage(e: unknown, fallback: string): string {
  const raw = (() => {
    const obj = e as { error?: { errorMessage?: unknown }; message?: unknown; toString?: () => string }
    if (typeof obj?.error?.errorMessage === 'string') return obj.error.errorMessage
    if (typeof obj?.message === 'string') return obj.message
    try { return typeof obj?.toString === 'function' ? String(obj.toString()) : '' } catch { return '' }
  })()
  const lower = raw.toLowerCase()
  if (lower.includes('insufficient funds') || lower.includes('insufficient lamports')) {
    return 'Insufficient SOL for fees/rent. Use the faucet on devnet.'
  }
  if (lower.includes('blockhash')) {
    return 'Transaction expired (blockhash). Generate a new one and try again quickly.'
  }
  if (lower.includes('signature') && lower.includes('failed')) {
    return 'Invalid signature or rejected by the wallet.'
  }
  if (lower.includes('simulation failed')) {
    return 'Simulation failed. Check the logs and the mint/ATA.'
  }
  if (lower.includes('wallet not found')) {
    return 'Wallet not found. Install or open your wallet.'
  }
  if (lower.includes('connection failed') || lower.includes('disconnected')) {
    return 'Wallet connection failed. Try again.'
  }
  if (lower.includes('already been processed')) {
    return 'Transaction already processed. Refreshing state…'
  }
  if (lower.includes('unsupported') && lower.includes('v0')) {
    return 'Your wallet does not support v0 transactions. Use updated Phantom, Backpack, or Solflare.'
  }
  return fallback
}

export function logWalletError(e: unknown, context: string): void {
  if (isUserRejected(e)) return
  const name = (() => { const n = (e as { name?: unknown })?.name; return typeof n === 'string' ? n : 'Error' })()
  const code = (() => { const c = (e as { code?: unknown })?.code; return (typeof c === 'number' || typeof c === 'string') ? String(c) : '' })()
  const msg = (() => {
    const obj = e as { error?: { errorMessage?: unknown }; message?: unknown; toString?: () => string }
    if (typeof obj?.error?.errorMessage === 'string') return obj.error.errorMessage
    if (typeof obj?.message === 'string') return obj.message
    try { return typeof obj?.toString === 'function' ? String(obj.toString()) : '' } catch { return '' }
  })()
  const summary = `${context}: [${name}${code ? `:${code}` : ''}] ${msg}`.trim()
  console.warn(summary)
}