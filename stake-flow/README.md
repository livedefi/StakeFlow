# StakeFlow

A professional Solana (Anchor) staking dApp using SPL tokens. Users stake SPL tokens and claim rewards. Configuration is stored in a PDA; reward mint authority is owned by the program PDA.

## Table of Contents
- [Overview](#overview)
- [Quick Start](#quick-start)
- [Devnet Setup](#devnet-setup)
- [Requirements](#requirements)
- [Configuration & Addresses](#configuration--addresses)
- [Anchor Scripts](#anchor-scripts)
- [SPL Token CLI (ATAs & Minting)](#spl-token-cli-atas--minting)
- [Frontend Integration](#frontend-integration)
- [Build, Deploy, Initialize](#build-deploy-initialize)
- [Testing (localnet/devnet)](#testing-localnetdevnet)
- [Logs & Verification](#logs--verification)
- [Troubleshooting](#troubleshooting)

## Quick Start
- `solana config set -u devnet`
- `spl-token create-token --decimals 9` (create your stake mint)
- `spl-token create-token --decimals 9` (create your reward mint)
- Update `config.ts` with `<YOUR_STAKE_MINT>` and `<YOUR_REWARD_MINT>`
- `spl-token create-account <YOUR_STAKE_MINT> --url https://api.devnet.solana.com`
- `spl-token create-account <YOUR_REWARD_MINT> --url https://api.devnet.solana.com`
- `anchor run init`
- `anchor run token-info`

## Requirements
- `solana-cli` >= 1.18
- `anchor` >= 0.29
- `node` >= 18, `npm` >= 9
- `ts-node` installed (dev dependency)
- TypeScript `tsconfig.json` set to `target: es2020` and `lib: ["es2020"]`

## Overview
- StakeFlow lets users deposit stake tokens and later claim rewards.
- Uses two SPL mints: `stakeMint` (user stake) and `rewardMint` (rewards).
- PDAs manage config, stake vault, penalty vault, and reward mint authority.

## Devnet Setup
- Install `solana-cli` and `spl-token`.
- Follow these steps to use your own addresses:
  - Step 1: Configure devnet:
    - `solana config set -u devnet`
    - `solana airdrop 2`
    - `solana balance`
  - Step 2: Create your SPL tokens (9 decimals):
    - Create stake mint: `spl-token create-token --decimals 9`
    - Create reward mint: `spl-token create-token --decimals 9`
    - Copy both mint addresses for the next step.
  - Step 3: Replace addresses in `config.ts`:
    - Set `stakeMintAddress` = `<YOUR_STAKE_MINT>`
    - Set `rewardMintAddress` = `<YOUR_REWARD_MINT>`
  - Step 4: Create your ATAs on devnet:
    - Stake ATA: `spl-token create-account <YOUR_STAKE_MINT> --url https://api.devnet.solana.com`
    - Reward ATA: `spl-token create-account <YOUR_REWARD_MINT> --url https://api.devnet.solana.com`
  - Step 5: Mint stake tokens (only if you are the stake mint authority):
    - `spl-token mint <YOUR_STAKE_MINT> 10 <YOUR_STAKE_ATA> --url https://api.devnet.solana.com`
  - Step 6: Initialize on-chain state:
    - `anchor run init` (migrates reward mint authority to the program PDA)
  - Step 7: Inspect and verify:
    - `anchor run token-info` (mints info and your ATAs)
    - Use Solscan for transaction signatures (`?cluster=devnet`)

## Configuration & Addresses
- Project config: `config.ts` (APR, lock duration, early-unstake penalty).
- IDL: `target/idl/stake_flow.json`
- Types: `target/types/stake_flow.ts`
- Current devnet mints:
  - `stakeMint`: `BeyV4AuCPvchhJc7NXSaAa2ECbPVkj39wy9CY7fu8opD`
  - `rewardMint`: `GQCW1M9szh426zC5a51BLZbPhvXoPnMKCeRWepyCziK3`
- Program ID prints during `anchor run init` and is stored under `target/deploy/stake_flow-keypair.json`.

## Anchor Scripts
- Token info: `anchor run token-info`
  - Prints mint authority, freeze authority, decimals, supply.
  - Shows your associated token accounts (ATAs) and balances; prints creation commands when missing.
- Initialization: `anchor run init`
  - Derives PDAs (`config`, `stake_vault`, `penalty_vault`, `reward_mint_authority`).
  - Calls `initializeConfig(aprBps, minLockDuration, earlyUnstakePenaltyBps)`.
  - Migrates `rewardMint` authority to the PDA.

## SPL Token CLI (ATAs & Minting)
Create your ATAs on devnet and mint stake tokens if you are the mint authority.

- Create ATAs (examples from this project):
  - Stake ATA: `spl-token create-account BeyV4AuCPvchhJc7NXSaAa2ECbPVkj39wy9CY7fu8opD --url https://api.devnet.solana.com`
    - Example output: `Creating account 7rkgU6o3nUzVcYp7YrzKiYzrr84YbezmdTP98G6TcgUF` and a signature.
  - Reward ATA: `spl-token create-account GQCW1M9szh426zC5a51BLZbPhvXoPnMKCeRWepyCziK3 --url https://api.devnet.solana.com`
    - Example output: `Creating account B5DNNuHoTEiRDpusgi9mJne9JkPxN4j35apSDGTHUfek` and a signature.

- Mint stake tokens (if your wallet is the stake mint authority):
  - `spl-token mint BeyV4AuCPvchhJc7NXSaAa2ECbPVkj39wy9CY7fu8opD 10 7rkgU6o3nUzVcYp7YrzKiYzrr84YbezmdTP98G6TcgUF --url https://api.devnet.solana.com`
  - Example output: `Minting 10 tokens` and signature `4kHNVb9YeHd1de8R3325Qodcy28y12aTjaE7AsDEpTGhEXFpb6En9ULN5MFxzyw6qPqrwhE6rsnA4xpmi6nzSYQb`.

- Query balances and supply:
  - List accounts: `spl-token accounts --owner <YOUR_WALLET> --url https://api.devnet.solana.com`
  - Mint supply: `spl-token supply <MINT> --url https://api.devnet.solana.com`
  - ATA balance: `spl-token balance <ATA> --url https://api.devnet.solana.com`

- Authority notes:
  - `rewardMint` is owned by the program PDA; you cannot mint via CLI. Rewards must be issued by the program instruction.
  - `stakeMint` can be minted via CLI if your wallet is its `mintAuthority`.

## Frontend Integration
- Use `@coral-xyz/anchor` with the `stake_flow` IDL and program ID.
- Respect types: pass `i64` as `anchor.BN` (e.g., `min_lock_duration`) and `u16` as numbers.
- Ensure the wallet has a stake ATA with balance before calling `stake`.
- Rewards are minted by the program (signed by the `reward_mint_authority` PDA).



Notes:
- Path to IDL may differ in your frontend; ensure bundler can load it.
- Derive exact accounts from `target/idl/stake_flow.json`.
- Use `new BN(...)` for `u64/i64` amounts and durations.

## Build, Deploy, Initialize
- Set provider in `Anchor.toml`:
  - `[provider] cluster = "devnet"`, `wallet = "~/.config/solana/id.json"` (or your path).
- Deploy on devnet:
  - `anchor build`
  - `anchor deploy`
- Initialize on-chain state:
  - `anchor run init`
  - Re-running may show `account already in use` for `config` PDA; expected if already initialized.

## Testing (localnet/devnet)
- Recommended: run tests on localnet to avoid external rate limits.
  - In `Anchor.toml`, use `cluster = "localnet"` and a valid `wallet`.
  - Run: `anchor test` (creates local mints, PDAs, and accounts).
- Devnet tests:
  - Align tests with `config.ts` mints and remove local `createMint` calls.
  - Be aware of faucet/RPC rate limits; retry if needed.

## Logs & Verification
- Program logs: `.anchor/program-logs/` or `solana logs`.
- Inspect transactions: `https://solscan.io/tx/<SIGNATURE>?cluster=devnet`.
- Use `anchor run token-info` to verify mint authorities, decimals, supply and ATAs.

## Troubleshooting
- `TypeError: src.toTwos is not a function`: An `i64` was passed as a number; use `new anchor.BN(...)`.
- `Allocate: account already in use`: Config PDA already exists; harmless when re-initializing.
- `bigint: Failed to load bindings`: Benign warning from `bn.js`; pure JS path is used.
- Older `spl-token` versions may lack `mint-info`/`account-info`; use `supply`, `accounts`, `balance`.

