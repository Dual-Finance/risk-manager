import { DIPDeposit } from "./common";
import {
  Connection,
  AccountChangeCallback,
  PublicKey,
  AccountInfo as solanaAccountInfo,
  Context,
} from "@solana/web3.js";
import { AccountInfo, AccountLayout, u64 } from "@solana/spl-token";
import { WEBSOCKET_URL } from "./config";

export class Poller {
  cluster: string;
  callback: (deposit: DIPDeposit) => void;
  baseAsset: string;
  quoteAsset: string;
  expirationSec: number;
  strike: number;

  constructor(
    cluster: string,
    baseAsset: string,
    quoteAsset: string,
    expirationSec: number,
    strike: number,
    callback: (deposit: DIPDeposit) => void
  ) {
    this.cluster = cluster;
    this.callback = callback;
    this.baseAsset = baseAsset;
    this.quoteAsset = quoteAsset;
    this.expirationSec = expirationSec;
    this.strike = strike;
  }

  subscribe(address: string): void {
    console.log("Listening at:", address);
    // @ts-ignore
    const connection: Connection = new Connection(WEBSOCKET_URL);
    const callback: AccountChangeCallback = (
      accountInfo: solanaAccountInfo<Buffer>,
      _context: Context
    ) => {
      // @ts-ignore
      const new_amount = parseTokenAccount(accountInfo.data).amount.toNumber();
      let decimals = 6;
      switch(this.baseAsset) {
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

      const dip_deposit = {
        baseAsset: this.baseAsset,
        quoteAsset: this.quoteAsset,
        expirationMs: this.expirationSec * 1_000,
        strike: this.strike,
        qty: new_amount / Math.pow(10, decimals),
      };
      this.callback(dip_deposit);
    };

    // Watch the vault spl token account
    try{
      connection.onAccountChange(new PublicKey(address), callback);
    } catch (err){
      console.log(err);
      console.log(err.stack);
    }
  }
}

function parseTokenAccount(data: Buffer): AccountInfo {
  const accountInfo: any = AccountLayout.decode(data);
  accountInfo.mint = new PublicKey(accountInfo.mint);
  accountInfo.owner = new PublicKey(accountInfo.owner);
  accountInfo.amount = u64.fromBuffer(accountInfo.amount);

  if (accountInfo.delegateOption === 0) {
    accountInfo.delegate = null;
    accountInfo.delegatedAmount = new u64();
  } else {
    accountInfo.delegate = new PublicKey(accountInfo.delegate);
    accountInfo.delegatedAmount = u64.fromBuffer(accountInfo.delegatedAmount);
  }

  accountInfo.isInitialized = accountInfo.state !== 0;
  accountInfo.isFrozen = accountInfo.state === 2;

  if (accountInfo.isNativeOption === 1) {
    accountInfo.rentExemptReserve = u64.fromBuffer(accountInfo.isNative);
    accountInfo.isNative = true;
  } else {
    accountInfo.rentExemptReserve = null;
    accountInfo.isNative = false;
  }

  if (accountInfo.closeAuthorityOption === 0) {
    accountInfo.closeAuthority = null;
  } else {
    accountInfo.closeAuthority = new PublicKey(accountInfo.closeAuthority);
  }

  return accountInfo;
}
