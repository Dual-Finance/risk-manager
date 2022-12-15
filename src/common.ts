import { Transaction } from '@solana/web3.js';

export interface DIPDeposit {
  splToken: string;
  premiumAsset: string;
  expirationMs: number;
  strike: number;
  type: string;
  qty: number;
}

export interface RouteDetails {
  price: number;
  qty: number;
  venue: string;
  txs: {setupTransaction?: Transaction, swapTransaction: Transaction, cleanupTransaction?: Transaction};
}
