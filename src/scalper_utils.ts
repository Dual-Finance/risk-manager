// @ts-ignore
import * as greeks from "greeks";
import {
  BookSide,
  MangoCache,
  MangoGroup,
  PerpMarket,
} from "@blockworks-foundation/mango-client";
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { DIPDeposit } from "./common";
import {
  ACCOUNT_MAP,
  mangoTesterPk,
  maxMktSpread,
  optionVaultPk,
  rfRate,
  riskManagerPk,
  THEO_VOL_MAP,
} from "./config";
import { getAssociatedTokenAddress, getChainlinkPrice, getPythPrice, getSwitchboardPrice, tokenToSplMint } from "./utils";
import { DexMarket } from "@project-serum/serum-dev-tools";

export async function loadPrices(
  mangoGroup: MangoGroup,
  connection: Connection
) {
  const [mangoCache]: [MangoCache] = await Promise.all([
    mangoGroup.loadCache(connection),
  ]);
  return [mangoCache];
}

export function getDIPDelta(
  dipProduct: DIPDeposit[],
  fairValue: number,
  symbol: string
) {
  const impliedVol = THEO_VOL_MAP.get(symbol);
  let yearsUntilMaturity: number;
  let deltaSum = 0;
  for (const dip of dipProduct) {
    yearsUntilMaturity =
      (dip.expirationMs - Date.now()) / (365 * 60 * 60 * 24 * 1_000);
    deltaSum =
      greeks.getDelta(
        fairValue,
        dip.strike,
        yearsUntilMaturity,
        impliedVol,
        rfRate,
        dip.type
      ) *
        dip.qty +
      deltaSum;
  }
  return deltaSum;
}

// Splice delta hedge orders if available mango liquidity not supportive
export function orderSpliceMango(
  qty: number,
  price: number,
  notionalMax: number,
  slippage: number,
  side: BookSide,
  market: PerpMarket
) {
  let spliceFactor: number;
  const [_, nativeQty] = market.uiToNativePriceQuantity(0, qty);
  if (qty > 0 && side.getImpactPriceUi(nativeQty) < price * (1 - slippage)) {
    spliceFactor = Math.max((qty * price) / notionalMax, 1);
    console.log(
      "Sell Price Impact: ",
      side.getImpactPriceUi(nativeQty),
      "High Slippage!",
      spliceFactor
    );
  } else if (
    qty < 0 &&
    side.getImpactPriceUi(nativeQty) > price * (1 + slippage)
  ) {
    spliceFactor = Math.max((qty * price) / notionalMax, 1);
    console.log(
      "Buy Price Impact: ",
      side.getImpactPriceUi(nativeQty),
      "High Slippage!",
      spliceFactor
    );
  } else {
    spliceFactor = 1;
    console.log("Slippage Tolerable", side.getImpactPriceUi(nativeQty));
  }
  return spliceFactor;
}

// Splice delta hedge orders if available mango liquidity not supportive
export function orderSpliceOpenBook(
  qty: number,
  price: number,
  notionalMax: number,
  hedgeSide: string,
  bids,
  asks, 
  ) {
  let depth = 0;
  if (hedgeSide == "sell") {
    for (const bid of bids) {
      if (bid.price > price){
        depth = bid.size + depth
      }
    }
  } else if (hedgeSide == "buy") {
    for (const ask of asks) {
      if (ask.price < price){
        depth = ask.size + depth
      }
    }
  }
  if (depth > Math.abs(qty)){
    return 1;
  } else {
    console.log("Order Splice Factor!", Math.max((Math.abs(qty) * price) / notionalMax, 1));
    return Math.max((Math.abs(qty) * price) / notionalMax, 1)
  }
}

export function getDIPGamma(
  dipProduct: DIPDeposit[],
  fairValue: number,
  symbol: string
) {
  const impliedVol = THEO_VOL_MAP.get(symbol);
  let yearsUntilMaturity: number;
  let gammaSum = 0;
  for (const dip of dipProduct) {
    yearsUntilMaturity =
      (dip.expirationMs - Date.now()) / (365 * 60 * 60 * 24 * 1_000);
    gammaSum =
      greeks.getGamma(
        fairValue,
        dip.strike,
        yearsUntilMaturity,
        impliedVol,
        rfRate,
        dip.type
      ) *
        dip.qty +
      gammaSum;
  }
  return gammaSum;
}

export function getDIPTheta(
  dipProduct: DIPDeposit[],
  fairValue: number,
  symbol: string
) {
  const impliedVol = THEO_VOL_MAP.get(symbol);
  let yearsUntilMaturity: number;
  let thetaSum = 0;
  for (const dip of dipProduct) {
    yearsUntilMaturity =
      (dip.expirationMs - Date.now()) / (365 * 60 * 60 * 24 * 1_000);
    thetaSum =
      greeks.getTheta(
        fairValue,
        dip.strike,
        yearsUntilMaturity,
        impliedVol,
        rfRate,
        dip.type
      ) *
        dip.qty +
        thetaSum;
  }
  return thetaSum;
}

// Fill Size from any perp orders
export async function fillSize(
  perpMarket: PerpMarket,
  connection: Connection,
  orderID: number
) {
  let filledQty = 0;
  // Possible issue using loadFills instead of Websocket?
  for (const fill of await perpMarket.loadFills(connection)) {
    if (
      fill.makerClientOrderId.toString() == orderID.toString() ||
      fill.takerClientOrderId.toString() == orderID.toString()
    ) {
      if (fill.takerSide == "buy") {
        filledQty = filledQty + fill.quantity;
      } else if (fill.takerSide == "sell") {
        filledQty = filledQty - fill.quantity;
      }
    }
  }
  return filledQty;
}

// TODO: Update this to also take into account the openbook position
// Get Spot Balance
export async function getSpotDelta(connection: Connection, symbol: string) {
  let mainDelta = 0;
  let tokenDelta = 0;
  let spotDelta = 0;
  let tokenDecimals = 1;
  let accountList = [mangoTesterPk, optionVaultPk, riskManagerPk];
  for (const account of accountList) {
    if (symbol == "SOL") {
      mainDelta = (await connection.getBalance(account)) / LAMPORTS_PER_SOL;
    }
    try {
      const tokenAccount = await getAssociatedTokenAddress(
        tokenToSplMint(symbol),
        account
      );
      const balance = await connection.getTokenAccountBalance(tokenAccount);
      const tokenBalance = Number(balance.value.amount);
      tokenDecimals = balance.value.decimals;
      tokenDelta = tokenBalance / Math.pow(10, tokenDecimals);
    } catch (err) {
      tokenDelta = 0;
    }
    spotDelta = mainDelta + tokenDelta + spotDelta;
  }
  return spotDelta;
}

export async function settleOpenBook(connection, owner, market, base, quote) {
  for (let openOrders of await market.findOpenOrdersAccountsForOwner(
    connection,
    owner.publicKey,
  )) {
    if (openOrders.baseTokenFree > 0 || openOrders.quoteTokenFree > 0) {
      // spl-token accounts to which to send the proceeds from trades
      let baseTokenAccount = new PublicKey (ACCOUNT_MAP.get(base));
      let quoteTokenAccount = new PublicKey (ACCOUNT_MAP.get(quote));

      await market.settleFunds(
        connection,
        owner,
        openOrders,
        baseTokenAccount,
        quoteTokenAccount,
      );
    }
  }
}

export function getPayerAccount(hedgeSide, base, quote) {
    // spl-token accounts to which to use for trading
    let baseTokenAccount = new PublicKey (ACCOUNT_MAP.get(base));
    let quoteTokenAccount = new PublicKey (ACCOUNT_MAP.get(quote));
    if (hedgeSide == "buy"){
      return quoteTokenAccount
    } else{
      return baseTokenAccount
    };
  }

export async function cancelOpenBookOrders(connection, owner, spotMarket, symbol) {
  let myOrders = await spotMarket.loadOrdersForOwner(connection, owner.publicKey);
  for (let order of myOrders) {
    try {
      console.log(symbol, "Cancelling OpenBook Orders", order.size, symbol, "@", order.price, order.orderId.toString());
      await DexMarket.cancelOrder(connection, owner, spotMarket, order);
    } catch (err) {
      console.log(symbol, "Cancel OpenBook Orders", err, err.stack);
    }
  }
}

export async function getFairValue(connection, spotMarket, symbol) {
  const chainlinkPrice = await getChainlinkPrice(new PublicKey(tokenToSplMint(symbol)));
  const sbPrice = await getSwitchboardPrice(new PublicKey(tokenToSplMint(symbol)));
  const pythPrice = await getPythPrice(new PublicKey(tokenToSplMint(symbol)));
  const bids = await spotMarket.loadBids(connection);
  const asks = await spotMarket.loadAsks(connection);
  const [bidPrice, _bidSize] = bids.getL2(1)[0];
  const [askPrice, _askSize] = asks.getL2(1)[0];
  const midValue = (bidPrice + askPrice) / 2.0;
  const mktSpread = (askPrice - bidPrice) / midValue;
  let fairValue;
  if (chainlinkPrice > 0){
    fairValue = chainlinkPrice;
    console.log(symbol, "Use Chainlink Price", chainlinkPrice);
  } else if (sbPrice > 0) {
    fairValue = sbPrice;
    console.log(symbol, "Using Switchboard", sbPrice);
  } else if (pythPrice.price > 0) {
    fairValue = pythPrice.price;
    console.log(symbol, "Using Pyth", pythPrice.price);
  } else if (mktSpread < maxMktSpread) {
    fairValue = midValue;
    console.log(symbol, "Using OpenBook Mid Value", midValue);
  } else {
    fairValue = 0;
  }
  return fairValue;
}