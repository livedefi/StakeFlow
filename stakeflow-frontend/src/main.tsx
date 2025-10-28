import './polyfills'
import ReactDOM from 'react-dom/client'
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react'
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui'
import { PhantomWalletAdapter, SolflareWalletAdapter } from '@solana/wallet-adapter-wallets'
import App from './App'
import './index.css'
import '@solana/wallet-adapter-react-ui/styles.css'
import { buildFriendlyMessage, logWalletError } from './utils/errors'
import { toast } from 'react-hot-toast'

const endpoint = (import.meta.env.VITE_RPC_ENDPOINT as string) || 'https://api.devnet.solana.com'

function onWalletError(e: unknown) {
  if (!e) return
  const friendly = buildFriendlyMessage(e, 'Wallet error.')
  logWalletError(e, 'WalletProvider')
  toast.error(friendly, { id: 'wallet-provider-error' })
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ConnectionProvider endpoint={endpoint} config={{ commitment: 'confirmed' }}>
    <WalletProvider
      wallets={[new PhantomWalletAdapter(), new SolflareWalletAdapter()]}
      autoConnect={false}
      onError={onWalletError}
    >
      <WalletModalProvider>
        <App />
      </WalletModalProvider>
    </WalletProvider>
  </ConnectionProvider>,
)
