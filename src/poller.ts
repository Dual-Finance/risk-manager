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
const token = require('@solana/spl-token');

class Poller {
  cluster: string;

  callback: (deposit: DIPDeposit) => void;

  splToken: string;

  premiumAsset: string;

  expirationSec: number;

  strikeTokens: number;

  callOrPut: string;

  constructor(
    cluster: string,
    splToken: string,
    premiumAsset: string,
    expirationSec: number,
    strikeTokens: number,
    callOrPut: string,
    callback: (deposit: DIPDeposit) => void,
  ) {
    this.cluster = cluster;
    this.callback = callback;
    this.splToken = splToken;
    this.premiumAsset = premiumAsset;
    this.expirationSec = expirationSec;
    this.strikeTokens = strikeTokens;
    this.callOrPut = callOrPut;
  }

  async subscribe(address: string): Promise<void> {
    console.log('Listening at:', address);
    const connection = new Connection(API_URL, 'processed' as Commitment);

    const tokenAccount = await token.getAccount(connection, new PublicKey(address));
    const mint = await token.getMint(connection, tokenAccount.mint);
    const decimals = mint.decimals;

    const callback: AccountChangeCallback = (
      accountInfo: solanaAccountInfo<Buffer>,
      _context: Context,
    ) => {
      const newAmount: number = u64.fromBuffer(
        AccountLayout.decode(accountInfo.data).amount,
      ).toNumber();

      const dipDeposit: DIPDeposit = {
        splTokenMint: this.splToken,
        premiumAssetName: this.premiumAsset,
        expirationMs: this.expirationSec * 1_000,
        strikeUsdcPerToken: this.strikeTokens,
        callOrPut: this.callOrPut,
        qtyTokens: newAmount / 10 ** decimals,
      };
      this.callback(dipDeposit);
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

export default Poller;
