/* eslint-disable */
// @ts-ignore
import * as greeks from 'greeks';
import {
  BookSide,
  MangoCache,
  MangoGroup,
  PerpMarket,
} from '@blockworks-foundation/mango-client';
import {
   ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, TransactionInstruction,
} from '@solana/web3.js';
import { Market } from '@project-serum/serum';
import { getAssociatedTokenAddress } from '@project-serum/associated-token';
import fetch from "node-fetch"
import { Jupiter } from '@jup-ag/core';
import JSBI from 'jsbi';
import { DIPDeposit, RouteDetails } from './common';
import {
  ACCOUNT_MAP,
  JUPITER_LIQUIDITY,
  mangoTesterPk,
  maxMktSpreadPctForPricing,
  optionVaultPk,
  jupiterSearchSteps,
  rfRate,
  riskManagerPk,
  slippageMax,
  THEO_VOL_MAP,
  jupiterSlippageBps,
  PRIORITY_FEE,
} from './config';
import {
  decimalsBaseSPL, getChainlinkPrice, getPythPrice, getSwitchboardPrice, splMintToToken, tokenToSplMint,
} from './utils';

export async function loadPrices(
  mangoGroup: MangoGroup,
  connection: Connection,
) {
  const [mangoCache]: [MangoCache] = await Promise.all([
    mangoGroup.loadCache(connection),
  ]);
  return [mangoCache];
}

export function getDIPDelta(
  dipProduct: DIPDeposit[],
  fairValue: number,
  symbol: string,
) {
  const impliedVol = THEO_VOL_MAP.get(symbol);
  let yearsUntilMaturity: number;
  let deltaSum = 0;
  for (const dip of dipProduct) {
    yearsUntilMaturity = (dip.expirationMs - Date.now()) / (365 * 60 * 60 * 24 * 1_000);
    deltaSum = greeks.getDelta(
      fairValue,
      dip.strikeUsdcPerToken,
      yearsUntilMaturity,
      impliedVol,
      rfRate,
      dip.callOrPut,
    )
        * dip.qtyTokens
      + deltaSum;
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
  market: PerpMarket,
) {
  let spliceFactor: number;
  const [_, nativeQty] = market.uiToNativePriceQuantity(0, qty);
  if (qty > 0 && side.getImpactPriceUi(nativeQty) < price * (1 - slippage)) {
    spliceFactor = Math.max((qty * price) / notionalMax, 1);
    console.log(
      'Sell Price Impact: ',
      side.getImpactPriceUi(nativeQty),
      'High Slippage!',
      spliceFactor,
    );
  } else if (
    qty < 0
    && side.getImpactPriceUi(nativeQty) > price * (1 + slippage)
  ) {
    spliceFactor = Math.max((qty * price) / notionalMax, 1);
    console.log(
      'Buy Price Impact: ',
      side.getImpactPriceUi(nativeQty),
      'High Slippage!',
      spliceFactor,
    );
  } else {
    spliceFactor = 1;
    console.log('Slippage Tolerable', side.getImpactPriceUi(nativeQty));
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
  if (hedgeSide == 'sell') {
    for (const bid of bids) {
      if (bid.price > price) {
        depth = bid.size + depth;
      }
    }
  } else if (hedgeSide == 'buy') {
    for (const ask of asks) {
      if (ask.price < price) {
        depth = ask.size + depth;
      }
    }
  }
  if (depth > Math.abs(qty)) {
    return 0;
  }
  return Math.max((Math.abs(qty) * price) / notionalMax, 1);
}

export function getDIPGamma(
  dipProduct: DIPDeposit[],
  fairValue: number,
  symbol: string,
) {
  const impliedVol = THEO_VOL_MAP.get(symbol);
  let yearsUntilMaturity: number;
  let gammaSum = 0;
  for (const dip of dipProduct) {
    yearsUntilMaturity = (dip.expirationMs - Date.now()) / (365 * 60 * 60 * 24 * 1_000);
    gammaSum = greeks.getGamma(
      fairValue,
      dip.strikeUsdcPerToken,
      yearsUntilMaturity,
      impliedVol,
      rfRate,
      dip.callOrPut,
    )
        * dip.qtyTokens
      + gammaSum;
  }
  return gammaSum;
}

export function getDIPTheta(
  dipProduct: DIPDeposit[],
  fairValue: number,
  symbol: string,
) {
  const impliedVol = THEO_VOL_MAP.get(symbol);
  let yearsUntilMaturity: number;
  let thetaSum = 0;
  for (const dip of dipProduct) {
    yearsUntilMaturity = (dip.expirationMs - Date.now()) / (365 * 60 * 60 * 24 * 1_000);
    thetaSum = greeks.getTheta(
      fairValue,
      dip.strikeUsdcPerToken,
      yearsUntilMaturity,
      impliedVol,
      rfRate,
      dip.callOrPut,
    )
        * dip.qtyTokens
        + thetaSum;
  }
  return thetaSum;
}

// Fill Size from any perp orders
export async function fillSize(
  perpMarket: PerpMarket,
  connection: Connection,
  orderID: number,
) {
  let filledQty = 0;
  // Possible issue using loadFills instead of Websocket?
  for (const fill of await perpMarket.loadFills(connection)) {
    if (
      fill.makerClientOrderId.toString() == orderID.toString()
      || fill.takerClientOrderId.toString() == orderID.toString()
    ) {
      if (fill.takerSide == 'buy') {
        filledQty += fill.quantity;
      } else if (fill.takerSide == 'sell') {
        filledQty -= fill.quantity;
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
  const accountList = [mangoTesterPk, optionVaultPk, riskManagerPk];
  for (const account of accountList) {
    if (symbol == 'SOL') {
      mainDelta = (await connection.getBalance(account)) / LAMPORTS_PER_SOL;
    }
    try {
      const tokenAccount = await getAssociatedTokenAddress(
        account,
        tokenToSplMint(symbol),
      );
      const balance = await connection.getTokenAccountBalance(tokenAccount);
      const tokenBalance = Number(balance.value.amount);
      tokenDecimals = balance.value.decimals;
      tokenDelta = tokenBalance / 10 ** tokenDecimals;
    } catch (err) {
      tokenDelta = 0;
    }
    spotDelta = mainDelta + tokenDelta + spotDelta;
  }
  return spotDelta;
}

export async function settleOpenBook(connection : Connection, owner: Keypair, market : Market, base: string, quote: string) {
  let settleTx = new Transaction();
  for (const openOrders of await market.findOpenOrdersAccountsForOwner(
    connection,
    owner.publicKey,
  )) {
    if (openOrders.baseTokenFree.toNumber() > 0 || openOrders.quoteTokenFree.toNumber() > 0) {
      // spl-token accounts to which to send the proceeds from trades
      const baseTokenAccount = new PublicKey(ACCOUNT_MAP.get(base));
      const quoteTokenAccount = new PublicKey(ACCOUNT_MAP.get(quote));
      const { transaction } = await market.makeSettleFundsTransaction(connection, openOrders, baseTokenAccount, quoteTokenAccount)
      settleTx.add(transaction);
    }
  }
  return settleTx;
}

export function getPayerAccount(hedgeSide, base, quote) {
  // spl-token accounts to which to use for trading
  const baseTokenAccount = new PublicKey(ACCOUNT_MAP.get(base));
  const quoteTokenAccount = new PublicKey(ACCOUNT_MAP.get(quote));
  if (hedgeSide == 'buy') {
    return quoteTokenAccount;
  }
  return baseTokenAccount;
}

export async function cancelTxOpenBookOrders(
  connection: Connection,
  owner: Keypair,
  spotMarket: Market,
  symbol: string,
):Promise<Transaction | undefined> {
  const myOrders = await spotMarket.loadOrdersForOwner(connection, owner.publicKey);
  if (myOrders.length == 0) {
    return undefined;
  }
  const cancelTx = new Transaction();
  for (const order of myOrders) {
    console.log(symbol, 'Cancelling OpenBook Orders', order.size, symbol, '@', order.price, order.clientId.toString());
    cancelTx.add(spotMarket.makeCancelOrderInstruction(connection, owner.publicKey, order));
  }
  return cancelTx;
}

export async function getFairValue(
  connection : Connection,
  spotMarket : Market,
  symbol: string,
  jupiter: Jupiter,
  ) {
  let fairValue = 0; // Fail to return a zero price
  const chainlinkPrice = await getChainlinkPrice(new PublicKey(tokenToSplMint(symbol)));
  if (chainlinkPrice > 0) {
    fairValue = chainlinkPrice;
    console.log(symbol, 'Chainlink Price', chainlinkPrice);
  } else {
    const sbPrice = await getSwitchboardPrice(new PublicKey(tokenToSplMint(symbol)));
    if (sbPrice > 0) {
      fairValue = sbPrice;
      console.log(symbol, 'Switchboard Price', sbPrice);
    } else {
      const pythPrice = await getPythPrice(new PublicKey(tokenToSplMint(symbol)));
      if (pythPrice > 0) {
        fairValue = pythPrice;
        console.log(symbol, 'Pyth Price', pythPrice);
      } else {
        const bids = await spotMarket.loadBids(connection);
        const asks = await spotMarket.loadAsks(connection);
        const [bidPrice, _bidSize] = bids.getL2(1)[0];
        const [askPrice, _askSize] = asks.getL2(1)[0];
        const midValue = (bidPrice + askPrice) / 2.0;
        const mktSpread = (askPrice - bidPrice) / midValue;
        if (mktSpread < maxMktSpreadPctForPricing) {
          fairValue = midValue;
          console.log(symbol, 'OpenBook Mid Price', midValue);
        } else {
          fairValue = 0;
        }
      }
    }
  }
  const jupPrice = await getJupiterPrice(symbol, "USDC", jupiter);
  const oracleSlippage = Math.abs(fairValue - jupPrice) / fairValue;
  if (oracleSlippage > slippageMax.get(symbol)) {
    fairValue = jupPrice;
    console.log(symbol, 'Using Jupiter Mid Price', jupPrice, 'Oracle Slippage', Math.round(oracleSlippage * 100 * 100));
  }
  return fairValue;
}

export async function jupiterHedge(
  hedgeSide: string,
  base: string,
  quote: string,
  hedgeDelta: number,
  hedgePrice: number,
  jupiter: Jupiter,
) {
  let inputToken: PublicKey;
  let outputToken: PublicKey;
  let hedgeAmount: number;
  // TODO Make Enum everywhere
  if (hedgeSide == 'sell') {
    inputToken = new PublicKey(tokenToSplMint(base));
    outputToken = new PublicKey(tokenToSplMint(quote));
    hedgeAmount = Math.abs(hedgeDelta);
  } else {
    inputToken = new PublicKey(tokenToSplMint(quote));
    outputToken = new PublicKey(tokenToSplMint(base));
    hedgeAmount = Math.abs(hedgeDelta) * hedgePrice;
  }
  const inputMaxQty = Math.round(hedgeAmount * (10 ** decimalsBaseSPL(splMintToToken(inputToken))));

  // Sort through paths of swap qty efficiently
  let routeDetails: RouteDetails;
  let sortFactor = 2;
  let lastSucess: Boolean;
  for (let i = 0; i < jupiterSearchSteps; i++) {
    sortFactor = lastSucess ? sortFactor + 1 / (2 ** i) : sortFactor - 1 / (2 ** i);
    lastSucess = false;
    const searchQty = Math.round(inputMaxQty * sortFactor);
    const routes = await jupiter.computeRoutes({
      inputMint: inputToken,
      outputMint: outputToken,
      amount: JSBI.BigInt(searchQty),
      slippageBps: slippageMax.get(base) * 100 * 100,
      onlyDirectRoutes: false,
    });
    const bestRoute = routes.routesInfos[0];
    const numRoutes = bestRoute.marketInfos.length;
    const inQty = JSBI.toNumber(bestRoute.marketInfos[0].inAmount) / (10 ** decimalsBaseSPL(splMintToToken(inputToken)));
    const outQty = JSBI.toNumber(bestRoute.marketInfos[numRoutes - 1].outAmount) / (10 ** decimalsBaseSPL(splMintToToken(outputToken)));
    const netPrice = hedgeSide == 'sell' ? outQty / inQty : inQty / outQty;
    if (hedgeSide == 'sell') {
      if (netPrice > hedgePrice) {
        const swapQty = searchQty / (10 ** decimalsBaseSPL(splMintToToken(inputToken))) * -1;
        const venue = bestRoute.marketInfos[numRoutes - 1].amm.label;
        const { transactions } = await jupiter.exchange({
          routeInfo: routes.routesInfos[0],
        });
        routeDetails = {
          price: netPrice, qty: swapQty, venue, txs: transactions,
        };
        lastSucess = true;
        if (i == 0) {
          break;
        }
      }
    } else if (netPrice < hedgePrice) {
      const swapQty = searchQty / (10 ** decimalsBaseSPL(splMintToToken(inputToken))) / hedgePrice;
      const venue = bestRoute.marketInfos[numRoutes - 1].amm.label;
      const { transactions } = await jupiter.exchange({
        routeInfo: routes.routesInfos[0],
      });
      routeDetails = {
        price: netPrice, qty: swapQty, venue, txs: transactions,
      };
      lastSucess = true;
      if (i == 0) {
        break;
      }
    }
  }
  return routeDetails;
}
export async function getJupPriceAPI(baseMint: PublicKey) :Promise<number> {
  const url = `https://quote-api.jup.ag/v3/price?ids=${baseMint}`;
  const { data }  = await (await fetch(url)).json();
  const { price } = data[baseMint.toBase58()];
  return price;
}

export async function getJupiterPrice(
  base: string,
  quote: string,
  jupiter: Jupiter,
) {
  //Check asks
  const inputBuyToken = new PublicKey(tokenToSplMint(quote));
  const outputBuyToken = new PublicKey(tokenToSplMint(base));
  const buyQty = Math.round(JUPITER_LIQUIDITY * (10 ** decimalsBaseSPL(splMintToToken(inputBuyToken))));
  const buyRoutes = await jupiter.computeRoutes({
    inputMint: inputBuyToken,
    outputMint: outputBuyToken,
    amount: JSBI.BigInt(buyQty),
    slippageBps: jupiterSlippageBps,
    onlyDirectRoutes: false,
  });
  const buyPath = buyRoutes.routesInfos[0];
  const numBuyPath = buyPath.marketInfos.length;
  const inBuyQty = JSBI.toNumber(buyPath.marketInfos[0].inAmount) / (10 ** decimalsBaseSPL(splMintToToken(inputBuyToken)));
  const outBuyQty = JSBI.toNumber(buyPath.marketInfos[numBuyPath - 1].outAmount) / (10 ** decimalsBaseSPL(splMintToToken(outputBuyToken)));
  const buyPrice = inBuyQty / outBuyQty;

  // Check bids
  const inputSellToken = new PublicKey(tokenToSplMint(base));
  const outputSellToken = new PublicKey(tokenToSplMint(quote));
  const sellQty = Math.round(JUPITER_LIQUIDITY * (10 ** decimalsBaseSPL(splMintToToken(inputSellToken))) / buyPrice);
  const sellRoutes = await jupiter.computeRoutes({
    inputMint: inputSellToken,
    outputMint: outputSellToken,
    amount: JSBI.BigInt(sellQty),
    slippageBps: jupiterSlippageBps,
    onlyDirectRoutes: false,
  });
  const sellPath = sellRoutes.routesInfos[0];
  const numSellPath = sellPath.marketInfos.length;
  const inSellQty = JSBI.toNumber(sellPath.marketInfos[0].inAmount) / (10 ** decimalsBaseSPL(splMintToToken(inputSellToken)));
  const outSellQty = JSBI.toNumber(sellPath.marketInfos[numSellPath - 1].outAmount) / (10 ** decimalsBaseSPL(splMintToToken(outputSellToken)));
  const sellPrice = outSellQty / inSellQty;

  // Calc midpoint price of aggregtor
  const midPrice = (buyPrice + sellPrice) / 2;
  return midPrice;
}

// TODO refine logic & make dynamic
export function setPriorityFee(
  tx: Transaction
) {
  const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({ 
    units: 1000000 
  });
  const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({ 
    microLamports: PRIORITY_FEE
  });
  tx.add(modifyComputeUnits);
  tx.add(addPriorityFee);
  return tx;
}