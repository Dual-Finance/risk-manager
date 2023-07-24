import {
  PythHttpClient,
  getPythProgramKeyForCluster,
} from "@pythnetwork/client";
import { Connection, PublicKey } from "@solana/web3.js";
import { API_URL, IS_DEV, MAX_STALENESS, TRADING_ACCOUNT } from "./config";
import { decimalsBaseSPL, splMintToToken } from "./utils";
import SwitchboardProgram from "@switchboard-xyz/sbv2-lite";
import { SYMBOL } from "./common";
import { OCR2Feed } from "@chainlink/solana-sdk";
import { CHAINLINK_BTC_PK, CHAINLINK_ETH_PK, CHAINLINK_PROGRAM_ID, CHAINLINK_SOL_PK, NO_ORACLE_PRICE, SB_BONK_PK, SB_BTC_PK, SB_DUAL_PK, SB_MNGO_PK, SB_SOL_PK } from "./constants";
import * as anchor from "@project-serum/anchor";

export async function getPythPrice(splMint: PublicKey): Promise<number> {
  const connection: Connection = new Connection(API_URL);
  const pythPublicKey = getPythProgramKeyForCluster(
    IS_DEV ? "devnet" : "mainnet-beta"
  );
  const pythClient = new PythHttpClient(connection, pythPublicKey);
  const data = await pythClient.getData();
  for (const symbol of data.symbols) {
    const price = data.productPrice.get(symbol)!;
    if (tokenToPythSymbol(splMintToToken(splMint)) === symbol) {
      if (price === undefined) {
        return NO_ORACLE_PRICE;
      }
      return price.price;
    }
  }
  return NO_ORACLE_PRICE;
}

export async function getSwitchboardPrice(splMint: PublicKey): Promise<number> {
  try {
    const sbv2 = await SwitchboardProgram.loadMainnet();
    const assetAggregator = new PublicKey(
      tokenToSBPk(splMintToToken(splMint))
    );

    const accountInfo = await sbv2.program.provider.connection.getAccountInfo(
      assetAggregator
    );
    if (!accountInfo) {
      console.log("Failed to fetch Switchboard account info");
      return NO_ORACLE_PRICE;
    }

    // Get latest value if its been updated within max staleness
    const latestResult = sbv2.decodeLatestAggregatorValue(
      accountInfo,
      MAX_STALENESS
    );
    if (latestResult === null) {
      console.log("Failed to fetch latest result for Switchboard aggregator");
      return NO_ORACLE_PRICE;
    }
    const sbPrice = latestResult.toNumber();

    return sbPrice;
  } catch (err) {
    console.log("Switchboard Price Error", err);
    return NO_ORACLE_PRICE;
  }
}

export async function getChainlinkPrice(splMint: PublicKey): Promise<number> {
  process.env.ANCHOR_PROVIDER_URL = API_URL;
  process.env.ANCHOR_WALLET = TRADING_ACCOUNT;
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  if (tokenToChainlinkSymbol(splMintToToken(splMint)) === undefined) {
    return NO_ORACLE_PRICE;
  }
  const feedAddress = new PublicKey(
    tokenToChainlinkSymbol(splMintToToken(splMint))
  );
  const dataFeed = await OCR2Feed.load(CHAINLINK_PROGRAM_ID, provider);
  let listener: number = null;

  let latestValue = NO_ORACLE_PRICE;
  listener = dataFeed.onRound(feedAddress, (event) => {
    latestValue = event.answer.toNumber();
    dataFeed.removeListener(listener);
  });

  await waitFor(() => latestValue !== NO_ORACLE_PRICE);
  const prettyLatestValue =
    latestValue / 10 ** decimalsBaseSPL(splMintToToken(splMint));
  // Chainlink SOL off by a factor of 10
  if (splMintToToken(splMint) === "SOL") {
    return prettyLatestValue * 10;
  }
  return prettyLatestValue;
}

function tokenToChainlinkSymbol(token: SYMBOL) {
  switch (token) {
    case "SOL": {
      return CHAINLINK_SOL_PK;
    }
    case "BTC": {
      return CHAINLINK_BTC_PK;
    }
    case "ETH": {
      return CHAINLINK_ETH_PK;
    }
    default: {
      return undefined;
    }
  }
}

export function tokenToPythSymbol(token: SYMBOL) {
  switch (token) {
    case "SOL": {
      return "Crypto.SOL/USD";
    }
    case "BTC": {
      return "Crypto.BTC/USD";
    }
    case "ETH": {
      return "Crypto.ETH/USD";
    }
    case "mSOL": {
      return "Crypto.MSOL/USD";
    }
    case "MNGO": {
      return "Crypto.MNGO/USD";
    }
    case "BONK": {
      return "Crypto.BONK/USD";
    }
    default: {
      return undefined;
    }
  }
}

function tokenToSBPk(token: SYMBOL) {
  switch (token) {
    case "SOL": {
      return SB_SOL_PK;
    }
    case "BTC": {
      return SB_BTC_PK;
    }
    case "ETH": {
      return SB_BTC_PK;
    }
    case "MNGO": {
      return SB_MNGO_PK;
    }
    case "BONK": {
      return SB_BONK_PK;
    }
    case "DUAL": {
      return SB_DUAL_PK;
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
