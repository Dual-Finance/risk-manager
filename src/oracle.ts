import * as os from "os";
import {
  PythHttpClient,
  getPythProgramKeyForCluster,
} from "@pythnetwork/client";
import { Connection, PublicKey } from "@solana/web3.js";
import { API_URL, IS_DEV, MAX_STALENESS } from "./config";
import { decimalsBaseSPL, splMintToToken } from "./utils";
import SwitchboardProgram from "@switchboard-xyz/sbv2-lite";
import { SYMBOL } from "./common";
import { OCR2Feed } from "@chainlink/solana-sdk";
import { CHAINLINK_PROGRAM_ID, NO_ORACLE_PRICE } from "./constants";
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
      tokenToSBSymbol(splMintToToken(splMint))
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
  process.env.ANCHOR_WALLET = `${os.homedir()}/mango-explorer/id.json`;
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
      return "B4vR6BW4WpLh1mFs6LL6iqL4nydbmE5Uzaz2LLsoAXqk";
    }
    case "BTC": {
      return "4NSNfkSgEdAtD8AKyyiu7QsavyR3GSXLXecwDEFbZCZ3";
    }
    case "ETH": {
      return "Aadkg8sVWV6BS5XNTt2mK6Q8FhYWECLdkDuqDHvdnoVT";
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

function tokenToSBSymbol(token: SYMBOL) {
  switch (token) {
    case "SOL": {
      return "GvDMxPzN1sCj7L26YDK2HnMRXEQmQ2aemov8YBtPS7vR";
    }
    case "BTC": {
      return "8SXvChNYFhRq4EZuZvnhjrB3jJRQCv4k3P4W6hesH3Ee";
    }
    case "ETH": {
      return "HNStfhaLnqwF2ZtJUizaA9uHDAVB976r2AgTUx9LrdEo";
    }
    case "MNGO": {
      return "HNStfhaLnqwF2ZtJUizaA9uHDAVB976r2AgTUx9LrdEo";
    }
    case "BONK": {
      return "6qBqGAYmoZw2r4fda7671NSUbcDWE4XicJdJoWqK8aTe";
    }
    case "DUAL": {
      return "7fMKXU6AnatycNu1CAMndLkKmDPtjZaPNZSJSfXR92Ez";
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
