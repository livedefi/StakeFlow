// Frontend configuration for StakeFlow
// Program ID and SPL mint addresses for devnet
export const STAKE_FLOW_PROGRAM_ID = "4cUDbCQvhBSzWbTivv3ZscDkePVweqRFAHbgDUKLkfdK";
export const STAKE_MINT_ADDRESS = "BeyV4AuCPvchhJc7NXSaAa2ECbPVkj39wy9CY7fu8opD";
export const REWARD_MINT_ADDRESS = "GQCW1M9szh426zC5a51BLZbPhvXoPnMKCeRWepyCziK3";
export const TOKEN_DECIMALS = 9; // SPL tokens configured in this project

// Solscan link builder for devnet
export const solscanTxUrl = (sig: string) => `https://solscan.io/tx/${sig}?cluster=devnet`;