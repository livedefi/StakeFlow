/// <reference types="node" />
import dotenv from 'dotenv'
dotenv.config()
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { Connection, PublicKey, Keypair, clusterApiUrl, VersionedTransaction, TransactionMessage } from '@solana/web3.js'
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createMintToCheckedInstruction,
  getMint,
} from '@solana/spl-token'
import bs58 from 'bs58'
import nacl from 'tweetnacl'

// Helper to get env variables with defaults
function getEnv(name: string, required = false, def?: string): string {
  const raw = process.env[name]
  const v = raw === undefined || raw === '' ? def : raw
  if ((v === undefined || v === '') && required) throw new Error(`Missing env: ${name}`)
  return v as string
}

// Parse secret key from base58 or JSON array
function parseSecretKey(raw: string): Uint8Array {
  try {
    if (raw.trim().startsWith('[')) {
      const arr = JSON.parse(raw) as number[]
      return new Uint8Array(arr)
    }
    return bs58.decode(raw)
  } catch {
    throw new Error('Invalid secret key format. Use base58 or JSON array.')
  }
}

// Verify a signed challenge from the requester (prevents replay and abuse)
function verifyChallenge(wallet: string, signatureB58: string, timestampMs: number): boolean {
  const now = Date.now()
  const skewMs = 2 * 60 * 1000 // 2 minutes window
  if (Math.abs(now - timestampMs) > skewMs) return false
  const message = `stakeflow-mint:${wallet}:${timestampMs}`
  const msgBytes = new TextEncoder().encode(message)
  const sig = bs58.decode(signatureB58)
  const pub = new PublicKey(wallet).toBytes()
  return nacl.sign.detached.verify(msgBytes, sig, pub)
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' })
      return
    }

    const { wallet, amount, signature, timestamp } = req.body || {}
    if (!wallet || !amount || !signature || !timestamp) {
      res.status(400).json({ error: 'Missing fields: wallet, amount, signature, timestamp' })
      return
    }

    // Verify signed challenge
    const ok = verifyChallenge(wallet, signature, Number(timestamp))
    if (!ok) {
      res.status(401).json({ error: 'Invalid signature or stale timestamp' })
      return
    }

    // Env config
    const MINT_ADDRESS = getEnv('MINT_ADDRESS', true)
    const DECIMALS = Number(getEnv('MINT_DECIMALS', true))
    const MAX = Number(getEnv('MAX_MINT_PER_REQUEST', false, '100'))
    const NETWORK = getEnv('MINT_NETWORK', false, 'devnet')
    type SolanaCluster = 'mainnet-beta' | 'testnet' | 'devnet'
    const RPC_URL = getEnv('RPC_URL', false, clusterApiUrl(NETWORK as SolanaCluster))
    const AUTH_SK = parseSecretKey(getEnv('MINT_AUTHORITY_SECRET_KEY', true))

    // Basic visibility for local debugging (no secrets)
    if (process.env.NODE_ENV !== 'production') {
      console.log('[mint.ts] Config:', { NETWORK, RPC_URL: RPC_URL?.slice(0, 32) + '...', MINT_ADDRESS, DECIMALS, MAX })
    }

    // Validate amount
    const uiAmount = Number(amount)
    if (!Number.isFinite(uiAmount) || uiAmount <= 0) {
      res.status(400).json({ error: 'Invalid amount' })
      return
    }
    if (uiAmount > MAX) {
      res.status(400).json({ error: `Amount too large. Max: ${MAX}` })
      return
    }

    const mint = new PublicKey(MINT_ADDRESS)
    const owner = new PublicKey(wallet)
    const amountBaseUnits = BigInt(Math.round(uiAmount * 10 ** DECIMALS))

    const connection = new Connection(RPC_URL, 'confirmed')

    // Validate mint configuration
    const mintInfo = await getMint(connection, mint)
    const actualDecimals = mintInfo.decimals
    if (actualDecimals !== DECIMALS) {
      return res.status(400).json({ error: `Mint decimals mismatch. Expected ${actualDecimals}, got ${DECIMALS}.` })
    }
    const authorityPk = Keypair.fromSecretKey(AUTH_SK).publicKey
    const configuredAuth = authorityPk.toBase58()
    const onChainAuth = mintInfo.mintAuthority ? mintInfo.mintAuthority.toBase58() : null
    if (!onChainAuth || onChainAuth !== configuredAuth) {
      return res.status(403).json({ error: 'Mint authority mismatch or not set for this mint.' })
    }

    // Derive ATA and check existence
    const ata = await getAssociatedTokenAddress(mint, owner, false)
    const ataInfo = await connection.getAccountInfo(ata)

    // Build instructions array
    const ixs = []
    if (!ataInfo) {
      ixs.push(createAssociatedTokenAccountInstruction(owner, ata, owner, mint))
    }

    const mintAuthority = Keypair.fromSecretKey(AUTH_SK)
    ixs.push(
      createMintToCheckedInstruction(
        mint,
        ata,
        mintAuthority.publicKey,
        Number(amountBaseUnits),
        DECIMALS
      )
    )

    // Blockhash and message v0
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
    const messageV0 = new TransactionMessage({
      payerKey: owner,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message()

    // Versioned transaction and partial sign
    const vtx = new VersionedTransaction(messageV0)
    vtx.sign([mintAuthority])

    // Simulate with signature verification disabled to surface logs
    let simulationLogs: string[] | undefined
    try {
      const sim = await connection.simulateTransaction(vtx, { sigVerify: false })
      simulationLogs = sim.value?.logs || undefined
    } catch {
      simulationLogs = undefined
    }

    const serialized = vtx.serialize()

    res.status(200).json({
      transaction: Buffer.from(serialized).toString('base64'),
      lastValidBlockHeight,
      message: 'Partially signed transaction. Please co-sign and send.',
      simulationLogs,
    })
  } catch (e: unknown) {
    const message = typeof e === 'string' ? e : (e as Error)?.message || 'Internal error'
    console.error('[mint.ts] Error:', e)
    res.status(500).json({ error: message })
  }
}