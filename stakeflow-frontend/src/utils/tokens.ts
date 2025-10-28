import { PublicKey, TransactionInstruction, Connection } from '@solana/web3.js'
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, getAccount, getMint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token'
import type { Account, Mint } from '@solana/spl-token'

export async function getAtaAddress(mint: PublicKey, owner: PublicKey): Promise<PublicKey> {
  return await getAssociatedTokenAddress(mint, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)
}

export function buildCreateAtaIx(payer: PublicKey, ata: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
  return createAssociatedTokenAccountInstruction(payer, ata, owner, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)
}

export async function tryGetAccount(connection: Connection, ata: PublicKey): Promise<Account | null> {
  try {
    return await getAccount(connection, ata)
  } catch {
    return null
  }
}

export async function getMintInfo(connection: Connection, mint: PublicKey): Promise<Mint> {
  return await getMint(connection, mint)
}