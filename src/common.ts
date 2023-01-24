import { Transaction } from '@solana/web3.js';
import { SYMBOL } from './config';

export enum CallOrPut {
  Call = 'call',
  Put = 'put'
}

export interface DIPDeposit {
  splTokenName: SYMBOL;
  premiumAssetName: string;
  expirationMs: number;
  strikeUsdcPerToken: number;
  callOrPut: CallOrPut;
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
