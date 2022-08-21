import { PublicKey } from "@solana/web3.js";

export interface DIPDeposit {
  splToken: string;
  premiumAsset: string;
  expirationMs: number;
  strike: number;
  type: string;
  qty: number;
}
