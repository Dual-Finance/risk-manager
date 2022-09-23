import { PublicKey } from "@solana/web3.js";

export const IS_DEV: boolean = true;
export const ENVIRONMENT: string = IS_DEV ? "DEVNET" : "MAINNET";

export const networkName = IS_DEV ? 'devnet.2' : 'mainnet.1';
export const cluster = IS_DEV ? 'devnet' : 'mainnet-beta';
export const API_URL = IS_DEV ? 'https://dual-rpc.com/devnet' : 'https://dual-rpc.com/mainnet';
export const DUAL_API = IS_DEV ? 'https://dev.api.dual.finance' : 'https://api.dual.finance';
export const WEBSOCKET_URL = IS_DEV ? 'https://api.devnet.solana.com' : 'https://api.mainnet-beta.solana.com';
export const FILLS_URL = IS_DEV ? 'ws://api.mngo.cloud:2082' : 'ws://v3.mngo.cloud:8080';
export const usdcMintPk = IS_DEV ? new PublicKey("HJiQv33nKujRmZQ3sJBSosXgCEmiHs3mG1yd9VcLawPM") : new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const settlementWallet = new PublicKey("2qLWeNrV7QkHQvKBoEvXrKeLqEB2ZhscZd4ds7X2JUhn");
export const PROTCOL_API_KEY = "033000e0a1c3a87a4ec58c9ecbc0e41da02fd517e313ec602422a46f5de5dac7";
export const wSOLPk = new PublicKey(
  "So11111111111111111111111111111111111111112"
);
// These are only in mainnet because mango does not support them
export const soBTCPk = new PublicKey(
  "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E"
);

export const soETHPk = new PublicKey(
  "2FPyTwcZLUg1MDrwsyoP4D6s1tM7hAkHYRjkNb5w6Pxk"
);

export const dualMarketProgramID = new PublicKey(
  "DiPbvUUJkDhV9jFtQsDFnMEMRJyjW5iS6NMwoySiW8ki"
);
export const optionVaultPk = new PublicKey(
  "9SgZKdeTMaNuEZnhccK2crHxi1grXRmZKQCvNSKgVrCQ"
);
export const riskManagerPk = new PublicKey(
  "FCsXUii28gmnKQCZV1vGMZPqF2LCRCr3pqErQcskgr8W"
);
export const mangoTesterPk = new PublicKey(
  "CkcJx7Uwgxck5zm3DqUp2N1ikkkoPn2wA8zf7oS4tFSZ"
);
export const OPTION_MINT_ADDRESS_SEED = "option-mint";

export const THEO_VOL_MAP = new Map<string, number> ([
  ['BTC', 0.60], ['ETH', 0.72], ['SOL', 0.84]
]);

export const MinContractSize = new Map<string, number> ([
  ['BTC', 0.0001], ['ETH', 0.001], ['SOL', 0.01]
]);

export const TickSize = new Map<string, number> ([
  ['BTC', 0.1], ['ETH', 0.1], ['SOL', 0.01]
]);

export const rfRate = 0.03; // Risk Free Rate of Return ~ T-Bill Rate
export const maxNotional = 10000; // Max hedging order size of $10,000
export const slippageTolerance = 0.001; // Allow 10bps above/below FMV on limit orders
export const twapInterval = 15; // Number of seconds to space spliced orders across
export const scalperWindow = 600; // Number of seconds for each gamma scalping window
export const monthAdj = 1; // Adjustment since Date.UTC is zero based
export const zScore = 1.282; // Corresponds to 80% CI
export const fillScan = 1; // Number of seconds during twap intervals to check for websocket fills
export const percentDrift = 0.05; // Percentage of time to allow drift of the timed actions
export const gammaThreshold = 0.05; // Percentage of gamma to calc delta hedge threshold
export const maxHedges = 10; // Maximum amount of orders to delta hedge across
