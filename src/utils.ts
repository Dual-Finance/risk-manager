import * as os from "os";
import * as fs from "fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { utils } from "@project-serum/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  Token,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  soBTCPk,
  soETHPk,
  wSOLPk,
  percentDrift,
  API_URL,
  IS_DEV,
  mngoPK,
} from "./config";
import {
  PythHttpClient,
  getPythProgramKeyForCluster,
} from "@pythnetwork/client";
import SwitchboardProgram from "@switchboard-xyz/sbv2-lite";
import * as anchor from "@project-serum/anchor";
import { OCR2Feed } from "@chainlink/solana-sdk";

export function readKeypair() {
  return JSON.parse(
    process.env.KEYPAIR ||
      fs.readFileSync(os.homedir() + "/mango-explorer/id.json", "utf-8")
  );
}

// Sleep Time with some slight randomness to the time
export function sleepRandom(period: number) {
  let randomDrift = (Math.random() * 2 - 1) * period * percentDrift;
  return new Promise(function (resolve) {
    setTimeout(resolve, (period + randomDrift) * 1_000);
  });
}

// Sleep Exact Amount of Time
export function sleepExact(period: number) {
  return new Promise(function (resolve) {
    setTimeout(resolve, period * 1_000);
  });
}

export function readBigUInt64LE(buffer: Buffer, offset = 0) {
  const first = buffer[offset];
  const last = buffer[offset + 7];
  if (first === undefined || last === undefined) {
    throw new Error();
  }
  const lo =
    first +
    buffer[++offset] * 2 ** 8 +
    buffer[++offset] * 2 ** 16 +
    buffer[++offset] * 2 ** 24;
  const hi =
    buffer[++offset] +
    buffer[++offset] * 2 ** 8 +
    buffer[++offset] * 2 ** 16 +
    last * 2 ** 24;
  return BigInt(lo) + (BigInt(hi) << BigInt(32));
}

export function parseDipState(buf: Buffer) {
  const strike = Number(readBigUInt64LE(buf, 8));
  const expiration = Number(readBigUInt64LE(buf, 16));
  const splMint = new PublicKey(buf.slice(24, 56));
  const vaultMint = new PublicKey(buf.slice(56, 88));
  const vaultMintBump = Number(buf.readUInt8(88));
  const vaultSpl = new PublicKey(buf.slice(89, 121));
  const vaultSplBump = Number(buf.readUInt8(121));
  const optionMint = new PublicKey(buf.slice(122, 154));
  const optionBump = Number(buf.readUInt8(154));
  const vaultUsdc = new PublicKey(buf.slice(155, 187));
  const vaultUsdcBump = Number(buf.readUInt8(187));
  const usdcMint = new PublicKey(buf.slice(188, 220));
  return {
    strike,
    expiration,
    splMint,
    vaultMint,
    vaultMintBump,
    vaultSpl,
    vaultSplBump,
    optionMint,
    optionBump,
    vaultUsdc,
    vaultUsdcBump,
    usdcMint,
  };
}

export async function findProgramAddressWithMintAndStrikeAndExpiration(
  seed: string,
  strikePrice: number,
  expiration: number,
  splMint: PublicKey,
  usdcMint: PublicKey,
  programId: PublicKey
) {
  return PublicKey.findProgramAddress(
    [
      Buffer.from(utils.bytes.utf8.encode(seed)),
      toBytes(strikePrice),
      toBytes(expiration),
      splMint.toBuffer(),
      usdcMint.toBuffer(),
    ],
    programId
  );
}

export function toBytes(x: number): Uint8Array {
  const y = Math.floor(x / 2 ** 32);
  return Uint8Array.from(
    [y, y << 8, y << 16, y << 24, x, x << 8, x << 16, x << 24].map(
      (z) => z >>> 24
    )
  );
}

export async function getAssociatedTokenAddress(
  mintPk: PublicKey,
  owner: PublicKey
) {
  return Token.getAssociatedTokenAddress(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    mintPk,
    owner
  );
}

export function timeSinceMidDay() {
  const timeNow = new Date();
  const year = timeNow.getUTCFullYear();
  const month = timeNow.getUTCMonth();
  const day = timeNow.getUTCDate();
  const timeCheckUTC = Date.UTC(year, month, day, 12, 0, 0, 0);
  const diff = (timeNow.getTime() - timeCheckUTC) / 1000;
  return diff;
}

export function splMintToToken(splMint: PublicKey) {
  if (splMint.toBase58() == wSOLPk.toBase58()) {
    return "SOL";
  }
  if (splMint.toBase58() == soBTCPk.toBase58()) {
    return "BTC";
  }
  if (splMint.toBase58() == soETHPk.toBase58()) {
    return "ETH";
  }
  if (splMint.toBase58() == mngoPK.toBase58()) {
    return "MNGO";
  }
  return "UNKNOWN_TOKEN";
}

export function tokenToSplMint(token: string) {
  if (token == "SOL") {
    return wSOLPk;
  }
  if (token == "BTC") {
    return soBTCPk;
  }
  if (token == "ETH") {
    return soETHPk;
  }
  if (token == "MNGO") {
    return mngoPK;
  }
  return undefined;
}

export function tokenToPythSymbol(token: string) {
  if (token == "SOL") {
    return "Crypto.SOL/USD";
  }
  if (token == "BTC") {
    return "Crypto.BTC/USD";
  }
  if (token == "ETH") {
    return "Crypto.ETH/USD";
  }
  if (token == "MNGO") {
    return "Crypto.MNGO/USD";
  }
  return undefined;
}

export async function getPythPrice(splMint: PublicKey) {
  const connection: Connection = new Connection(API_URL);
  const pythPublicKey = getPythProgramKeyForCluster(
    IS_DEV ? "devnet" : "mainnet-beta"
  );
  const pythClient = new PythHttpClient(connection, pythPublicKey);
  const data = await pythClient.getData();

  for (let symbol of data.symbols) {
    const price = data.productPrice.get(symbol)!;
    if (tokenToPythSymbol(splMintToToken(splMint)) == symbol) {
      return price;
    }
  }
  return;
}
export function tokenToSBSymbol(token: string) {
  if (token == "SOL") {
    return "GvDMxPzN1sCj7L26YDK2HnMRXEQmQ2aemov8YBtPS7vR";
  }
  if (token == "BTC") {
    return "8SXvChNYFhRq4EZuZvnhjrB3jJRQCv4k3P4W6hesH3Ee";
  }
  if (token == "ETH") {
    return "HNStfhaLnqwF2ZtJUizaA9uHDAVB976r2AgTUx9LrdEo";
  }
  if (token == "MNGO") {
    return "82kWw8KKysTyZSXovgfPS7msfvnZZc4AAUsUNGp8Kcpy";
  }
  return undefined;
}

export async function getSwitchboardPrice(splMint: PublicKey) {
  const sbv2 = await SwitchboardProgram.loadMainnet();
  const assetAggregator = new PublicKey(
    tokenToSBSymbol(splMintToToken(splMint))
  );

  const accountInfo = await sbv2.program.provider.connection.getAccountInfo(
    assetAggregator
  );
  if (!accountInfo) {
    throw new Error(`Failed to fetch Switchboard account info`);
  }

  // Get latest value if its been updated in the last 60 seconds
  const latestResult = sbv2.decodeLatestAggregatorValue(accountInfo, 60);
  if (latestResult === null) {
    throw new Error(`Failed to fetch latest result for Switchboard aggregator`);
  }
  const sbPrice = latestResult.toNumber();
  return sbPrice;
}

  // TODO: Fail after a few tries if chainlink is stuck
function waitFor(conditionFunction) {
  const poll = (resolve) => {
    if (conditionFunction()) resolve();
    else setTimeout((_) => poll(resolve), 400);
  };
  return new Promise(poll);
}

export async function getChainlinkPrice() {
  process.env.ANCHOR_PROVIDER_URL = 'https://api.devnet.solana.com';
  process.env.ANCHOR_WALLET = os.homedir() + "/mango-explorer/id.json";
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const CHAINLINK_FEED_ADDRESS = "HgTtcbcmp5BeThax5AU8vg4VwK79qAvAKKFMs8txMLW6";
  const CHAINLINK_PROGRAM_ID = new anchor.web3.PublicKey(
    "cjg3oHmg9uuPsP8D6g29NWvhySJkdYdAo9D25PRbKXJ"
  );
  const feedAddress = new anchor.web3.PublicKey(CHAINLINK_FEED_ADDRESS);

  let dataFeed = await OCR2Feed.load(CHAINLINK_PROGRAM_ID, provider);
  let listener = null;

  let latestValue = 0;
  listener = dataFeed.onRound(feedAddress, (event) => {
    latestValue = event.answer.toNumber();
    dataFeed.removeListener(listener);
  });

  await waitFor((_) => latestValue != 0);
  return latestValue;
}
