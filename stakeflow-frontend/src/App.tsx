import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import { useWallet } from '@solana/wallet-adapter-react'
import { useEffect, useRef } from 'react'
import toast, { Toaster } from 'react-hot-toast'
import StakeFlowUI from './components/StakeFlowUI'
import { isUserRejected, buildFriendlyMessage, logWalletError } from './utils/errors'
import type { WalletAdapter } from '@solana/wallet-adapter-base'

type PhantomProvider = {
  on?: (event: 'accountChanged' | 'networkChanged', handler: (...args: unknown[]) => void) => void
  off?: (event: 'accountChanged' | 'networkChanged', handler: (...args: unknown[]) => void) => void
} | undefined

function App() {
  const { connected, connecting, disconnecting, publicKey, wallet } = useWallet()
  const shortKey = publicKey ? `${publicKey.toBase58().slice(0,4)}…${publicKey.toBase58().slice(-4)}` : ''

  // Handle wallet connection errors
  useEffect(() => {
    const adapter: WalletAdapter | undefined = wallet?.adapter
    if (!adapter) return
  
    const onError = (e: unknown) => {
      if (isUserRejected(e)) {
        // Silence here; WalletProvider.onError in main.tsx shows the toast
        logWalletError(e, 'wallet-connection')
        return
      }
      const fallback = buildFriendlyMessage(e, 'Wallet error. Check console for details.')
      const msgLower = (() => {
        if (typeof e === 'string') return e.toLowerCase()
        const m = (e as { message?: string })?.message || String(e)
        return m.toLowerCase()
      })()
      if (msgLower.includes('wallet not found')) {
        toast.error('Wallet not found. Install or open your wallet.', { duration: 5000, id: 'wallet-not-found' })
        return
      }
      if (msgLower.includes('connection failed') || msgLower.includes('disconnected')) {
        toast.error('Wallet connection failed. Try again.', { duration: 5000, id: 'wallet-connection-failed' })
        return
      }
      logWalletError(e, 'wallet-connection')
      toast.error(fallback, { duration: 5000, id: 'wallet-connection-error' })
    }
  
    adapter.on('error', onError)
    return () => { adapter.off('error', onError) }
  }, [wallet])

  // Ensure UI updates when the wallet account changes (e.g., Phantom switches account)
  useEffect(() => {
    const adapter: WalletAdapter | undefined = wallet?.adapter
    if (!adapter) return
    const onAccountChanged = async () => {
      try {
        // If not connected and not connecting, try to connect.
        if (!connected && !connecting) {
          await adapter.connect?.()
        }
        // When already connected, wallet-adapter should update publicKey; UI listens and refreshes.
      } catch {
        // Swallow errors; prompts/cancellations handled by wallet-adapter
      }
    }
    const eventAdapter = adapter as unknown as {
      on?: (event: string, handler: (...args: unknown[]) => void) => void
      off?: (event: string, handler: (...args: unknown[]) => void) => void
    }
    eventAdapter.on?.('accountChanged', onAccountChanged)
    eventAdapter.on?.('networkChanged', onAccountChanged)
    const phantom = (window as unknown as { solana?: PhantomProvider }).solana
    phantom?.on?.('accountChanged', onAccountChanged)
    phantom?.on?.('networkChanged', onAccountChanged)
    return () => {
      eventAdapter.off?.('accountChanged', onAccountChanged)
      eventAdapter.off?.('networkChanged', onAccountChanged)
      phantom?.off?.('accountChanged', onAccountChanged)
      phantom?.off?.('networkChanged', onAccountChanged)
    }
  }, [wallet, connected, connecting])

  // Deduplicate success/prompt toasts under StrictMode
  const connectToastShownRef = useRef(false)
  const lastKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (connected && publicKey) {
      const pk = publicKey.toBase58()
      const alreadyShown = connectToastShownRef.current && lastKeyRef.current === pk
      if (!alreadyShown) {
        toast.success(`Wallet connected: ${shortKey}`, { id: 'wallet-connected' })
        connectToastShownRef.current = true
        lastKeyRef.current = pk
      }
    } else {
      connectToastShownRef.current = false
      lastKeyRef.current = null
      if (!connecting && !disconnecting) {
        toast('Connect your wallet to get started', { id: 'wallet-connect-prompt' })
      }
    }
  }, [connected, publicKey, connecting, disconnecting, shortKey])

  return (
    <div className="min-h-screen bg-[#0b0c10] text-white">
      <header className="sticky top-0 z-40 backdrop-blur-sm bg-[#0b0c10]/80 border-b border-[#1f2330]">
        <div className="max-w-6xl mx-auto flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            <img src="/stakeflow-logo.svg" alt="StakeFlow" className="h-6 w-6" />
            <span className="text-lg font-semibold tracking-tight">StakeFlow</span>
          </div>
          {/* Show header connect button only when connected, to avoid duplication */}
          {connected ? (
            <WalletMultiButton
              key={publicKey?.toBase58() ?? 'wallet-header'}
              className="!px-4 !py-2 !rounded-xl !bg-[#141821] !border !border-[#2a3146] hover:!border-[#14F195] !shadow-md !transition !duration-200 !ease-out focus:!outline-none focus:!ring-2 focus:!ring-[#14F195]/70 focus:!ring-offset-2 focus:!ring-offset-[#0b0c10]"
            />
          ) : (
            <div />
          )}
        </div>
      </header>
      <main className="p-4">
        <div className="max-w-6xl mx-auto">
          {connected ? (
            <StakeFlowUI key={publicKey?.toBase58() ?? 'disconnected'} />
          ) : (
            <div className="min-h-[60vh] flex items-center justify-center p-4">
              <div className="relative w-full max-w-xl overflow-hidden rounded-2xl border border-[#1f2330] bg-gradient-to-br from-[#0f1117] to-[#0b0c10] shadow-xl">
                <div className="absolute -top-24 -right-24 w-72 h-72 bg-gradient-to-tr from-[#9945FF]/30 via-[#14F195]/30 to-[#00FFA3]/30 blur-3xl rounded-full opacity-40" aria-hidden="true" />
                <div className="p-6 sm:p-8 text-center">
                  <div className="h-px bg-gradient-to-r from-[#9945FF]/30 via-[#14F195]/30 to-[#00FFA3]/30 rounded-full mb-6" />
                  <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">Connect your wallet</h1>
                  <p className="mt-3 text-sm sm:text-base text-[#9ca3af] max-w-prose mx-auto">
                    Connect your Solana wallet to stake tokens, claim rewards, and manage your accounts.
                  </p>
                  <div className="mt-6 flex justify-center">
                    <WalletMultiButton
                      key={publicKey?.toBase58() ?? 'wallet-main'}
                      className="!px-7 !py-3 !text-base !rounded-xl !bg-[#141821] !border !border-[#2a3146] hover:!border-[#14F195] !shadow-lg !transition !duration-200 !ease-out focus:!outline-none focus:!ring-2 focus:!ring-[#14F195]/70 focus:!ring-offset-2 focus:!ring-offset-[#0b0c10]"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
      <Toaster position="bottom-right" />
    </div>
  )
}

export default App
