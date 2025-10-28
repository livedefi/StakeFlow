import * as anchor from "@coral-xyz/anchor";
import { getMint, getAssociatedTokenAddress, getAccount, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { stakeConfig } from "../config";

function formatAmount(raw: bigint, decimals: number): string {
  const d = BigInt(10) ** BigInt(decimals);
  const integer = raw / d;
  const frac = raw % d;
  const fracStr = frac.toString().padStart(decimals, "0");
  const trimmedFrac = decimals > 0 ? fracStr.replace(/0+$/, "") : "";
  return trimmedFrac.length ? `${integer.toString()}.${trimmedFrac}` : integer.toString();
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;
  const wallet = provider.wallet;

  console.log("RPC:", (connection as any)._rpcEndpoint);
  console.log("Wallet:", wallet.publicKey.toBase58());

  const mints = [
    { label: "Stake", address: new PublicKey(stakeConfig.stakeMintAddress) },
    { label: "Reward", address: new PublicKey(stakeConfig.rewardMintAddress) },
  ];

  for (const m of mints) {
    console.log(`\n== ${m.label} Mint Info ==`);
    const mintInfo = await getMint(connection, m.address, "confirmed");
    const mintAuthority = mintInfo.mintAuthority ? mintInfo.mintAuthority.toBase58() : null;
    const freezeAuthority = mintInfo.freezeAuthority ? mintInfo.freezeAuthority.toBase58() : null;
    const supplyRaw = mintInfo.supply;
    const decimals = mintInfo.decimals;

    console.log("Mint:", m.address.toBase58());
    console.log("Decimals:", decimals);
    console.log("Supply (raw):", supplyRaw.toString());
    console.log("Supply:", formatAmount(supplyRaw, decimals));
    console.log("Mint authority:", mintAuthority);
    console.log("Freeze authority:", freezeAuthority);

    const ata = await getAssociatedTokenAddress(
      m.address,
      wallet.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    console.log("Owner ATA:", ata.toBase58());

    try {
      const acc = await getAccount(connection, ata, "confirmed");
      console.log("ATA exists. Balance (raw):", acc.amount.toString());
      console.log("ATA balance:", formatAmount(acc.amount, decimals));
    } catch (e) {
      console.log("ATA does not exist. Create it:");
      console.log(`spl-token create-account ${m.address.toBase58()} --url https://api.devnet.solana.com`);
    }
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error("token-info failed:", e);
    process.exit(1);
  });
}