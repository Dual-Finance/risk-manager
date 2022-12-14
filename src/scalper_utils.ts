// @ts-ignore
import * as greeks from "greeks";
import {
  BookSide,
  MangoCache,
  MangoGroup,
  PerpMarket,
} from "@blockworks-foundation/mango-client";
import { Account, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from "@solana/web3.js";
import { DIPDeposit, RouteDetails } from "./common";
import {
  ACCOUNT_MAP,
  cluster,
  mangoTesterPk,
  maxMktSpread,
  optionVaultPk,
  reductionSteps,
  rfRate,
  riskManagerPk,
  slippageMax,
  THEO_VOL_MAP,
} from "./config";
import { decimalsBaseSPL, getAssociatedTokenAddress, getChainlinkPrice, getPythPrice, getSwitchboardPrice, splMintToToken, tokenToSplMint } from "./utils";
import { Market } from "@project-serum/serum";
import { Jupiter } from "@jup-ag/core";
import JSBI from "jsbi";

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

// Check if liquidity is supportive & splice order
export function liquidityCheckAndNumSplices(
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
    return 0;
  } else {
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

export async function cancelTxOpenBookOrders(connection: Connection, owner: Keypair, 
  spotMarket: Market, symbol: string):Promise<Transaction | undefined> {
  let myOrders = await spotMarket.loadOrdersForOwner(connection, owner.publicKey);
  if (myOrders.length == 0){
    return undefined;
  }
  const cancelTx = new Transaction();
  for (let order of myOrders) {
    console.log(symbol, "Cancelling OpenBook Orders", order.size, symbol, "@", order.price, order.clientId.toString());
    cancelTx.add(await spotMarket.makeCancelOrderTransaction(connection, owner.publicKey, order))
  }
  return cancelTx;
}

export async function getFairValue(connection, spotMarket, symbol) {
  let fairValue: number;
  const chainlinkPrice = await getChainlinkPrice(new PublicKey(tokenToSplMint(symbol)));
  if (chainlinkPrice > 0){
    fairValue = chainlinkPrice;
    console.log(symbol, "Use Chainlink Price", chainlinkPrice);
  } else {
    const sbPrice = await getSwitchboardPrice(new PublicKey(tokenToSplMint(symbol)));
    if (sbPrice > 0) {
      fairValue = sbPrice;
      console.log(symbol, "Using Switchboard", sbPrice);
    } else {
      const pythPrice = await getPythPrice(new PublicKey(tokenToSplMint(symbol)));
      if (pythPrice > 0) {
        fairValue = pythPrice;
        console.log(symbol, "Using Pyth", pythPrice);
      } else {
        const bids = await spotMarket.loadBids(connection);
        const asks = await spotMarket.loadAsks(connection);
        const [bidPrice, _bidSize] = bids.getL2(1)[0];
        const [askPrice, _askSize] = asks.getL2(1)[0];
        const midValue = (bidPrice + askPrice) / 2.0;
        const mktSpread = (askPrice - bidPrice) / midValue;
        if (mktSpread < maxMktSpread) {
          fairValue = midValue;
          console.log(symbol, "Using OpenBook Mid Value", midValue);
        } else {
          fairValue = 0;
        }
      }
    }
  }
  return fairValue;
}

export async function jupiterHedge(connection: Connection, owner: Keypair, hedgeSide: string, 
    base: string, quote: string, hedgeDelta: number, hedgePrice: number) {
  const jupiter = await Jupiter.load({
    connection: connection,
    cluster: cluster,
    user: owner, 
    wrapUnwrapSOL: false, 
  });
  let inputToken: PublicKey;
  let outputToken: PublicKey;
  let hedgeAmount: number;
  // TODO Make Enum everywhere
  if (hedgeSide == "sell"){
    inputToken = new PublicKey(tokenToSplMint(base));
    outputToken = new PublicKey(tokenToSplMint(quote));
    hedgeAmount = Math.abs(hedgeDelta);
  } else {
    inputToken = new PublicKey(tokenToSplMint(quote));
    outputToken = new PublicKey(tokenToSplMint(base));
    hedgeAmount = Math.abs(hedgeDelta) * hedgePrice;
  }
  const inputQty = Math.round(hedgeAmount * (10 ** decimalsBaseSPL(splMintToToken(inputToken)))) // Amount to send to Jupiter
  // Find best route, qty & price
  let swapQty: number;
  let routeDetails: RouteDetails;
  for (let i=0; i < reductionSteps; i++){
    swapQty = Math.round((1 - i/reductionSteps) * inputQty);
    const routes = await jupiter.computeRoutes({
      inputMint: inputToken, 
      outputMint: outputToken, 
      amount: JSBI.BigInt(swapQty), // 1000000 => 1 USDC if inputToken.address is USDC mint
      slippageBps: slippageMax.get(base) * 100 * 100,  // 1 bps = 0.01%
      onlyDirectRoutes: true,
    });
    const bestRoute = routes.routesInfos[0];
    const inQty = JSBI.toNumber(bestRoute.marketInfos[0].inAmount) / (10 ** decimalsBaseSPL(splMintToToken(inputToken)));
    const outQty = JSBI.toNumber(bestRoute.marketInfos[0].outAmount) / (10 ** decimalsBaseSPL(splMintToToken(outputToken)));
    if (hedgeSide == "sell"){
      const netPrice = outQty / inQty;
      if (netPrice > hedgePrice){
        swapQty = swapQty / (10 ** decimalsBaseSPL(splMintToToken(inputToken))) * -1;
        const venue = bestRoute.marketInfos[0].amm.label;
        const { transactions } = await jupiter.exchange({
          routeInfo:routes.routesInfos[0],
        });
        routeDetails = {price: netPrice, qty: swapQty, venue: venue, txs: transactions};
        break;
      }
    } else {
      const netPrice = inQty / outQty;
      if (netPrice < hedgePrice){
        swapQty = swapQty / (10 ** decimalsBaseSPL(splMintToToken(inputToken))) / hedgePrice;
        const venue = bestRoute.marketInfos[0].amm.label;
        const { transactions } = await jupiter.exchange({
          routeInfo:routes.routesInfos[0],
        });
        routeDetails = {price: netPrice, qty: swapQty, venue: venue, txs: transactions};
        break;
      }
    }
  }
  return routeDetails;
}