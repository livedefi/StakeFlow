import { PublicKey } from '@solana/web3.js'

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

export function findConfigPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([utf8('config')], programId)
}

export function findStakeVaultPda(programId: PublicKey, config: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([utf8('stake_vault'), config.toBuffer()], programId)
}

export function findPenaltyVaultPda(programId: PublicKey, config: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([utf8('penalty_vault'), config.toBuffer()], programId)
}

export function findRewardMintAuthPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([utf8('reward_mint_authority')], programId)
}

export function findUserStakePda(programId: PublicKey, owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([utf8('user'), owner.toBuffer()], programId)
}