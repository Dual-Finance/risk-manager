import { PublicKey } from "@solana/web3.js";

export interface DIPDeposit {
  splToken: string;
  premiumAsset: string;
  expirationMs: number;
  strike: number;
  type: string;
  qty: number;
}
export const dualMarketProgramID = new PublicKey(
  "DiPbvUUJkDhV9jFtQsDFnMEMRJyjW5iS6NMwoySiW8ki"
);
export const usdcMintPk = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);
export const mmWalletPk = new PublicKey(
  "9SgZKdeTMaNuEZnhccK2crHxi1grXRmZKQCvNSKgVrCQ"
);
export const wsolPk = new PublicKey(
  "So11111111111111111111111111111111111111112"
);
export const wbtcPk = new PublicKey(
  "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E"
);
export const wethPk = new PublicKey(
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs"
);
export const OPTION_MINT_ADDRESS_SEED = "option-mint";
