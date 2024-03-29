import * as fs from 'fs';
import { PublicKey } from '@solana/web3.js';
import {
  RANDOM_SLEEP_MULTIPLIER, USDC_PK, TRADING_ACCOUNT,
} from './config';
import {
  BONK_PK, DUAL_PK, MNGO_PK, BTC_PK, ETH_PK, WSOL_PK, MSOL_PK, JITOSOL_PK,
} from './constants';
import { SYMBOL } from './common';

export function readKeypair() {
  return JSON.parse(fs.readFileSync(TRADING_ACCOUNT, 'utf-8'));
}

// Sleep time with some slight randomness.
export function sleepRandom(periodSec: number) {
  const randomDriftSec = (Math.random() * 2 - 1) * periodSec * RANDOM_SLEEP_MULTIPLIER;
  return new Promise((resolve) => {
    setTimeout(resolve, (periodSec + randomDriftSec) * 1_000);
  });
}

// Sleep exact amount of time
export function sleepExact(period: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, period * 1_000);
  });
}

export function splMintToToken(splMint: PublicKey): SYMBOL {
  if (splMint.toBase58() === WSOL_PK.toBase58()) {
    return 'SOL';
  }
  if (splMint.toBase58() === BTC_PK.toBase58()) {
    return 'BTC';
  }
  if (splMint.toBase58() === ETH_PK.toBase58()) {
    return 'ETH';
  }
  if (splMint.toBase58() === MSOL_PK.toBase58()) {
    return 'mSOL';
  }
  if (splMint.toBase58() === JITOSOL_PK.toBase58()) {
    return 'jitoSOL';
  }
  if (splMint.toBase58() === MNGO_PK.toBase58()) {
    return 'MNGO';
  }
  if (splMint.toBase58() === BONK_PK.toBase58()) {
    return 'BONK';
  }
  if (splMint.toBase58() === DUAL_PK.toBase58()) {
    return 'DUAL';
  }
  if (splMint.toBase58() === USDC_PK.toBase58()) {
    return 'USDC';
  }
  console.log(`Unknown token: ${splMint.toBase58()}`);
  return 'UNKNOWN_TOKEN';
}

export function tokenToSplMint(token: SYMBOL) {
  if (token === 'SOL') {
    return WSOL_PK;
  }
  if (token === 'BTC') {
    return BTC_PK;
  }
  if (token === 'ETH') {
    return ETH_PK;
  }
  if (token === 'mSOL') {
    return MSOL_PK;
  }
  if (token === 'jitoSOL') {
    return JITOSOL_PK;
  }
  if (token === 'MNGO') {
    return MNGO_PK;
  }
  if (token === 'BONK') {
    return BONK_PK;
  }
  if (token === 'DUAL') {
    return DUAL_PK;
  }
  if (token === 'USDC') {
    return USDC_PK;
  }
  return undefined;
}

export function decimalsBaseSPL(token: SYMBOL): number {
  switch (token) {
    case 'SOL': {
      return 9;
    }
    case 'BTC': {
      return 8;
    }
    case 'ETH': {
      return 8;
    }
    case 'mSOL': {
      return 9;
    }
    case 'jitoSOL': {
      return 9;
    }
    case 'MNGO': {
      return 6;
    }
    case 'BONK': {
      return 5;
    }
    case 'DUAL': {
      return 6;
    }
    case 'USDC': {
      return 6;
    }
    case 'UNKNOWN_TOKEN': {
      return undefined;
    }
  }
}

export function getRandomNumAround(midValue: number, spread: number) {
  const min = midValue * (1 - spread);
  const max = midValue * (1 + spread);
  return Math.random() * (max - min) + min;
}

export async function asyncCallWithTimeout(asyncPromise: Promise<any>, timeLimit: number) {
  let timeoutHandle: NodeJS.Timeout;

  const timeoutPromise = new Promise((_resolve, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error('Async timeout limit reached')),
      timeLimit * 1000,
    );
  });

  return Promise.race([asyncPromise, timeoutPromise]).then((result) => {
    clearTimeout(timeoutHandle);
    return result;
  });
}
