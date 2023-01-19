import { Transaction } from '@solana/web3.js';

export interface DIPDeposit {
  splTokenMint: string;
  premiumAssetName: string;
  expirationMs: number;
  strikeUsdcPerToken: number;
  // TODO: Remove this since all options are calls, just different tokens involved.
  callOrPut: string;
  qtyTokens: number;
}

export interface RouteDetails {
  price: number;
  qty: number;
  venue: string;
  txs: {
    setupTransaction?: Transaction,
    swapTransaction: Transaction,
    cleanupTransaction?: Transaction
  };
}
