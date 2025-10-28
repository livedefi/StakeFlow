// Centralized configuration for deployment parameters and mint addresses
// Adjust these values to change APR, lock duration, penalty, and SPL mints used by deploy.

export const stakeConfig = {
  // APR in basis points (1000 = 10%)
  aprBps: 1000,
  // Lock duration in seconds
  minLockDuration: 30,
  // Early unstake penalty in basis points (500 = 5%)
  earlyUnstakePenaltyBps: 500,
  // SPL mint addresses (strings). Replace with your actual mint addresses.
  stakeMintAddress: "BeyV4AuCPvchhJc7NXSaAa2ECbPVkj39wy9CY7fu8opD",
  rewardMintAddress: "GQCW1M9szh426zC5a51BLZbPhvXoPnMKCeRWepyCziK3",
};