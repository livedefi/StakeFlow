// Browser polyfills for Node built-ins used by web3.js / spl-token
import { Buffer as NodeBuffer } from 'buffer'
import processModule from 'process'

// Avoid declaring global vars with self-referential types to prevent TS2502.

{
  const g = globalThis as unknown as { Buffer?: typeof NodeBuffer; process?: typeof processModule }
  if (typeof g.Buffer === 'undefined') {
    g.Buffer = NodeBuffer
  }
  if (typeof g.process === 'undefined') {
    g.process = processModule
  }
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