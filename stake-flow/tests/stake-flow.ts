import * as anchor from "@coral-xyz/anchor";
import { assert } from "chai";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID, getMint, getAccount, createMint } from "@solana/spl-token";
import { stakeConfig } from "../config";

describe("stake-flow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const conn = provider.connection;
  const wallet = provider.wallet as anchor.Wallet;

  let program: any;
  let stakeMint: PublicKey;
  let rewardMint: PublicKey;
  let ownerStakeAta: PublicKey;
  let ownerRewardAta: PublicKey;
  let configPda: PublicKey;
  let stakeVaultPda: PublicKey;
  let penaltyVaultPda: PublicKey;
  let rewardAuthPda: PublicKey;
  let userStakePda: PublicKey;

  it("initialize, stake and claim", async () => {
    program = (anchor.workspace as any).StakeFlow || (anchor.workspace as any).stake_flow;


    // Create local mints instead of using devnet addresses
    stakeMint = await createMint(conn, (wallet as any).payer, wallet.publicKey, null, 9);
    rewardMint = await createMint(conn, (wallet as any).payer, wallet.publicKey, null, 9);

    try {
      const sig = await conn.requestAirdrop(wallet.publicKey, 1_000_000_000);
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
      await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    } catch (e) {
      const bal = await conn.getBalance(wallet.publicKey, "processed");
      assert.isTrue(bal >= 100_000_000, "Airdrop failed and insufficient balance");
    }

    ownerStakeAta = (await getOrCreateAssociatedTokenAccount(conn, (wallet as any).payer, stakeMint, wallet.publicKey)).address;
    ownerRewardAta = (await getOrCreateAssociatedTokenAccount(conn, (wallet as any).payer, rewardMint, wallet.publicKey)).address;

    // Verify ATAs minted for the correct mints and start with amount 0
    const ownerStakeInfoBefore = await getAccount(conn, ownerStakeAta);
    assert.equal(ownerStakeInfoBefore.mint.toBase58(), stakeMint.toBase58(), "ownerStakeAta mint should be stake mint");
    assert.equal(ownerStakeInfoBefore.amount.toString(), "0", "ownerStakeAta should start empty");

    const ownerRewardInfoBefore = await getAccount(conn, ownerRewardAta);
    assert.equal(ownerRewardInfoBefore.mint.toBase58(), rewardMint.toBase58(), "ownerRewardAta mint should be reward mint");
    assert.equal(ownerRewardInfoBefore.amount.toString(), "0", "ownerRewardAta should start empty");

    const pid = program.programId as PublicKey;
    [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], pid);
    [stakeVaultPda] = PublicKey.findProgramAddressSync([Buffer.from("stake_vault"), configPda.toBuffer()], pid);
    [penaltyVaultPda] = PublicKey.findProgramAddressSync([Buffer.from("penalty_vault"), configPda.toBuffer()], pid);
    [rewardAuthPda] = PublicKey.findProgramAddressSync([Buffer.from("reward_mint_authority")], pid);
    [userStakePda] = PublicKey.findProgramAddressSync([Buffer.from("user"), wallet.publicKey.toBuffer()], pid);

    await program.methods.initializeConfig(stakeConfig.aprBps, new anchor.BN(stakeConfig.minLockDuration), stakeConfig.earlyUnstakePenaltyBps).accounts({
      admin: wallet.publicKey,
      stakeMint,
      rewardMint,
      config: configPda,
      stakeVault: stakeVaultPda,
      penaltyVault: penaltyVaultPda,
      rewardMintAuthority: rewardAuthPda,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    }).rpc();

    // Verify reward mint authority migrated to PDA
    const rewardInfo = await getMint(conn, rewardMint);
    assert.equal(rewardInfo.mintAuthority?.toBase58(), rewardAuthPda.toBase58(), "reward mint authority should be PDA");

    // Verify vault accounts owner and mint
    const stakeVaultInfo = await getAccount(conn, stakeVaultPda);
    assert.equal(stakeVaultInfo.owner.toBase58(), configPda.toBase58(), "stake_vault owner should be config PDA");
    assert.equal(stakeVaultInfo.mint.toBase58(), stakeMint.toBase58(), "stake_vault mint should be stake mint");
    assert.equal(stakeVaultInfo.amount.toString(), "0", "stake_vault should start empty");

    const penaltyVaultInfo = await getAccount(conn, penaltyVaultPda);
    assert.equal(penaltyVaultInfo.owner.toBase58(), configPda.toBase58(), "penalty_vault owner should be config PDA");
    assert.equal(penaltyVaultInfo.mint.toBase58(), stakeMint.toBase58(), "penalty_vault mint should be stake mint");
    assert.equal(penaltyVaultInfo.amount.toString(), "0", "penalty_vault should start empty");

    await program.methods.createUserStake().accounts({
      owner: wallet.publicKey,
      config: configPda,
      userStake: userStakePda,
      systemProgram: SystemProgram.programId,
    }).rpc();

    // Mint stake tokens to the user's ATA (requires mint authority to be provider wallet)
    await mintTo(conn, (wallet as any).payer, stakeMint, ownerStakeAta, wallet.publicKey, 1_000_000_000);
    const ownerStakeInfoAfterMint = await getAccount(conn, ownerStakeAta);
    assert.equal(ownerStakeInfoAfterMint.amount.toString(), "1000000000", "ownerStakeAta should receive minted stake tokens");

    await program.methods.stake(new anchor.BN(200_000_000)).accounts({
      owner: wallet.publicKey,
      config: configPda,
      stakeVault: stakeVaultPda,
      ownerStakeAta,
      userStake: userStakePda,
      tokenProgram: TOKEN_PROGRAM_ID,
    }).rpc();

    // After stake, vault should reflect staked amount
    const stakeVaultInfoAfterStake = await getAccount(conn, stakeVaultPda);
    assert.equal(stakeVaultInfoAfterStake.amount.toString(), "200000000", "stake_vault should hold staked amount");

    await new Promise((r) => setTimeout(r, 2000));

    const stakedAmount = 200_000_000;
    const aprBps = stakeConfig.aprBps;
    const secondsPerYear = 365 * 24 * 60 * 60;

    const userStakeBeforeClaim = await program.account.userStake.fetch(userStakePda);

    await program.methods.claimRewards().accounts({
      owner: wallet.publicKey,
      config: configPda,
      userStake: userStakePda,
      rewardMint,
      ownerRewardAta,
      rewardMintAuthority: rewardAuthPda,
      tokenProgram: TOKEN_PROGRAM_ID,
    }).rpc();

    const userStakeAfterClaim1 = await program.account.userStake.fetch(userStakePda);
    const elapsed1 = (userStakeAfterClaim1.lastUpdateTs as any).toNumber() - (userStakeBeforeClaim.lastUpdateTs as any).toNumber();
    const expectedRewards1 = Math.floor(stakedAmount * elapsed1 * aprBps / (secondsPerYear * 10_000));

    const ownerRewardInfoAfter1 = await getAccount(conn, ownerRewardAta);
    assert.equal(ownerRewardInfoAfter1.mint.toBase58(), rewardMint.toBase58(), "ownerRewardAta should be for reward mint");
    const rewardAfterFirstClaim = parseInt(ownerRewardInfoAfter1.amount.toString(), 10);
    const diff1 = Math.abs(rewardAfterFirstClaim - expectedRewards1);
    assert.isAtMost(diff1, 1, "claimed rewards should match APR*time within ±1");

    await new Promise((r) => setTimeout(r, 8000));

    await program.methods.claimRewards().accounts({
      owner: wallet.publicKey,
      config: configPda,
      userStake: userStakePda,
      rewardMint,
      ownerRewardAta,
      rewardMintAuthority: rewardAuthPda,
      tokenProgram: TOKEN_PROGRAM_ID,
    }).rpc();
    const userStakeAfterClaim2 = await program.account.userStake.fetch(userStakePda);
    const elapsed2 = (userStakeAfterClaim2.lastUpdateTs as any).toNumber() - (userStakeAfterClaim1.lastUpdateTs as any).toNumber();
    const expectedRewards2 = Math.floor(stakedAmount * elapsed2 * aprBps / (secondsPerYear * 10_000));
    const ownerRewardInfoAfter2 = await getAccount(conn, ownerRewardAta);
    assert.equal(ownerRewardInfoAfter2.mint.toBase58(), rewardMint.toBase58(), "ownerRewardAta should be for reward mint");
    const totalAfterSecondClaim = parseInt(ownerRewardInfoAfter2.amount.toString(), 10);
    const incrementalSecond = totalAfterSecondClaim - rewardAfterFirstClaim;
    const diff2 = Math.abs(incrementalSecond - expectedRewards2);
    assert.isAtMost(diff2, 1, "second claim rewards should match APR*time within ±1");

  });

  it("unstake before lock applies penalty", async () => {
    // balances before
    const beforeOwnerStake = parseInt((await conn.getTokenAccountBalance(ownerStakeAta)).value.amount);
    const beforePenalty = parseInt((await conn.getTokenAccountBalance(penaltyVaultPda)).value.amount);

    const amount = new anchor.BN(50_000_000);
    await program.methods.unstake(amount).accounts({
      owner: wallet.publicKey,
      config: configPda,
      stakeVault: stakeVaultPda,
      ownerStakeAta,
      userStake: userStakePda,
      penaltyVault: penaltyVaultPda,
      tokenProgram: TOKEN_PROGRAM_ID,
    }).rpc();

    // Balances after
    const afterOwnerStake = parseInt((await conn.getTokenAccountBalance(ownerStakeAta)).value.amount);
    const afterPenalty = parseInt((await conn.getTokenAccountBalance(penaltyVaultPda)).value.amount);

    // Penalty should be applied and user receives net amount
    assert.isTrue(afterPenalty - beforePenalty > 0, "penalty vault should increase on early unstake");
    assert.isTrue(afterOwnerStake - beforeOwnerStake > 0, "owner stake ATA should receive net amount after penalty");
  });

  it("unstake after lock applies no penalty", async () => {
    await new Promise((r) => setTimeout(r, 31_000));

    // balances antes
    const beforeOwnerStake = parseInt((await conn.getTokenAccountBalance(ownerStakeAta)).value.amount);
    const beforePenalty = parseInt((await conn.getTokenAccountBalance(penaltyVaultPda)).value.amount);

    const amount = new anchor.BN(30_000_000);
    await program.methods.unstake(amount).accounts({
      owner: wallet.publicKey,
      config: configPda,
      stakeVault: stakeVaultPda,
      ownerStakeAta,
      userStake: userStakePda,
      penaltyVault: penaltyVaultPda,
      tokenProgram: TOKEN_PROGRAM_ID,
    }).rpc();
  
    // Balances after
    const afterOwnerStake = parseInt((await conn.getTokenAccountBalance(ownerStakeAta)).value.amount);
    const afterPenalty = parseInt((await conn.getTokenAccountBalance(penaltyVaultPda)).value.amount);
  
    // No penalty should apply and user receives full amount
    assert.equal(afterPenalty - beforePenalty, 0, "penalty vault should not increase after lock");
    assert.equal(afterOwnerStake - beforeOwnerStake, 30_000_000, "owner stake ATA should receive full amount after lock");
  });
});