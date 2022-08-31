import { PublicKey } from "@solana/web3.js";

export const IS_DEV: boolean = true;
export const ENVIRONMENT: string = IS_DEV ? "DEVNET" : "MAINNET";

export const networkName = IS_DEV ? 'devnet.2' : 'mainnet.1';
export const cluster = IS_DEV ? 'devnet' : 'mainnet-beta';
export const API_URL = IS_DEV ? 'https://dual-rpc.com/devnet' : 'https://dual-rpc.com/mainnet';
export const DUAL_API = IS_DEV ? 'https://dev.api.dual.finance' : 'https://api.dual.finance';
export const WEBSOCKET_URL = IS_DEV ? 'https://api.devnet.solana.com' : 'https://api.mainnet-beta.solana.com';
export const FILLS_URL = IS_DEV ? 'ws://api.mngo.cloud:2082' : 'ws://api.mngo.cloud:8080';
export const usdcMintPk = IS_DEV ? new PublicKey("HJiQv33nKujRmZQ3sJBSosXgCEmiHs3mG1yd9VcLawPM") : new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const settlementWallet = new PublicKey("2qLWeNrV7QkHQvKBoEvXrKeLqEB2ZhscZd4ds7X2JUhn");
export const PROTCOL_API_KEY = "033000e0a1c3a87a4ec58c9ecbc0e41da02fd517e313ec602422a46f5de5dac7";
export const wsolPk = new PublicKey(
  "So11111111111111111111111111111111111111112"
);
// These are only in mainnet because mango does not support them
export const wbtcPk = new PublicKey(
  "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E"
);
export const wethPk = new PublicKey(
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs"
);

export const dualMarketProgramID = new PublicKey(
  "DiPbvUUJkDhV9jFtQsDFnMEMRJyjW5iS6NMwoySiW8ki"
);
export const mmWalletPk = new PublicKey(
  "9SgZKdeTMaNuEZnhccK2crHxi1grXRmZKQCvNSKgVrCQ"
);
export const OPTION_MINT_ADDRESS_SEED = "option-mint";

export const THEO_VOL_MAP = new Map<string, number> ([
  ['BTC', 0.60], ['ETH', 0.72], ['SOL', 0.84]
]);

export const TickSize = new Map<string, number> ([
  ['BTC', 0.0001], ['ETH', 0.001], ['SOL', 0.01]
]);

export const rfRate = 0.03; // Risk Free Rate of Return ~ T-Bill Rate
export const maxNotional = 10000; // Max hedging order size of $10,000
export const slippageTolerance = 0.003; // Allow 30bps above/below FMV on limit orders
export const twapInterval = 15; // Number of seconds to space spliced orders across
export const scalperWindow = 600; // Number of seconds for each gamma scalping window
export const monthAdj = 1; // Adjustment since Date.UTC is zero based
export const periods = 30;
export const zScore = 1.282; // Corresponds to 80% CI