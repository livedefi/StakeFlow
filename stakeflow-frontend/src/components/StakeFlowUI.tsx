import { useWallet, useConnection, useAnchorWallet } from '@solana/wallet-adapter-react'
import { useEffect, useMemo, useState, useCallback } from 'react'
import toast from 'react-hot-toast'
import * as anchor from '@coral-xyz/anchor'
import { PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL, VersionedTransaction } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import bs58 from 'bs58'

import { STAKE_FLOW_PROGRAM_ID, STAKE_MINT_ADDRESS, REWARD_MINT_ADDRESS, TOKEN_DECIMALS, solscanTxUrl } from '../config'
import idl from '../idl/stake_flow.json'
import { findConfigPda, findStakeVaultPda, findPenaltyVaultPda, findRewardMintAuthPda, findUserStakePda } from '../utils/pdas'
import { getAtaAddress, buildCreateAtaIx, tryGetAccount, getMintInfo } from '../utils/tokens'
import { parseAmountToBN, toUiAmount, bpsToPercent } from '../utils/format'

import type { WalletAdapter, MessageSignerWalletAdapter } from '@solana/wallet-adapter-base'
import type { Mint, Account as TokenAccount } from '@solana/spl-token'
import { isUserRejected, buildFriendlyMessage, logWalletError } from '../utils/errors'

type UserStakeDecoded = {
  owner: PublicKey
  staked_amount: anchor.BN
  pending_rewards: anchor.BN
  last_update_ts: anchor.BN
  lock_until_ts: anchor.BN
  bump: number
}

type ConfigAcc = {
  aprBps?: number
  earlyUnstakePenaltyBps?: number
  minLockDuration?: anchor.BN
  // legacy snake_case fallbacks
  min_lock_duration?: anchor.BN
  early_unstake_penalty_bps?: number
} | null

export default function StakeFlowUI() {
  const { connection } = useConnection()
  const { connected, publicKey, sendTransaction, wallet } = useWallet()

  const programId = useMemo(() => new PublicKey(STAKE_FLOW_PROGRAM_ID), [])
  const stakeMint = useMemo(() => new PublicKey(STAKE_MINT_ADDRESS), [])
  const rewardMint = useMemo(() => new PublicKey(REWARD_MINT_ADDRESS), [])

  const enableFaucet = import.meta.env.VITE_ENABLE_STAKE_FAUCET === 'true'
  const anchorWallet = useAnchorWallet()
  const provider = useMemo(() => {
    if (!anchorWallet) return null
    return new anchor.AnchorProvider(connection, anchorWallet, { preflightCommitment: 'processed' })
  }, [connection, anchorWallet])

  const program = useMemo(() => {
    if (!provider) return null
    anchor.setProvider(provider)
    return new anchor.Program(idl as anchor.Idl, provider)
  }, [provider])

  // Manual decoder for UserStake account because IDL lacks top-level `accounts`
  const decodeUserStake = useCallback((buf: Uint8Array | null): UserStakeDecoded | null => {
    if (!buf || buf.length < 72) return null
    try {
      const data = buf.subarray(8)
      const owner = new PublicKey(data.slice(0, 32))
      const staked_amount = new anchor.BN(data.slice(32, 40), 'le')
      const pending_rewards = new anchor.BN(data.slice(40, 48), 'le')
      const last_update_ts = new anchor.BN(data.slice(48, 56), 'le')
      const lock_until_ts = new anchor.BN(data.slice(56, 64), 'le')
      const bump = data[64]
      return { owner, staked_amount, pending_rewards, last_update_ts, lock_until_ts, bump }
    } catch {
      return null
    }
  }, [])

  const [configPda, setConfigPda] = useState<PublicKey | null>(null)
  const [stakeVaultPda, setStakeVaultPda] = useState<PublicKey | null>(null)
  const [penaltyVaultPda, setPenaltyVaultPda] = useState<PublicKey | null>(null)
  const [rewardAuthPda, setRewardAuthPda] = useState<PublicKey | null>(null)
  const [userStakePda, setUserStakePda] = useState<PublicKey | null>(null)

  const [configAcc, setConfigAcc] = useState<ConfigAcc>(null)
  const [userStakeAcc, setUserStakeAcc] = useState<UserStakeDecoded | null>(null)
  const [ownerStakeAta, setOwnerStakeAta] = useState<PublicKey | null>(null)
  const [ownerRewardAta, setOwnerRewardAta] = useState<PublicKey | null>(null)
  const [stakeBalanceRaw, setStakeBalanceRaw] = useState<string>('0')
  const [rewardBalanceRaw, setRewardBalanceRaw] = useState<string>('0')
  const [stakeMintInfo, setStakeMintInfo] = useState<Mint | null>(null)
  const [rewardMintInfo, setRewardMintInfo] = useState<Mint | null>(null)
  const [stakeAtaExists, setStakeAtaExists] = useState<boolean>(false)
  const [rewardAtaExists, setRewardAtaExists] = useState<boolean>(false)
  const [stakeAmt, setStakeAmt] = useState('')
  const [unstakeAmt, setUnstakeAmt] = useState('')
  const [loadingStake, setLoadingStake] = useState(false)
  const [loadingUnstake, setLoadingUnstake] = useState(false)
  const [loadingClaim, setLoadingClaim] = useState(false)
  const [mintAmt, setMintAmt] = useState('')
  const [loadingMint, setLoadingMint] = useState(false)
  const [remainingLockSec, setRemainingLockSec] = useState(0)
  const [loadingInitial, setLoadingInitial] = useState(false)

  const loadAll = useCallback(async () => {
    if (!program || !publicKey) return
    try {
      setLoadingInitial(true)
      const [cfg] = findConfigPda(programId)
      const [stakeVault] = findStakeVaultPda(programId, cfg)
      const [penVault] = findPenaltyVaultPda(programId, cfg)
      const [rewAuth] = findRewardMintAuthPda(programId)
      const [userStake] = findUserStakePda(programId, publicKey)
      setConfigPda(cfg)
      setStakeVaultPda(stakeVault)
      setPenaltyVaultPda(penVault)
      setRewardAuthPda(rewAuth)
      setUserStakePda(userStake)

      const cfgAcc = await (program as unknown as { account: { config: { fetch: (key: PublicKey) => Promise<{ aprBps?: number; earlyUnstakePenaltyBps?: number; minLockDuration?: anchor.BN; min_lock_duration?: anchor.BN; early_unstake_penalty_bps?: number }> } } }).account.config.fetch(cfg)
      setConfigAcc(cfgAcc)

      const stakeInfo = await getMintInfo(connection, stakeMint)
      const rewardInfo = await getMintInfo(connection, rewardMint)
      setStakeMintInfo(stakeInfo)
      setRewardMintInfo(rewardInfo)

      const stakeAta = await getAtaAddress(stakeMint, publicKey)
      const rewardAta = await getAtaAddress(rewardMint, publicKey)
      setOwnerStakeAta(stakeAta)
      setOwnerRewardAta(rewardAta)

      try {
        const ai = await connection.getAccountInfo(userStake, 'finalized')
        if (ai?.data) {
          const us = decodeUserStake(ai.data)
          setUserStakeAcc(us)
        } else {
          setUserStakeAcc(null)
        }
      } catch (e) {
        console.warn('UserStake fetch failed, account may not exist yet:', e)
        setUserStakeAcc(null)
      }

      try { const stakeAcc: TokenAccount | null = await tryGetAccount(connection, stakeAta); setStakeBalanceRaw(stakeAcc ? stakeAcc.amount.toString() : '0'); setStakeAtaExists(!!stakeAcc) } catch { setStakeBalanceRaw('0'); setStakeAtaExists(false) }
      try { const rewardAcc: TokenAccount | null = await tryGetAccount(connection, rewardAta); setRewardBalanceRaw(rewardAcc ? rewardAcc.amount.toString() : '0'); setRewardAtaExists(!!rewardAcc) } catch { setRewardBalanceRaw('0'); setRewardAtaExists(false) }
    } catch (e: unknown) {
      console.error('loadAll error', e)
      toast.error('Failed to load initial data. Check connection and program.', { duration: 5000 })
    } finally {
      setLoadingInitial(false)
    }
  }, [program, publicKey, programId, stakeMint, rewardMint, connection, decodeUserStake])

  // Initial load: fetch config, PDAs, balances when wallet/program are ready
  useEffect(() => {
    if (!program || !publicKey) return
    void loadAll()
  }, [program, publicKey, loadAll])

  // Reset UI state on wallet change to avoid stale balances and PDAs
  useEffect(() => {
    setUserStakeAcc(null)
    setOwnerStakeAta(null)
    setOwnerRewardAta(null)
    setStakeBalanceRaw('0')
    setRewardBalanceRaw('0')
    setStakeAtaExists(false)
    setRewardAtaExists(false)
  }, [publicKey])

  // Refresh data on wallet adapter connect/disconnect events
  useEffect(() => {
    const adapter = wallet?.adapter as WalletAdapter | undefined
    if (!adapter) return
    const refresh = () => { if (program && publicKey) void loadAll() }
    adapter.on('connect', refresh)
    adapter.on('disconnect', refresh)
    // Also refresh on account change (Phantom switches account without disconnect)
    const eventAdapter = adapter as unknown as {
      on?: (event: string, handler: (...args: unknown[]) => void) => void
      off?: (event: string, handler: (...args: unknown[]) => void) => void
    }
    eventAdapter.on?.('accountChanged', refresh)
    // Phantom provider fallback
    const phantom = (window as unknown as { solana?: { on?: (event: 'accountChanged' | 'networkChanged', handler: (...args: unknown[]) => void) => void; off?: (event: 'accountChanged' | 'networkChanged', handler: (...args: unknown[]) => void) => void } }).solana
    phantom?.on?.('accountChanged', refresh)
    phantom?.on?.('networkChanged', refresh)
    return () => {
      adapter.off('connect', refresh)
      adapter.off('disconnect', refresh)
      eventAdapter.off?.('accountChanged', refresh)
      phantom?.off?.('accountChanged', refresh)
      phantom?.off?.('networkChanged', refresh)
    }
  }, [wallet, program, publicKey, loadAll])

  useEffect(() => {
    const tick = () => {
      try {
        const s = userStakeAcc?.lock_until_ts?.toString()
        const lockUntil = s ? parseInt(s, 10) : 0
        const nowSec = Math.floor(Date.now() / 1000)
        const rem = Math.max(0, lockUntil - nowSec)
        setRemainingLockSec(rem)
      } catch {
        setRemainingLockSec(0)
      }
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => { clearInterval(timer) }
  }, [userStakeAcc])


  // Type guard: check if adapter supports signMessage
  const isMessageSignerWallet = (adapter: WalletAdapter | null | undefined): adapter is MessageSignerWalletAdapter => {
    return !!adapter && 'signMessage' in adapter
  }

  // Helper: ensure ATA exists, create if missing
  const ensureAtaIfMissing = useCallback(async (
    ata: PublicKey | null,
    mint: PublicKey,
    label: string
  ): Promise<boolean> => {
    if (!publicKey || !ata) return false
    try {
      const acc = await tryGetAccount(connection, ata)
      if (acc) return true
      const ix = buildCreateAtaIx(publicKey, ata, publicKey, mint)
      const tx = new Transaction().add(ix)
      const sig = await sendTransaction(tx, connection)
      toast.success(`${label} ATA created`, { duration: 3500 })
      toast(<a href={solscanTxUrl(sig)} target="_blank" rel="noreferrer">View on Solscan</a>, { duration: 5000 })
      return true
    } catch (e: unknown) {
      logWalletError(e, `ensure-${label.toLowerCase()}-ata`)
      if (isUserRejected(e)) {
        // Silence toast here; WalletProvider onError already handles the message
      } else {
        const friendly = buildFriendlyMessage(e, 'Error creating ATA. Check your wallet and fees.')
        const logs = (e as { logs?: string[] })?.logs
        if (Array.isArray(logs) && logs.length) {
          console.error('Wallet logs:', logs)
        }
        toast.error(friendly, { duration: 6000 })
      }
      return false
    }
  }, [publicKey, connection, sendTransaction])

  // Admin faucet: mint Stake tokens via secure API (devnet)
  const onMintStake = useCallback(async () => {
    if (!publicKey) return toast.error('Connect your wallet')
    const adapter = wallet?.adapter
    if (!isMessageSignerWallet(adapter)) return toast.error('Your wallet does not support signMessage')
    const uiAmount = Number(mintAmt)
    if (!Number.isFinite(uiAmount) || uiAmount <= 0) return toast.error('Invalid amount')

    let lastSimulationLogs: string[] | undefined
    setLoadingMint(true)
    try {
      const timestamp = Date.now()
      const msg = new TextEncoder().encode(`stakeflow-mint:${publicKey.toBase58()}:${timestamp}`)
      const sigBytes = await adapter.signMessage(msg)
      const signatureB58 = bs58.encode(sigBytes)

      const res = await fetch('/api/mint.ts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet: publicKey.toBase58(),
          amount: uiAmount,
          signature: signatureB58,
          timestamp,
        }),
      })
      const isJson = (res.headers.get('content-type') || '').includes('application/json')
      const data = isJson ? await res.json() : null
      if (!res.ok) throw new Error((data as { error?: string } | null)?.error || `Mint API error (${res.status})`)

      // Save simulation logs for diagnostics
      lastSimulationLogs = Array.isArray(data?.simulationLogs) ? data.simulationLogs : undefined
      if (lastSimulationLogs?.length) {
        console.debug('Mint simulation logs:', lastSimulationLogs.join('\n'))
      }

      // Check SOL balance before sending (fees + rent)
      const balanceLamports = await connection.getBalance(publicKey)
      const minLamports = 0.05 * LAMPORTS_PER_SOL
      if (balanceLamports < minLamports) {
        toast.error('Not enough SOL on devnet. Use the faucet and try again.', { duration: 6000 })
        toast(<a href="https://faucet.solana.com/" target="_blank" rel="noreferrer">Open devnet faucet</a>, { duration: 6000 })
        return
      }

      // Attempt to deserialize as VersionedTransaction first; if it fails, use legacy Transaction
      const raw = Buffer.from(data.transaction, 'base64')
      let sig: string
      try {
         const vtx = VersionedTransaction.deserialize(raw)
         const supports = !!adapter && 'supportedTransactionVersions' in adapter && (adapter.supportedTransactionVersions?.has?.(0) ?? false)
         if (!supports) {
           throw new Error('WALLET_UNSUPPORTED_V0')
         }
        // v0 transaction signing block: runtime type guard
        type HasVersionedSign = { signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction> }
        // Replace unsafe any in signTransaction guard
        const hasSignTransaction = (a: unknown): a is HasVersionedSign => typeof (a as { signTransaction?: unknown }).signTransaction === 'function'
        if (!hasSignTransaction(adapter)) { throw new Error('Wallet does not support signTransaction') }
        const signedVtx = await adapter.signTransaction(vtx)
        sig = await connection.sendRawTransaction(signedVtx.serialize(), { skipPreflight: false })
      } catch (e: unknown) {
        const msg = (e as { message?: string })?.message || ''
        if (msg === 'WALLET_UNSUPPORTED_V0') {
          toast.error('Your wallet does not support v0 transactions. Use updated Phantom, Backpack, or Solflare.', { duration: 6000 })
          return
        }
        // Legacy fallback only if the backend returns legacy transactions
        try {
          const tx = Transaction.from(raw)
          sig = await sendTransaction(tx, connection)
        } catch {
          throw e
        }
      }

      toast.success('Mint submitted successfully', { duration: 3500 })
      toast(<a href={solscanTxUrl(sig)} target="_blank" rel="noreferrer">View on Solscan</a>, { duration: 6000 })
      setMintAmt('')
      await loadAll()
    } catch (e: unknown) {
      logWalletError(e, 'mint-stake')
      if (isUserRejected(e)) {
        // Silence toast here; WalletProvider onError already handles the message
      } else {
        const friendly = buildFriendlyMessage(e, 'Error minting tokens. Check wallet and fees.')
        const logs = (e as { logs?: string[] })?.logs
        if (Array.isArray(logs) && logs.length) {
          console.error('Wallet logs:', logs)
        }
        if (lastSimulationLogs?.length) {
          console.error('Simulation logs:', lastSimulationLogs)
        }
        toast.error(friendly, { duration: 6000 })
      }
    } finally {
      setLoadingMint(false)
    }
  }, [publicKey, wallet, mintAmt, sendTransaction, connection, loadAll])

  const onStake = useCallback(async () => {
    if (!program || !publicKey || !configPda || !stakeVaultPda || !userStakePda || !ownerStakeAta) return
    let amount
    try { amount = parseAmountToBN(stakeAmt, stakeMintInfo?.decimals ?? TOKEN_DECIMALS) } catch (e: unknown) { const msg = (e as { message?: string })?.message ?? 'Invalid amount'; return toast.error(msg) }
    if (amount.lte(new anchor.BN(0))) return toast.error('Amount must be greater than 0')
    
    setLoadingStake(true)
    try {
      const okAta = await ensureAtaIfMissing(ownerStakeAta, stakeMint, 'Stake')
      if (!okAta) { setLoadingStake(false); return }

      const stakeAcc = await tryGetAccount(connection, ownerStakeAta)
      const bal = new anchor.BN(stakeAcc?.amount?.toString() || '0')
      if (bal.lt(amount)) { setLoadingStake(false); return toast.error('Insufficient balance in your stake ATA') }
      if (!userStakeAcc) {
        await program.methods.createUserStake().accounts({ owner: publicKey, config: configPda, userStake: userStakePda, systemProgram: SystemProgram.programId }).rpc()
      }
      // Send without preflight to avoid "already been processed" error in simulation
      const ix = await program.methods
      .stake(amount)
      .accounts({ owner: publicKey, config: configPda, stakeVault: stakeVaultPda, ownerStakeAta, userStake: userStakePda, tokenProgram: TOKEN_PROGRAM_ID })
      .instruction()
      const tx = new Transaction().add(ix)
      const sig = await sendTransaction(tx, connection, { skipPreflight: true })
      try {
        const latest = await connection.getLatestBlockhash('finalized')
        await connection.confirmTransaction({ signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, 'finalized')
      } catch { /* noop */ }

      // Poll until on-chain user stake reflects the update (up to ~8s)
      try {
        const before = new anchor.BN(userStakeAcc?.staked_amount?.toString() ?? '0')
        for (let i = 0; i < 8; i++) {
          await new Promise(r => setTimeout(r, 1000))
          try {
            const ai2 = await connection.getAccountInfo(userStakePda!, 'finalized')
            if (ai2?.data) {
              const us2 = decodeUserStake(ai2.data)
              const now = new anchor.BN(us2?.staked_amount?.toString() ?? '0')
              if (now.gt(before)) { setUserStakeAcc(us2); break }
            }
          } catch { /* noop */ }
        }
      } catch { /* noop */ }

      toast.success('Stake successful', { duration: 4000 })
      toast(<a href={solscanTxUrl(sig)} target="_blank" rel="noreferrer">View on Solscan</a>, { duration: 6000 })
      await loadAll()
    } catch (e: unknown) {
      logWalletError(e, 'stake')
      if (isUserRejected(e)) {
        // Silence toast here; WalletProvider onError already handles the message
      } else {
        const msg = buildFriendlyMessage(e, 'Error executing stake')
        if (msg.includes('already been processed')) {
          toast('Transaction already processed. Refreshing state…', { duration: 3500 })
          await loadAll()
          return
        }
        if (msg.includes('InvalidAmount')) toast.error('Invalid amount')
        else if (msg.includes('InsufficientStake')) toast.error('Insufficient balance')
        else toast.error(msg)
      }
    } finally { setLoadingStake(false) }
  }, [program, publicKey, configPda, stakeVaultPda, userStakePda, ownerStakeAta, stakeAmt, userStakeAcc, connection, loadAll, stakeMint, ensureAtaIfMissing, sendTransaction, decodeUserStake, stakeMintInfo?.decimals])

  const onUnstake = useCallback(async () => {
    if (!program || !publicKey || !configPda || !stakeVaultPda || !ownerStakeAta || !userStakePda || !penaltyVaultPda) return
    let amount
    try { amount = parseAmountToBN(unstakeAmt, stakeMintInfo?.decimals ?? TOKEN_DECIMALS) } catch (e: unknown) { const msg = (e as { message?: string })?.message ?? 'Invalid amount'; return toast.error(msg) }
    if (amount.lte(new anchor.BN(0))) return toast.error('Amount must be greater than 0')
    setLoadingUnstake(true)
    try {
      if (!userStakeAcc) { setLoadingUnstake(false); return toast.error('You do not have an active stake position.') }
      const staked = new anchor.BN(userStakeAcc?.staked_amount?.toString() ?? '0')
      if (staked.lt(amount)) { setLoadingUnstake(false); return toast.error('Amount exceeds your current stake') }

      const okAta = await ensureAtaIfMissing(ownerStakeAta, stakeMint, 'Stake')
      if (!okAta) { setLoadingUnstake(false); return }

      try {
        const nowSec = Math.floor(Date.now() / 1000)
        const lockUntil = parseInt((userStakeAcc?.lock_until_ts?.toString?.() ?? '0'), 10)
        if (nowSec < lockUntil) {
          toast('Early-unstake penalty may apply', { duration: 4000 })
        }
      } catch { void 0 }

      // Send without preflight to avoid "already been processed" error in simulation
      const ix = await program.methods
        .unstake(amount)
        .accounts({ owner: publicKey, config: configPda, stakeVault: stakeVaultPda, ownerStakeAta, userStake: userStakePda, penaltyVault: penaltyVaultPda, tokenProgram: TOKEN_PROGRAM_ID })
        .instruction()
      const tx = new Transaction().add(ix)
      const sig = await sendTransaction(tx, connection, { skipPreflight: true })
      try {
        const latest = await connection.getLatestBlockhash('finalized')
        await connection.confirmTransaction({ signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, 'finalized')
      } catch { void 0 }

      // Poll until `staked_amount` reflects the reduction (up to ~8s)
      try {
        const before = new anchor.BN(userStakeAcc?.staked_amount?.toString() ?? '0')
        for (let i = 0; i < 8; i++) {
          await new Promise(r => setTimeout(r, 1000))
          try {
            const ai2 = await connection.getAccountInfo(userStakePda!, 'finalized')
            if (ai2?.data) {
              const us2 = decodeUserStake(ai2.data)
              const now = new anchor.BN(us2?.staked_amount?.toString() ?? '0')
              if (now.lt(before)) { setUserStakeAcc(us2); break }
            }
          } catch { void 0 }
        }
      } catch { void 0 }

      toast.success('Unstake successful', { duration: 4000 })
      toast(<a href={solscanTxUrl(sig)} target="_blank" rel="noreferrer">View on Solscan</a>, { duration: 6000 })
      await loadAll()
    } catch (e: unknown) {
      logWalletError(e, 'unstake')
      if (isUserRejected(e)) {
        // Silence toast here; WalletProvider onError already handles the message
      } else {
        const msgSrc = e as { error?: { errorMessage?: string }; message?: string }
        const msg = msgSrc.error?.errorMessage || msgSrc.message || 'Error executing unstake'
        if (msg.includes('InvalidAmount')) toast.error('Invalid amount')
        else if (msg.includes('InsufficientStake')) toast.error('Insufficient stake')
        else if ((msg || '').toLowerCase().includes('already been processed')) {
          toast('Transaction already processed. Refreshing state…', { duration: 3500 })
          await loadAll()
          return
        }
        else toast.error(msg)
      }
    } finally { setLoadingUnstake(false) }
  }, [program, publicKey, configPda, stakeVaultPda, ownerStakeAta, userStakePda, penaltyVaultPda, unstakeAmt, userStakeAcc, stakeMintInfo?.decimals, connection, loadAll, stakeMint, ensureAtaIfMissing, sendTransaction, decodeUserStake])

  const onClaim = useCallback(async () => {
    if (!program || !publicKey || !configPda || !userStakePda || !ownerRewardAta || !rewardAuthPda) return
    setLoadingClaim(true)
    try {
      // Requires userStake initialized to avoid AnchorError 3012
      if (!userStakeAcc) { setLoadingClaim(false); return toast.error('You do not have an active stake position. Stake once to initialize.') }

      const okAta = await ensureAtaIfMissing(ownerRewardAta, rewardMint, 'Reward')
      if (!okAta) { setLoadingClaim(false); return }

      // Send without preflight to avoid "already been processed" in simulation
      const ix = await program.methods
        .claimRewards()
        .accounts({ owner: publicKey, config: configPda, userStake: userStakePda, rewardMintAuthority: rewardAuthPda, rewardMint, ownerRewardAta, tokenProgram: TOKEN_PROGRAM_ID })
        .instruction()
      const tx = new Transaction().add(ix)
      const sig = await sendTransaction(tx, connection, { skipPreflight: true })

      // Confirm in finalized for consistent reads
      try {
        const latest = await connection.getLatestBlockhash('finalized')
        await connection.confirmTransaction({ signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, 'finalized')
      } catch { void 0 }

      // Post-claim poll: wait for pending_rewards to drop or reward balance to increase
      try {
        const beforePending = new anchor.BN((userStakeAcc?.pending_rewards?.toString?.() || '0'))
        let beforeRewardBal = new anchor.BN('0')
        try { const acc = await tryGetAccount(connection, ownerRewardAta!); beforeRewardBal = new anchor.BN(acc?.amount?.toString() || '0') } catch { void 0 }

        for (let i = 0; i < 8; i++) {
          await new Promise(r => setTimeout(r, 1000))
          let updated = false
          try {
            const ai2 = await connection.getAccountInfo(userStakePda!, 'finalized')
            if (ai2?.data) {
              const us2 = decodeUserStake(ai2.data)
              const nowPending = new anchor.BN((us2?.pending_rewards?.toString?.() || '0'))
              if (nowPending.lt(beforePending)) { setUserStakeAcc(us2); updated = true }
            }
          } catch { void 0 }
          try {
            const acc2 = await tryGetAccount(connection, ownerRewardAta!)
            const nowRewardBal = new anchor.BN(acc2?.amount?.toString() || '0')
            if (nowRewardBal.gt(beforeRewardBal)) { setRewardBalanceRaw(nowRewardBal.toString()); setRewardAtaExists(!!acc2); updated = true }
          } catch { void 0 }
          if (updated) break
        }
      } catch { void 0 }

      toast.success('Rewards claimed', { duration: 4000 })
      toast(<a href={solscanTxUrl(sig)} target="_blank" rel="noreferrer">View on Solscan</a>, { duration: 6000 })
      await loadAll()
    } catch (e: unknown) {
      logWalletError(e, 'claim')
      if (isUserRejected(e)) {
        // Silence toast here; WalletProvider onError already handles the message
      } else {
        const err = e as { message?: string; error?: { errorMessage?: string } }
        const msg = err.error?.errorMessage || err.message || 'Error claiming rewards'
        if ((msg || '').toLowerCase().includes('already been processed')) {
          toast('Transaction already processed. Refreshing state…', { duration: 3500 })
          await loadAll()
          return
        }
        if (msg.includes('InvalidMint')) toast.error('Invalid ATA for reward mint')
        else if (msg.includes('AccountNotInitialized')) toast.error('Your stake account is not initialized. Stake once to initialize.')
        else toast.error(msg)
      }
    } finally { setLoadingClaim(false) }
  }, [program, publicKey, configPda, userStakePda, ownerRewardAta, rewardAuthPda, rewardMint, connection, loadAll, userStakeAcc, ensureAtaIfMissing, sendTransaction, decodeUserStake])

  if (!connected) return null

  const stakeBalanceUi = toUiAmount(stakeBalanceRaw, stakeMintInfo?.decimals ?? TOKEN_DECIMALS)
  const rewardBalanceUi = toUiAmount(rewardBalanceRaw, rewardMintInfo?.decimals ?? TOKEN_DECIMALS)
  const pendingRewardsBn = new anchor.BN((userStakeAcc?.pending_rewards?.toString() || '0'))
  const pendingRewardsUi = toUiAmount(pendingRewardsBn.toString(), rewardMintInfo?.decimals ?? TOKEN_DECIMALS)
  const hasPendingRewards = pendingRewardsBn.gt(new anchor.BN(0))
  const stakeBalanceBn = new anchor.BN(stakeBalanceRaw || '0')
  const canStake = stakeAtaExists && stakeBalanceBn.gt(new anchor.BN(0))
  const stakedAmountBn = new anchor.BN((userStakeAcc?.staked_amount?.toString?.() || '0'))
  const canUnstake = !!userStakeAcc && stakedAmountBn.gt(new anchor.BN(0))

  return (
    <div className="max-w-7xl mx-auto space-y-8 px-4 sm:px-6 lg:px-8">
      {/* Top Accent (replaces hero) */}
      <div className="h-px bg-gradient-to-r from-[#9945FF]/30 via-[#14F195]/30 to-[#00FFA3]/30 rounded-full" />

      {/* Stats Overview */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
        <div className="bg-gradient-to-br from-[#111318] to-[#0e0f14] rounded-2xl border border-[#1f2330] p-4 sm:p-6 shadow-lg transition-transform hover:translate-y-[2px] hover:border-[#2a3146]">
          <div className="text-xs sm:text-sm text-[#9ca3af] mb-2">APR</div>
          <div className="text-xl sm:text-2xl font-bold text-[#14F195]">{configAcc ? bpsToPercent(configAcc.aprBps ?? 0) : '—'}</div>
        </div>
        <div className="bg-gradient-to-br from-[#111318] to-[#0e0f14] rounded-2xl border border-[#1f2330] p-4 sm:p-6 shadow-lg transition-transform hover:translate-y-[2px] hover:border-[#2a3146]">
          <div className="text-xs sm:text-sm text-[#9ca3af] mb-2">Penalty</div>
          <div className="text-xl sm:text-2xl font-bold text-[#ff6b6b]">{configAcc ? bpsToPercent(configAcc.earlyUnstakePenaltyBps ?? 0) : '—'}</div>
        </div>
        <div className="bg-gradient-to-br from-[#111318] to-[#0e0f14] rounded-2xl border border-[#1f2330] p-4 sm:p-6 shadow-lg transition-transform hover:translate-y-[2px] hover:border-[#2a3146]">
          <div className="text-xs sm:text-sm text-[#9ca3af] mb-2">Min Lock</div>
          <div className="text-xl sm:text-2xl font-bold text-[#9945FF]">{(() => {
            try {
              const val = configAcc?.minLockDuration ?? configAcc?.min_lock_duration
              const s = val?.toString()
              const n = s ? parseInt(s, 10) : NaN
              return Number.isFinite(n) && n > 0 ? `${n}s` : '—'
            } catch {
              return '—'
            }
          })()}</div>
        </div>
        <div className="bg-gradient-to-br from-[#111318] to-[#0e0f14] rounded-2xl border border-[#1f2330] p-4 sm:p-6 shadow-lg transition-transform hover:translate-y-[2px] hover:border-[#2a3146]">
          <div className="text-xs sm:text-sm text-[#9ca3af] mb-2">Your Stake</div>
          <div className="text-xl sm:text-2xl font-bold text-[#00FFA3]">{userStakeAcc ? toUiAmount((userStakeAcc?.staked_amount?.toString?.() ?? '0'), stakeMintInfo?.decimals ?? TOKEN_DECIMALS) : '0'}</div>
        </div>
      </div>

      {/* Main Actions Grid */}
      <div className="mt-8 grid lg:grid-cols-3 gap-6 sm:gap-8 items-start">
        {/* Balances */}
        <div className="lg:col-span-1">
        <div className="bg-gradient-to-br from-[#111318] to-[#0e0f14] rounded-2xl border border-[#1f2330] p-4 sm:p-6 shadow-lg h-full overflow-hidden">
            <h2 className="text-lg sm:text-xl font-semibold text-slate-100 mb-4 sm:mb-6 flex items-center">
              <div className="w-2 h-2 bg-[#14F195] rounded-full mr-3"></div>
              Token Balances
              {loadingInitial && <span className="ml-3 text-xs text-[#9ca3af]">Loading…</span>}
            </h2>
            <div className="space-y-6">
              <div className="bg-[#0e0f14] rounded-xl border border-[#1f2330] p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="text-sm font-medium text-[#9ca3af]">Stake Token</div>
                  <div className="text-lg font-bold text-slate-100">{loadingInitial ? '—' : stakeBalanceUi}</div>
                </div>
                <div className="text-xs text-[#9ca3af] mb-3 font-mono break-all">
                  {ownerStakeAta?.toBase58() || 'No ATA'}
                </div>
                <div className="text-xs text-[#9ca3af]">Stake ATA: {stakeAtaExists ? 'Created' : 'Not created'} • auto-managed</div>
                {!enableFaucet && (
                  <div className="mt-2 text-[11px] text-[#9ca3af]">
                    Faucet disabled. Enable <span className="font-mono">VITE_ENABLE_STAKE_FAUCET=true</span> in <span className="font-mono">.env</span>.
                  </div>
                )}
                {enableFaucet && (
                  <div className="mt-4 pt-4 border-t border-[#1f2330]">
                    <div className="flex flex-wrap sm:flex-nowrap items-center gap-3">
                      <input 
                        className="flex-1 min-w-0 rounded-xl bg-[#0f1117] border border-[#1f2330] px-3 py-2 text-sm text-slate-100 placeholder-[#9ca3af] focus:border-[#14F195] focus:ring-2 focus:ring-[#14F195]/50 focus:outline-none ring-offset-2 ring-offset-[#0b0c10] transition-colors"
                        placeholder="Amount to mint (Devnet)"
                        value={mintAmt}
                        onChange={(e) => setMintAmt(e.target.value)}
                      />
                      <button
                        className="px-4 py-2 rounded-xl bg-gradient-to-r from-[#9945FF] to-[#14F195] text-[#0b0c10] font-semibold text-sm hover:shadow-lg hover:shadow-[#9945FF]/20 transition-all duration-200 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-[#14F195]/70 ring-offset-2 ring-offset-[#0b0c10] shrink-0 whitespace-nowrap min-w-[110px]"
                        onClick={onMintStake}
                        disabled={loadingMint}
                      >
                        {loadingMint ? 'Signing…' : 'Mint Stake'}
                      </button>
                    </div>
                    <div className="mt-2 text-[11px] text-[#9ca3af]">
                      Use devnet only. Requires message signature and tx co-sign.
                    </div>
                  </div>
                )}
              </div>
              <div className="bg-[#0e0f14] rounded-xl border border-[#1f2330] p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="text-sm font-medium text-[#9ca3af]">Reward Token</div>
                  <div className="text-lg font-bold text-slate-100">{loadingInitial ? '—' : rewardBalanceUi}</div>
                </div>
                <div className="text-xs text-[#9ca3af] mb-3 font-mono break-all">
                  {ownerRewardAta?.toBase58() || 'No ATA'}
                </div>
                <div className="text-xs text-[#9ca3af]">Reward ATA: {rewardAtaExists ? 'Created' : 'Not created'} • auto-managed</div>
              </div>
            </div>
          </div>
        </div>

        {/* Staking Actions */}
        <div className="lg:col-span-2">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">

          {/* Stake Section */}
          <div className="bg-gradient-to-br from-[#111318] to-[#0e0f14] rounded-2xl border border-[#1f2330] p-6 shadow-lg h-full flex flex-col overflow-hidden">
            <h2 className="text-xl font-semibold text-slate-100 mb-4 flex items-center">
              <div className="w-2 h-2 bg-[#9945FF] rounded-full mr-3"></div>
              Stake Tokens
            </h2>
            <p className="text-sm text-[#9ca3af] mb-6">
              Enter amount (decimals: {stakeMintInfo?.decimals ?? TOKEN_DECIMALS}). Stake ATA and sufficient balance required.
            </p>
            <div className="mt-auto space-y-4">
              <div className="relative">
                <input 
                  className="w-full rounded-xl bg-[#0f1117] border border-[#1f2330] px-4 py-3 text-lg font-medium text-slate-100 placeholder-[#9ca3af] focus:border-[#14F195] focus:ring-2 focus:ring-[#14F195]/50 focus:outline-none ring-offset-2 ring-offset-[#0b0c10] transition-colors" 
                  placeholder="0.00" 
                  value={stakeAmt} 
                  onChange={(e) => setStakeAmt(e.target.value)} 
                />
                <div className="absolute right-3 top-1/2 transform -translate-y-1/2 text-sm text-[#9ca3af]">
                  SPL
                </div>
              </div>
              <button 
                className="w-full px-6 py-3 rounded-xl bg-gradient-to-r from-[#9945FF] via-[#14F195] to-[#00FFA3] text-[#0b0c10] font-semibold text-lg hover:shadow-lg hover:shadow-[#9945FF]/20 transition-all duration-200 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-[#14F195]/70 ring-offset-2 ring-offset-[#0b0c10]" 
                onClick={onStake} 
                disabled={loadingStake || !canStake}
              >
                {loadingStake ? 'Signing Transaction...' : 'Stake Tokens'}
              </button>
              {!canStake && (
                <div className="mt-2 text-xs text-[#9ca3af]">
                  You need a balance in your Stake ATA to stake.
                </div>
              )}
            </div>
          </div>

          {/* Unstake Section */}
          <div className="bg-gradient-to-br from-[#111318] to-[#0e0f14] rounded-2xl border border-[#1f2330] p-6 shadow-lg h-full flex flex-col overflow-hidden">
            <h2 className="text-xl font-semibold text-slate-100 mb-4 flex items-center">
              <div className="w-2 h-2 bg-[#ff6b6b] rounded-full mr-3"></div>
              Unstake Tokens
            </h2>
            <p className="text-sm text-[#9ca3af] mb-6">
              Unstake part or all of your position. A penalty may apply if the lock has not expired.
            </p>
            
            {/* Current Position Info */}
            {userStakeAcc ? (
              <div className="bg-[#0e0f14] rounded-xl border border-[#1f2330] p-4 mb-6">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <div className="text-[#9ca3af] mb-1">Current Stake</div>
                    <div className="font-semibold text-[#00FFA3]">
                      {toUiAmount((userStakeAcc?.staked_amount?.toString?.() ?? '0'), stakeMintInfo?.decimals ?? TOKEN_DECIMALS)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[#9ca3af] mb-1">Lock Until</div>
                    <div className="font-semibold text-[#9945FF] text-xs">
                      {(() => {
                        try {
                          const s = userStakeAcc.lock_until_ts?.toString?.()
                          const n = s ? parseInt(s, 10) : NaN
                          return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toLocaleString() : '—'
                        } catch {
                          return '—'
                        }
                      })()}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="bg-[#0e0f14] rounded-xl border border-[#1f2330] p-4 mb-6 text-center">
                <div className="text-sm text-[#9ca3af]">No active stake position</div>
              </div>
            )}

            <div className="mt-auto space-y-4">
              <div className="relative">
                <input 
                  className="w-full rounded-xl bg-[#0f1117] border border-[#1f2330] px-4 pr-16 py-3 text-lg font-medium text-slate-100 placeholder-[#9ca3af] focus:border-[#14F195] focus:ring-2 focus:ring-[#14F195]/50 focus:outline-none ring-offset-2 ring-offset-[#0b0c10] transition-colors" 
                  placeholder="0.00" 
                  value={unstakeAmt} 
                  onChange={(e) => setUnstakeAmt(e.target.value)} 
                />
                <button 
                  className="absolute right-3 top-1/2 -translate-y-1/2 px-3 py-2 rounded-lg bg-[#0f1117] border border-[#1f2330] text-xs sm:text-sm font-medium hover:border-[#14F195] hover:bg-[#141821] transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-[#14F195]/60 ring-offset-2 ring-offset-[#0b0c10]"
                  onClick={() => { 
                    if (userStakeAcc) setUnstakeAmt(toUiAmount((userStakeAcc?.staked_amount?.toString?.() ?? '0'), stakeMintInfo?.decimals ?? TOKEN_DECIMALS)) 
                  }}
                >
                  Max
                </button>
              </div>
<div className="text-xs text-[#9ca3af] flex items-center justify-between">
  <div>
    {remainingLockSec > 0 ? (() => { const m = Math.floor(remainingLockSec / 60); const s = remainingLockSec % 60; return `Remaining lock: ${m}m ${s}s`; })() : 'No active lock'}
  </div>
  <div>
    {(() => {
      try {
        const penaltyBps = Number(configAcc?.earlyUnstakePenaltyBps ?? configAcc?.early_unstake_penalty_bps ?? 0)
        if (!penaltyBps || penaltyBps <= 0 || remainingLockSec <= 0) return null
        let amountBN = new anchor.BN(0)
        try { amountBN = parseAmountToBN(unstakeAmt, stakeMintInfo?.decimals ?? TOKEN_DECIMALS) } catch { /* ignore parse errors */ }
        if (amountBN.lte(new anchor.BN(0))) return `Penalty if you unstake now: ${bpsToPercent(penaltyBps)}`
        const penalty = amountBN.mul(new anchor.BN(penaltyBps)).div(new anchor.BN(10000))
        const penaltyUi = toUiAmount(penalty.toString(), stakeMintInfo?.decimals ?? TOKEN_DECIMALS)
        return `Penalty if you unstake now: ${bpsToPercent(penaltyBps)} ≈ ${penaltyUi} SPL`
      } catch { return null }
    })()}
  </div>
</div>
<button
  className="w-full mt-3 px-6 py-3 rounded-xl bg-gradient-to-r from-[#ff6b6b] to-[#9945FF] text-[#0b0c10] font-semibold text-lg hover:shadow-lg hover:shadow-[#ff6b6b]/20 transition-all duration-200 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-[#14F195]/70 ring-offset-2 ring-offset-[#0b0c10]"
  onClick={onUnstake}
  disabled={loadingUnstake || !canUnstake}
>
  {loadingUnstake ? 'Signing Transaction...' : 'Unstake Tokens'}
</button>
{!canUnstake && (
  <div className="mt-2 text-xs text-[#9ca3af]">
    You have no active position to unstake.
  </div>
)}
            </div>
          </div>
          </div>
        
          {/* Rewards Section */}
          <div className="mt-8 bg-gradient-to-br from-[#111318] to-[#0e0f14] rounded-2xl border border-[#1f2330] p-6 shadow-lg overflow-hidden">
            <h2 className="text-xl font-semibold text-slate-100 mb-4 flex items-center">
              <div className="w-2 h-2 bg-[#00FFA3] rounded-full mr-3"></div>
              Claim Rewards
            </h2>
            <p className="text-sm text-[#9ca3af] mb-6">
              Claim rewards minted by the program PDA. Ensure you have a reward ATA.
            </p>
            <div className="bg-[#0e0f14] rounded-xl border border-[#1f2330] p-4 mb-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <div className="text-[#9ca3af] mb-1">Pending Rewards</div>
                  <div className="font-semibold text-[#00FFA3]">{pendingRewardsUi}</div>
                </div>
                <div>
                  <div className="text-[#9ca3af] mb-1">Reward ATA</div>
                  <div className="font-semibold text-slate-100">{rewardAtaExists ? 'Created' : 'Not created'}</div>
                </div>
                <div>
                  <div className="text-[#9ca3af] mb-1">Stake ATA</div>
                  <div className="font-semibold text-slate-100">{stakeAtaExists ? 'Created' : 'Not created'}</div>
                </div>
              </div>
              {!hasPendingRewards && <div className="text-xs text-[#9ca3af] mt-2">No pending rewards to claim.</div>}
            </div>
            <button 
              className="w-full px-6 py-3 rounded-xl bg-gradient-to-r from-[#00FFA3] to-[#14F195] text-[#0b0c10] font-semibold text-lg hover:shadow-lg hover:shadow-[#00FFA3]/20 transition-all duration-200 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-[#14F195]/70 ring-offset-2 ring-offset-[#0b0c10]" 
              onClick={onClaim} 
              disabled={loadingClaim || !userStakeAcc || !hasPendingRewards}
            >
              {loadingClaim ? 'Signing Transaction...' : 'Claim Rewards'}
            </button>
          </div>
        </div>
      </div>

      {/* Technical Information */}
      <div className="mt-12">
        <h2 className="text-2xl font-bold text-slate-100 mb-6 text-center">Technical Information</h2>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          {/* Stake Mint Info */}
          <div className="bg-gradient-to-br from-[#111318] to-[#0e0f14] rounded-2xl border border-[#1f2330] p-6 shadow-lg overflow-hidden">
            <h3 className="text-lg font-semibold text-slate-100 mb-4 flex items-center">
              <div className="w-2 h-2 bg-[#9945FF] rounded-full mr-3"></div>
              Stake Mint
            </h3>
            <div className="space-y-3 text-sm">
              <div className="bg-[#0e0f14] rounded-lg p-3 font-mono text-xs break-all text-[#9ca3af]">
                {stakeMint.toBase58()}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-[#9ca3af] text-xs">Decimals</div>
                  <div className="font-semibold">{stakeMintInfo?.decimals ?? TOKEN_DECIMALS}</div>
                </div>
                <div>
                  <div className="text-[#9ca3af] text-xs">Supply</div>
                  <div className="font-semibold">{stakeMintInfo ? toUiAmount((stakeMintInfo?.supply?.toString?.() ?? '0'), stakeMintInfo.decimals) : '—'}</div>
                </div>
              </div>
            </div>
          </div>

          {/* Reward Mint Info */}
          <div className="bg-gradient-to-br from-[#111318] to-[#0e0f14] rounded-2xl border border-[#1f2330] p-6 shadow-lg overflow-hidden">
            <h3 className="text-lg font-semibold text-slate-100 mb-4 flex items-center">
              <div className="w-2 h-2 bg-[#00FFA3] rounded-full mr-3"></div>
              Reward Mint
            </h3>
            <div className="space-y-3 text-sm">
              <div className="bg-[#0e0f14] rounded-lg p-3 font-mono text-xs break-all text-[#9ca3af]">
                {rewardMint.toBase58()}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-[#9ca3af] text-xs">Decimals</div>
                  <div className="font-semibold">{rewardMintInfo?.decimals ?? TOKEN_DECIMALS}</div>
                </div>
                <div>
                  <div className="text-[#9ca3af] text-xs">Supply</div>
                  <div className="font-semibold">{rewardMintInfo ? toUiAmount((rewardMintInfo?.supply?.toString?.() ?? '0'), rewardMintInfo.decimals) : '—'}</div>
                </div>
              </div>
            </div>
          </div>

          {/* Program Info */}
          <div className="bg-gradient-to-br from-[#111318] to-[#0e0f14] rounded-2xl border border-[#1f2330] p-6 shadow-lg overflow-hidden md:col-span-2 lg:col-span-1">
            <h3 className="text-lg font-semibold text-slate-100 mb-4 flex items-center">
              <div className="w-2 h-2 bg-[#14F195] rounded-full mr-3"></div>
              Program Details
            </h3>
            <div className="space-y-3 text-sm">
              <div>
                <div className="text-[#9ca3af] text-xs mb-1">Program ID</div>
                <div className="bg-[#0e0f14] rounded-lg p-2 font-mono text-xs break-all text-[#9ca3af]">
                  {programId.toBase58()}
                </div>
              </div>
              <div>
                <div className="text-[#9ca3af] text-xs mb-1">Network</div>
                <div className="font-semibold text-[#14F195]">Devnet</div>
              </div>
            </div>
          </div>
        </div>

        {/* PDAs Section - Collapsible */}
        <details className="mt-6 bg-gradient-to-br from-[#111318] to-[#0e0f14] rounded-2xl border border-[#1f2330] shadow-lg">
          <summary className="p-6 cursor-pointer hover:bg-[#141821] transition-colors rounded-2xl focus:outline-none focus:ring-2 focus:ring-[#14F195]/60 ring-offset-2 ring-offset-[#0b0c10]">
            <span className="text-lg font-semibold text-slate-100 flex items-center">
              <div className="w-2 h-2 bg-[#ff6b6b] rounded-full mr-3"></div>
              Program Derived Addresses (PDAs)
            </span>
          </summary>
          <div className="px-6 pb-6 space-y-3">
            <div className="grid md:grid-cols-2 gap-4 text-sm">
              <div>
                <div className="text-[#9ca3af] text-xs mb-1">Config PDA</div>
                <div className="bg-[#0e0f14] rounded-lg p-2 font-mono text-xs break-all text-[#9ca3af]">
                  {configPda?.toBase58() ?? '—'}
                </div>
              </div>
              <div>
                <div className="text-[#9ca3af] text-xs mb-1">Stake Vault PDA</div>
                <div className="bg-[#0e0f14] rounded-lg p-2 font-mono text-xs break-all text-[#9ca3af]">
                  {stakeVaultPda?.toBase58() ?? '—'}
                </div>
              </div>
              <div>
                <div className="text-[#9ca3af] text-xs mb-1">Penalty Vault PDA</div>
                <div className="bg-[#0e0f14] rounded-lg p-2 font-mono text-xs break-all text-[#9ca3af]">
                  {penaltyVaultPda?.toBase58() ?? '—'}
                </div>
              </div>
              <div>
                <div className="text-[#9ca3af] text-xs mb-1">Reward Authority PDA</div>
                <div className="bg-[#0e0f14] rounded-lg p-2 font-mono text-xs break-all text-[#9ca3af]">
                  {rewardAuthPda?.toBase58() ?? '—'}
                </div>
              </div>
              <div className="md:col-span-2">
                <div className="text-[#9ca3af] text-xs mb-1">User Stake PDA</div>
                <div className="bg-[#0e0f14] rounded-lg p-2 font-mono text-xs break-all text-[#9ca3af]">
                  {userStakePda?.toBase58() ?? '—'}
                </div>
              </div>
            </div>
          </div>
        </details>
      </div>
    </div>
  )
}

