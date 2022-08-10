export const networkName = 'devnet.2';

export const THEO_VOL_MAP = new Map<string, number> ([
  ['BTC', 0.60], ['ETH', 0.70], ['SOL', 0.80]
]);

export const rfRate = 0.03; // Risk Free Rate of Return ~ T-Bill Rate
export const maxNotional = 10000; // Max hedging order size of $10,000
export const slippageTolerance = 0.003; // Allow 30bps above/below FMV on limit orders
export const twapInterval = 15; // Number of seconds to space spliced orders across
export const scalperWindow = 600; // Number of seconds for each gamma scalping window
export const monthAdj = 1; // Adjustment since Date.UTC is zero based
export const periods = 30;
export const zScore = 1.282; // Corresponds to 80% CI