# StakeFlow Frontend

Production-grade React + Vite frontend for a Solana staking dApp (Anchor-based). It delivers a streamlined UX for staking SPL tokens, claiming rewards, and managing associated token accounts (ATAs) on devnet. Pairs with the on-chain program in the sibling `stake-flow` repo and includes an optional serverless mint endpoint for admin/dev workflows.

## Table of Contents

- [Overview](#overview)
- [Highlights](#highlights)
- [Tech Stack](#tech-stack)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Environment Variables](#environment-variables)
- [Project Structure](#project-structure)
- [Staking Flows](#staking-flows)
- [Serverless Mint](#serverless-mint)
- [Development](#development)
- [Deployment](#deployment)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Accessibility & UX](#accessibility--ux)
- [Browser Support](#browser-support)
- [Contributing](#contributing)
- [Acknowledgments](#acknowledgments)

## Overview

- Devnet-first UI built around Anchor IDL and PDAs/ATAs.
- Works with Phantom and Solflare via Solana Wallet Adapter.
- Clean error handling, deduplicated toasts, and accessible defaults.

## Highlights

- Modern stack: React 19, Vite 7, TypeScript, TailwindCSS.
- Wallet Adapter UI with refined overrides in `src/index.css`.
- IDL-driven program interactions, PDAs and ATAs handled automatically.
- Developer-friendly: local API emulation, clear logs, Solscan links.

## Tech Stack

- React 19, TypeScript, Vite 7
- TailwindCSS (utility-first; UI overrides for wallet components)
- Solana Wallet Adapter, `@solana/web3.js`, `@solana/spl-token`
- Anchor IDL (`src/idl/stake_flow.json`)
- React Hot Toast for notifications

## Quick Start

- Prerequisites
  - Node.js 18+
  - Phantom or Solflare wallet configured for `devnet`
- Install & Run
  - `npm install`
  - `npm run dev`
  - Open the preview URL and connect your wallet

## Configuration

- Program and mints (devnet) are defined in `src/config.ts`:
  - `STAKE_FLOW_PROGRAM_ID = "4cUDbCQvhBSzWbTivv3ZscDkePVweqRFAHbgDUKLkfdK"`
  - `STAKE_MINT_ADDRESS = "BeyV4AuCPvchhJc7NXSaAa2ECbPVkj39wy9CY7fu8opD"`
  - `REWARD_MINT_ADDRESS = "GQCW1M9szh426zC5a51BLZbPhvXoPnMKCeRWepyCziK3"`
  - `TOKEN_DECIMALS = 9`
- Transaction explorer: `solscanTxUrl(sig)` (targets `devnet`).

## Environment Variables

- Located in `.env` for local development. Do not commit production secrets.
- Keys
  - `VITE_ENABLE_STAKE_FAUCET` — show devnet faucet UI in the app
  - `MINT_NETWORK` — cluster, e.g., `devnet`
  - `RPC_URL` — optional RPC endpoint (defaults per cluster)
  - `MINT_ADDRESS` — SPL mint used for stake token
  - `MINT_DECIMALS` — token decimals (e.g., `9`)
  - `MINT_AUTHORITY_SECRET_KEY` — mint authority private key (base58 or JSON array); set only in provider env
  - `MAX_MINT_PER_REQUEST` — upper bound for per-request minting
- Example

```
VITE_ENABLE_STAKE_FAUCET=true
MINT_NETWORK=devnet
RPC_URL=
MINT_ADDRESS=BeyV4AuCPvchhJc7NXSaAa2ECbPVkj39wy9CY7fu8opD
MINT_DECIMALS=9
MINT_AUTHORITY_SECRET_KEY=...[base58 or JSON array]...
MAX_MINT_PER_REQUEST=100
```

## Project Structure

- `src/App.tsx` — shell, header, wallet gate, routing to `StakeFlowUI`
- `src/components/StakeFlowUI.tsx` — core staking UI and flows
- `src/utils/` — PDAs, tokens, formatting, error handling helpers
- `src/idl/` — Anchor IDL JSON for the program
- `src/config.ts` — program/mint addresses and Solscan helper
- `api/mint.ts` — optional serverless mint endpoint (Node runtime)
- `vite.config.ts` — dev server middleware for local API emulation

## Staking Flows

- Stake
  - Enter amount, ensure Stake ATA exists, verify balance, submit stake instruction
  - View position details (amount, pending rewards, lock until)
- Claim
  - PDA mints rewards to your Reward ATA; app polls for finalized state
  - Solscan link opens after success
- Unstake
  - Early-unstake penalty applies and transfers to the penalty vault
  - Net amount returns to user’s Stake ATA; position updates accordingly

## Serverless Mint

- Overview
  - `api/mint.ts` mints stake tokens to a connected wallet (devnet-only)
  - Local API emulation maps `/api/*` to files in `api/` via `vite.config.ts`
- Request Contract (`POST /api/mint.ts`)
  - Fields: `wallet`, `amount`, `signature` (base58), `timestamp` (ms)
  - Response: `transaction` (base64), `lastValidBlockHeight`, optional `simulationLogs`
- Client Example (React + Wallet Adapter)

```ts
import bs58 from 'bs58'
import { useWallet } from '@solana/wallet-adapter-react'

async function requestMint(amountUi: number) {
  const { publicKey, wallet } = useWallet()
  if (!publicKey || !wallet?.adapter?.signMessage) throw new Error('Wallet not ready or does not support signMessage')

  const timestamp = Date.now()
  const message = `stakeflow-mint:${publicKey.toBase58()}:${timestamp}`
  const encoded = new TextEncoder().encode(message)
  const signature = await wallet.adapter.signMessage(encoded)

  const res = await fetch('/api/mint.ts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wallet: publicKey.toBase58(), amount: amountUi, signature: bs58.encode(signature), timestamp }),
  })

  const json = await res.json()
  if (!res.ok) throw new Error(json?.error || 'Mint request failed')
  return json
}
```

## Development

- Scripts
  - `npm run dev` — start dev server
  - `npm run build` — typecheck and build production bundle
  - `npm run preview` — preview production build locally
  - `npm run lint` — run ESLint
- Styling
  - TailwindCSS for layout and visuals; wallet UI overrides in `src/index.css`
- Error Handling
  - Centralized handling in `src/main.tsx` and `src/App.tsx`
  - `src/utils/errors.ts` normalizes common cases and messages

## Deployment

- Vercel (recommended)
  - Configure environment variables in Project Settings (do not commit secrets)
  - Use default build (`vite build`) and preview (`vite preview`) commands
  - `api/mint.ts` runs in Vercel’s Node runtime
- Other Hosts
  - Any static host that serves `dist/` works
  - For serverless endpoints, adapt the dev middleware or move API code to your host’s functions

## Troubleshooting

- Wallet not found: install/open Phantom or Solflare; ensure extension is active
- Connection issues: switch to `devnet`, check RPC availability, and retry
- Insufficient funds: use Solana devnet faucet to get SOL for fees
- Transaction errors: read toast messages and console logs; update wallet for v0 support

## Security

- Never commit real `MINT_AUTHORITY_SECRET_KEY` to source control
- Keep the mint endpoint to development; apply rate limiting and server-side checks if ever exposed
- Update wallets and dependencies to maintain v0 transactions and `signMessage` support

## Accessibility & UX

- High-contrast dark theme; focus rings on interactive elements
- Toasts provide immediate feedback; prompts deduplicated under React StrictMode

## Browser Support

- Modern evergreen browsers (Chrome, Edge, Firefox, Safari) on desktop
- Wallet adapters depend on extension availability and recent versions

## Contributing

- Run `npm run lint` and ensure no errors before a PR
- Keep changes minimal and focused; avoid unrelated refactors
- Document new env variables or config in this README

## Acknowledgments

- Built on Solana, Anchor, and Solana Wallet Adapter
- UI tuned for clarity, speed, and developer-friendly testing on devnet
