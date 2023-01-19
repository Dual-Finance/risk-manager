import {
  Connection,
  AccountChangeCallback,
  PublicKey,
  AccountInfo as solanaAccountInfo,
  Context,
  Commitment,
} from '@solana/web3.js';
import { AccountLayout, u64 } from '@solana/spl-token';
import { DIPDeposit } from './common';
import { API_URL } from './config';

export class Poller {
  cluster: string;

  callback: (deposit: DIPDeposit) => void;

  splToken: string;

  premiumAsset: string;

  expirationSec: number;

  strike: number;

  type: string;

  constructor(
    cluster: string,
    splToken: string,
    premiumAsset: string,
    expirationSec: number,
    strike: number,
    type: string,
    callback: (deposit: DIPDeposit) => void,
  ) {
    this.cluster = cluster;
    this.callback = callback;
    this.splToken = splToken;
    this.premiumAsset = premiumAsset;
    this.expirationSec = expirationSec;
    this.strike = strike;
    this.type = type;
  }

  subscribe(address: string): void {
    console.log('Listening at:', address);
    // TODO: Use a serum API to get the decimals once at the start, but also
    // debug why SOL has 8 decimals instead of expected 9.
    
    const connection = new Connection(API_URL, 'processed' as Commitment);

    const callback: AccountChangeCallback = (
      accountInfo: solanaAccountInfo<Buffer>,
      _context: Context,
    ) => {
      const new_amount: number = u64.fromBuffer(AccountLayout.decode(accountInfo.data).amount).toNumber();
      let decimals = 6;
      switch (this.splToken) {
        // BTC
        case 'JDXktC6gbDXq4zuW3BT6ToSE7timShHQBL449ULDdoMv':
        case '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E':
          decimals = 6;
          break;
        // ETH
        case 'Hccuen6RkUgEvyL9oSXW8ai9QiQaAiL8ESaqjp9oymBf':
        case '2FPyTwcZLUg1MDrwsyoP4D6s1tM7hAkHYRjkNb5w6Pxk':
          decimals = 6;
          break;
        // SOL
        case 'So11111111111111111111111111111111111111112':
          decimals = 8;
          break;
        default:
          break;
      }

      const dip_deposit: DIPDeposit = {
        splTokenMint: this.splToken,
        premiumAssetName: this.premiumAsset,
        expirationMs: this.expirationSec * 1_000,
        strikeUsdcPerToken: this.strike,
        callOrPut: this.type,
        qtyTokens: new_amount / 10 ** decimals,
      };
      this.callback(dip_deposit);
    };

    // Watch the vault spl token account
    try {
      connection.onAccountChange(new PublicKey(address), callback);
    } catch (err) {
      console.log(err);
      console.log(err.stack);
    }
  }
}
