import { PublicKey } from "@solana/web3.js";

export interface DIPDeposit {
  baseAsset: string;
  quoteAsset: string;
  expirationMs: number;
  strike: number;
  qty: number;
}
