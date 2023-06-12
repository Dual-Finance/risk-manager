import * as os from 'os';
import * as fs from 'fs';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  PythHttpClient,
  getPythProgramKeyForCluster,
} from '@pythnetwork/client';
import SwitchboardProgram from '@switchboard-xyz/sbv2-lite';
import * as anchor from '@project-serum/anchor';
import { OCR2Feed } from '@chainlink/solana-sdk';
import {
  API_URL, IS_DEV, RANDOM_SLEEP_MULTIPLIER, usdcPk, TRADING_ACCOUNT, MAX_STALENESS,
} from './config';
import {
  BONK_PK, CHAINLINK_PROGRAM_ID, DUAL_PK, MNGO_PK, BTC_PK, ETH_PK, WSOL_PK,
} from './constants';
import { SYMBOL } from './common';

export function readKeypair() {
  if (TRADING_ACCOUNT === undefined) {
    return JSON.parse(fs.readFileSync(`${os.homedir()}/mango-explorer/id.json`, 'utf-8'));
  }
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
  if (splMint.toBase58() === MNGO_PK.toBase58()) {
    return 'MNGO';
  }
  if (splMint.toBase58() === BONK_PK.toBase58()) {
    return 'BONK';
  }
  if (splMint.toBase58() === DUAL_PK.toBase58()) {
    return 'DUAL';
  }
  if (splMint.toBase58() === usdcPk.toBase58()) {
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
    return usdcPk;
  }
  return undefined;
}

export function tokenToPythSymbol(token: SYMBOL) {
  if (token === 'SOL') {
    return 'Crypto.SOL/USD';
  }
  if (token === 'BTC') {
    return 'Crypto.BTC/USD';
  }
  if (token === 'ETH') {
    return 'Crypto.ETH/USD';
  }
  if (token === 'MNGO') {
    return 'Crypto.MNGO/USD';
  }
  if (token === 'BONK') {
    return 'Crypto.BONK/USD';
  }
  // TODO: Add DUAL Pyth
  return undefined;
}

export async function getPythPrice(splMint: PublicKey): Promise<number | undefined> {
  const connection: Connection = new Connection(API_URL);
  const pythPublicKey = getPythProgramKeyForCluster(
    IS_DEV ? 'devnet' : 'mainnet-beta',
  );
  const pythClient = new PythHttpClient(connection, pythPublicKey);
  const data = await pythClient.getData();
  for (const symbol of data.symbols) {
    const price = data.productPrice.get(symbol)!;
    if (tokenToPythSymbol(splMintToToken(splMint)) === symbol) {
      if (price === undefined) {
        return undefined;
      }
      return price.price;
    }
  }
  return 0;
}

function tokenToSBSymbol(token: SYMBOL) {
  if (token === 'SOL') {
    return 'GvDMxPzN1sCj7L26YDK2HnMRXEQmQ2aemov8YBtPS7vR';
  }
  if (token === 'BTC') {
    return '8SXvChNYFhRq4EZuZvnhjrB3jJRQCv4k3P4W6hesH3Ee';
  }
  if (token === 'ETH') {
    return 'HNStfhaLnqwF2ZtJUizaA9uHDAVB976r2AgTUx9LrdEo';
  }
  if (token === 'MNGO') {
    return 'AmQunu75SLZjDQS9KkRNjAUWHp2ReSzfNiWVDURzeZTi';
  }
  if (token === 'BONK') {
    return '6qBqGAYmoZw2r4fda7671NSUbcDWE4XicJdJoWqK8aTe';
  }
  if (token === 'DUAL') {
    return '7fMKXU6AnatycNu1CAMndLkKmDPtjZaPNZSJSfXR92Ez';
  }
  return undefined;
}

export async function getSwitchboardPrice(splMint: PublicKey) {
  try {
    const sbv2 = await SwitchboardProgram.loadMainnet();
    const assetAggregator = new PublicKey(
      tokenToSBSymbol(splMintToToken(splMint)),
    );

    const accountInfo = await sbv2.program.provider.connection.getAccountInfo(
      assetAggregator,
    );
    if (!accountInfo) {
      console.log('Failed to fetch Switchboard account info');
      return 0;
    }

    // Get latest value if its been updated within max staleness
    const latestResult = sbv2.decodeLatestAggregatorValue(accountInfo, MAX_STALENESS);
    if (latestResult === null) {
      console.log('Failed to fetch latest result for Switchboard aggregator');
      return 0;
    }
    const sbPrice = latestResult.toNumber();

    return sbPrice;
  } catch (err) {
    console.log('Switchboard Price Error', err);
    return 0;
  }
}

function tokenToChainlinkSymbol(token: SYMBOL) {
  if (token === 'SOL') {
    return 'B4vR6BW4WpLh1mFs6LL6iqL4nydbmE5Uzaz2LLsoAXqk';
  }
  if (token === 'BTC') {
    return '4NSNfkSgEdAtD8AKyyiu7QsavyR3GSXLXecwDEFbZCZ3';
  }
  if (token === 'ETH') {
    return 'Aadkg8sVWV6BS5XNTt2mK6Q8FhYWECLdkDuqDHvdnoVT';
  }
  if (token === 'MNGO') {
    return '';
  }
  if (token === 'BONK') {
    return '';
  }
  if (token === 'DUAL') {
    return '';
  }
  return undefined;
}

export function decimalsBaseSPL(token: SYMBOL) {
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
    default: {
      return undefined;
    }
  }
}

// TODO: Fail after a few tries if chainlink is stuck
function waitFor(conditionFunction) {
  const poll = (resolve) => {
    if (conditionFunction()) {
      resolve();
    } else {
      setTimeout((_: any) => poll(resolve), 400);
    }
  };
  return new Promise(poll);
}

export async function getChainlinkPrice(splMint: PublicKey) {
  process.env.ANCHOR_PROVIDER_URL = API_URL;
  process.env.ANCHOR_WALLET = `${os.homedir()}/mango-explorer/id.json`;
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  if (tokenToChainlinkSymbol(splMintToToken(splMint)) === '') {
    return 0;
  }
  const feedAddress = new PublicKey(tokenToChainlinkSymbol(splMintToToken(splMint)));
  const dataFeed = await OCR2Feed.load(CHAINLINK_PROGRAM_ID, provider);
  let listener: number = null;

  let latestValue = 0;
  listener = dataFeed.onRound(feedAddress, (event) => {
    latestValue = event.answer.toNumber();
    dataFeed.removeListener(listener);
  });

  await waitFor(() => latestValue !== 0);
  const prettyLatestValue = latestValue / 10 ** decimalsBaseSPL(splMintToToken(splMint));
  // Chainlink SOL off by a factor of 10
  if (splMintToToken(splMint) === 'SOL') {
    return prettyLatestValue * 10;
  }
  return prettyLatestValue;
}

export function getRandomNumAround(midValue: number, spread: number) {
  const min = midValue * (1 - spread);
  const max = midValue * (1 + spread);
  return Math.random() * (max - min) + min;
}

export async function asyncCallWithTimeoutasync(asyncPromise, timeLimit) {
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
