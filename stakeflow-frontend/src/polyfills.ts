// Browser polyfills for Node built-ins used by web3.js / spl-token
import { Buffer } from 'buffer'
import process from 'process'

declare global {
  var Buffer: typeof Buffer
  var process: typeof process
}

if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = Buffer
}
if (typeof globalThis.process === 'undefined') {
  globalThis.process = process
}

// Ensure TextEncoder/TextDecoder exist without CommonJS require
export function ensureTextEncoding(): void {
  const g = globalThis as {
    TextEncoder?: typeof TextEncoder
    TextDecoder?: typeof TextDecoder
  }

  try {
    if (!g.TextEncoder && typeof TextEncoder !== 'undefined') {
      g.TextEncoder = TextEncoder
    }
  } catch { /* noop */ }

  try {
    if (!g.TextDecoder && typeof TextDecoder !== 'undefined') {
      g.TextDecoder = TextDecoder
    }
  } catch { /* noop */ }
}

ensureTextEncoding()