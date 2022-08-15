import { PublicKey } from "@solana/web3.js";

export interface DIPDeposit {
  splToken: string;
  premiumAsset: string;
  expiration: number;
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
export const OPTION_MINT_ADDRESS_SEED = "option-mint";
