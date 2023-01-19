import { Transaction } from '@solana/web3.js';

export interface DIPDeposit {
  splTokenMint: string;
  premiumAssetName: string;
  expirationMs: number;
  strikeUsdcPerToken: number;
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
