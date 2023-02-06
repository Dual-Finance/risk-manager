import * as greeks from 'greeks';
import {
  BookSide, MangoCache, MangoGroup, PerpMarket,
} from '@blockworks-foundation/mango-client';
import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey,
  sendAndConfirmTransaction, Transaction,
} from '@solana/web3.js';
import { Market } from '@project-serum/serum';
import { getAssociatedTokenAddress } from '@project-serum/associated-token';
import fetch from 'node-fetch';
import { Jupiter } from '@jup-ag/core';
import JSBI from 'jsbi';
import {
  CallOrPut, DIPDeposit, RouteDetails, SYMBOL,
} from './common';
import {
  ACCOUNT_MAP, JUPITER_LIQUIDITY, MAX_MKT_SPREAD_PCT_FOR_PRICING, JUPITER_SEARCH_STEPS,
  RF_RATE, slippageMax, THEO_VOL_MAP, JUPITER_SLIPPAGE_BPS, PRIORITY_FEE,
  GAMMA_CYCLES, RESOLVE_PERIOD_MS,
} from './config';
import {
  decimalsBaseSPL, getChainlinkPrice, getPythPrice, getSwitchboardPrice,
  sleepExact, splMintToToken, tokenToSplMint,
} from './utils';
import {
  RM_PROD_PK, MS_PER_YEAR, NO_FAIR_VALUE, OPTION_VAULT_PK, RM_BACKUP_PK, SUFFICIENT_BOOK_DEPTH,
} from './constants';

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
  symbol: SYMBOL,
) {
  const impliedVol = THEO_VOL_MAP.get(symbol);
  let deltaSum = 0;
  for (const dip of dipProduct) {
    const yearsUntilMaturity = (dip.expirationMs - Date.now()) / MS_PER_YEAR;
    deltaSum += greeks.getDelta(
      fairValue,
      dip.strikeUsdcPerToken,
      yearsUntilMaturity,
      impliedVol,
      RF_RATE,
      dip.callOrPut,
    )
        * dip.qtyTokens;
  }
  return deltaSum;
}

export function getDIPGamma(
  dipProduct: DIPDeposit[],
  fairValue: number,
  symbol: SYMBOL,
) {
  const impliedVol = THEO_VOL_MAP.get(symbol);
  let gammaSum = 0;
  for (const dip of dipProduct) {
    const yearsUntilMaturity = (dip.expirationMs - Date.now()) / MS_PER_YEAR;
    gammaSum += greeks.getGamma(
      fairValue,
      dip.strikeUsdcPerToken,
      yearsUntilMaturity,
      impliedVol,
      RF_RATE,
      dip.callOrPut,
    )
        * dip.qtyTokens;
  }
  return gammaSum;
}

export function getDIPTheta(
  dipProduct: DIPDeposit[],
  fairValue: number,
  symbol: SYMBOL,
) {
  const impliedVol = THEO_VOL_MAP.get(symbol);
  let thetaSum = 0;
  for (const dip of dipProduct) {
    const yearsUntilMaturity = (dip.expirationMs - Date.now()) / MS_PER_YEAR;
    thetaSum += greeks.getTheta(
      fairValue,
      dip.strikeUsdcPerToken,
      yearsUntilMaturity,
      impliedVol,
      RF_RATE,
      dip.callOrPut,
    )
        * dip.qtyTokens;
  }
  return thetaSum;
}

export function getMangoHedgeProduct(hedgeSide: string, buySpot: boolean, sellSpot: boolean): '-SPOT' | '-PERP' {
  if (hedgeSide === 'buy' && buySpot) {
    return '-SPOT';
  } if (hedgeSide === 'sell' && sellSpot) {
    return '-SPOT';
  }
  return '-PERP';
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
    console.log(`Sell Price Impact: ${side.getImpactPriceUi(nativeQty)} High Slippage!`);
  } else if (
    qty < 0
    && side.getImpactPriceUi(nativeQty) > price * (1 + slippage)
  ) {
    spliceFactor = Math.max((qty * price) / notionalMax, 1);
    console.log(`Buy Price Impact: ${side.getImpactPriceUi(nativeQty)} High Slippage!`);
  } else {
    spliceFactor = 1;
    console.log(`Slippage Tolerable ${side.getImpactPriceUi(nativeQty)}`);
  }
  console.log(`Splice factor: ${spliceFactor}`);
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
  if (hedgeSide === 'sell') {
    for (const bid of bids) {
      if (bid.price > price) {
        depth += bid.size;
      }
    }
  } else if (hedgeSide === 'buy') {
    for (const ask of asks) {
      if (ask.price < price) {
        depth += ask.size;
      }
    }
  }
  if (depth > Math.abs(qty)) {
    return SUFFICIENT_BOOK_DEPTH;
  }
  return Math.max((Math.abs(qty) * price) / notionalMax, 1);
}

// Fill Size from any perp orders
export async function fillSize(
  perpMarket: PerpMarket,
  connection: Connection,
  orderID: number,
) {
  let filledQty = 0;
  for (const fill of await perpMarket.loadFills(connection)) {
    if (
      fill.makerClientOrderId.toString() === orderID.toString()
      || fill.takerClientOrderId.toString() === orderID.toString()
    ) {
      if (fill.takerSide === 'buy') {
        filledQty += fill.quantity;
      } else if (fill.takerSide === 'sell') {
        filledQty -= fill.quantity;
      }
    }
  }
  return filledQty;
}

// TODO: Update this to also take into account the openbook position
// Get Spot Balance
export async function getSpotDelta(connection: Connection, symbol: SYMBOL) {
  let mainDelta = 0;
  let tokenDelta = 0;
  let spotDelta = 0;
  let tokenDecimals = 1;
  const accountList = [RM_PROD_PK, OPTION_VAULT_PK, RM_BACKUP_PK];
  for (const account of accountList) {
    if (symbol === 'SOL') {
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

// TODO: Refine logic & make dynamic.
export function setPriorityFee(
  tx: Transaction,
) {
  const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
    units: 1_000_000,
  });
  const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: PRIORITY_FEE,
  });
  tx.add(modifyComputeUnits);
  tx.add(addPriorityFee);
  return tx;
}

export async function tryToSettleOpenBook(
  connection: Connection,
  owner: Keypair,
  market: Market,
  base: SYMBOL,
  quote: SYMBOL,
) {
  const settleTx = new Transaction();
  let needSettle = false;
  for (const openOrders of await market.findOpenOrdersAccountsForOwner(
    connection,
    owner.publicKey,
  )) {
    if (openOrders.baseTokenFree.toNumber() > 0 || openOrders.quoteTokenFree.toNumber() > 0) {
      const baseRecipientAccount = new PublicKey(ACCOUNT_MAP.get(base));
      const quoteRecipientAccount = new PublicKey(ACCOUNT_MAP.get(quote));
      const { transaction } = (
        await market.makeSettleFundsTransaction(
          connection,
          openOrders,
          baseRecipientAccount,
          quoteRecipientAccount,
        ));
      settleTx.add(transaction);
      needSettle = true;
    }
  }

  // If there are funds ready to be settled, settle them
  if (needSettle) {
    try {
      await sendAndConfirmTransaction(
        connection,
        setPriorityFee(settleTx),
        [owner],
      );
    } catch (err) {
      console.log(err, 'Settle open book error');
    }
  }
  return settleTx;
}

export function getPayerAccount(hedgeSide: 'buy' | 'sell', base: SYMBOL, quote: SYMBOL) {
  const baseTokenAccount = new PublicKey(ACCOUNT_MAP.get(base));
  const quoteTokenAccount = new PublicKey(ACCOUNT_MAP.get(quote));
  if (hedgeSide === 'buy') {
    return quoteTokenAccount;
  }
  return baseTokenAccount;
}

export async function cancelOpenBookOrders(
  connection: Connection,
  owner: Keypair,
  spotMarket: Market,
  symbol: SYMBOL,
):Promise<void> {
  const myOrders = await spotMarket.loadOrdersForOwner(connection, owner.publicKey);
  if (myOrders.length === 0) {
    return;
  }
  const cancelTx = new Transaction();
  for (const order of myOrders) {
    console.log(symbol, 'Cancelling OpenBook Orders', order.size, symbol, '@', order.price, order.clientId.toString());
    cancelTx.add(spotMarket.makeCancelOrderInstruction(connection, owner.publicKey, order));
  }

  await sendAndConfirmTransaction(connection, setPriorityFee(cancelTx), [owner]);
}

export async function getJupiterPrice(
  base: SYMBOL,
  quote: SYMBOL,
  jupiter: Jupiter,
) {
  // Check asks
  const inputBuyToken = new PublicKey(tokenToSplMint(quote));
  const outputBuyToken = new PublicKey(tokenToSplMint(base));
  const inBuyAtomsPerToken = 10 ** decimalsBaseSPL(splMintToToken(inputBuyToken));
  const outBuyAtomsPerToken = 10 ** decimalsBaseSPL(splMintToToken(outputBuyToken));
  const buyQty = Math.round(JUPITER_LIQUIDITY * inBuyAtomsPerToken);
  const buyRoutes = await jupiter.computeRoutes({
    inputMint: inputBuyToken,
    outputMint: outputBuyToken,
    amount: JSBI.BigInt(buyQty),
    slippageBps: JUPITER_SLIPPAGE_BPS,
    onlyDirectRoutes: false,
  });
  const buyPath = buyRoutes.routesInfos[0];
  const numBuyPath = buyPath.marketInfos.length;
  const inBuyQty = JSBI.toNumber(buyPath.marketInfos[0].inAmount) / inBuyAtomsPerToken;
  const outBuyQty = (JSBI.toNumber(buyPath.marketInfos[numBuyPath - 1].outAmount)
    / outBuyAtomsPerToken);
  const buyPrice = inBuyQty / outBuyQty;

  // Check bids
  const inputSellToken = new PublicKey(tokenToSplMint(base));
  const outputSellToken = new PublicKey(tokenToSplMint(quote));
  const inSellAtomsPerToken = 10 ** decimalsBaseSPL(splMintToToken(inputSellToken));
  const outSellAtomsPerToken = 10 ** decimalsBaseSPL(splMintToToken(outputSellToken));
  const sellQty = Math.round((JUPITER_LIQUIDITY * inSellAtomsPerToken) / buyPrice);
  const sellRoutes = await jupiter.computeRoutes({
    inputMint: inputSellToken,
    outputMint: outputSellToken,
    amount: JSBI.BigInt(sellQty),
    slippageBps: JUPITER_SLIPPAGE_BPS,
    onlyDirectRoutes: false,
  });
  const sellPath = sellRoutes.routesInfos[0];
  const numSellPath = sellPath.marketInfos.length;
  const inSellQty = JSBI.toNumber(sellPath.marketInfos[0].inAmount) / inSellAtomsPerToken;
  const outSellQty = (JSBI.toNumber(sellPath.marketInfos[numSellPath - 1].outAmount)
    / outSellAtomsPerToken);
  const sellPrice = outSellQty / inSellQty;

  // Calculate midpoint price of aggregtor
  const midPrice = (buyPrice + sellPrice) / 2;
  return midPrice;
}

// Check oracles in order of preference and then use openbook midpoint if all fail.
async function getOraclePrice(symbol: SYMBOL, connection: Connection, spotMarket: Market) {
  const chainlinkPrice = await getChainlinkPrice(new PublicKey(tokenToSplMint(symbol)));
  if (chainlinkPrice > 0) {
    console.log(`${symbol}: Chainlink Price: ${chainlinkPrice}`);
    return chainlinkPrice;
  }

  const sbPrice = await getSwitchboardPrice(new PublicKey(tokenToSplMint(symbol)));
  if (sbPrice > 0) {
    console.log(`${symbol}: Switchboard Price: ${sbPrice}`);
    return sbPrice;
  }

  const pythPrice = await getPythPrice(new PublicKey(tokenToSplMint(symbol)));
  if (pythPrice > 0) {
    console.log(`${symbol}: Pyth Price: ${pythPrice}`);
    return pythPrice;
  }

  const bids = await spotMarket.loadBids(connection);
  const asks = await spotMarket.loadAsks(connection);
  const [bidPrice, _bidSize] = bids.getL2(1)[0];
  const [askPrice, _askSize] = asks.getL2(1)[0];
  const midValue = (bidPrice + askPrice) / 2.0;
  const mktSpread = (askPrice - bidPrice) / midValue;
  if (mktSpread < MAX_MKT_SPREAD_PCT_FOR_PRICING) {
    console.log(`${symbol}: Openbook Mid Price: ${midValue}`);
    return midValue;
  }

  return NO_FAIR_VALUE;
}

async function getFairValue(
  connection: Connection,
  spotMarket: Market,
  symbol: SYMBOL,
  jupiter: Jupiter,
) {
  const fairValue = await getOraclePrice(symbol, connection, spotMarket);

  const jupPrice = await getJupiterPrice(symbol, 'USDC', jupiter);
  const oracleSlippage = Math.abs(fairValue - jupPrice) / fairValue;
  if (oracleSlippage > slippageMax.get(symbol)) {
    const oracleSlippageBps = Math.round(oracleSlippage * 100 * 100);
    console.log(
      `${symbol}: Using Jupiter Mid Price ${jupPrice} Oracle Slippage: ${oracleSlippageBps}`,
    );
    return jupPrice;
  }
  return fairValue;
}

export async function findFairValue(
  connection: Connection,
  spotMarket: Market,
  symbol: SYMBOL,
  jupiter: Jupiter,
  tries: number,
  waitSecPerTry: number,
) {
  let fairValue = await getFairValue(connection, spotMarket, symbol, jupiter);
  for (let i = 0; i < tries; i++) {
    if (fairValue === NO_FAIR_VALUE) {
      console.log(this.symbol, 'Cannot find fair value');
      await sleepExact(waitSecPerTry);
      fairValue = await getFairValue(this.connection, spotMarket, this.symbol, jupiter);
    }
  }
  if (fairValue === NO_FAIR_VALUE) {
    console.log(this.symbol, 'No Robust Pricing. Exiting Gamma Scalp', waitSecPerTry);
  }
  return fairValue;
}

export async function jupiterHedge(
  hedgeSide: string,
  base: SYMBOL,
  quote: SYMBOL,
  hedgeDelta: number,
  hedgePrice: number,
  jupiter: Jupiter,
) {
  let inputToken: PublicKey;
  let outputToken: PublicKey;
  let hedgeAmount: number;
  // TODO: Make Enum everywhere
  if (hedgeSide === 'sell') {
    inputToken = new PublicKey(tokenToSplMint(base));
    outputToken = new PublicKey(tokenToSplMint(quote));
    hedgeAmount = Math.abs(hedgeDelta);
  } else {
    inputToken = new PublicKey(tokenToSplMint(quote));
    outputToken = new PublicKey(tokenToSplMint(base));
    hedgeAmount = Math.abs(hedgeDelta) * hedgePrice;
  }
  const inputMaxQty = Math.round(hedgeAmount * (10 ** decimalsBaseSPL(splMintToToken(inputToken))));

  // Sort through paths of swap qty.
  let routeDetails: RouteDetails;
  let sortFactor = 2;
  let lastSucess: boolean;
  for (let i = 0; i < JUPITER_SEARCH_STEPS; i++) {
    sortFactor += lastSucess ? 1 / (2 ** i) : -1 / (2 ** i);
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
    const inAtomsPerToken = 10 ** decimalsBaseSPL(splMintToToken(inputToken));
    const outAtomsPerToken = 10 ** decimalsBaseSPL(splMintToToken(outputToken));
    const inQty = JSBI.toNumber(bestRoute.marketInfos[0].inAmount) / inAtomsPerToken;
    const outQty = JSBI.toNumber(bestRoute.marketInfos[numRoutes - 1].outAmount) / outAtomsPerToken;

    const netPrice = hedgeSide === 'sell' ? outQty / inQty : inQty / outQty;
    const venue = bestRoute.marketInfos[numRoutes - 1].amm.label;
    const { transactions } = await jupiter.exchange({ routeInfo: routes.routesInfos[0] });

    if (hedgeSide === 'sell') {
      if (netPrice > hedgePrice) {
        const swapQty = -searchQty / inAtomsPerToken;
        routeDetails = {
          price: netPrice, qty: swapQty, venue, txs: transactions,
        };
        lastSucess = true;
        if (i === 0) {
          break;
        }
      }
    } else if (netPrice < hedgePrice) {
      const swapQty = searchQty / inAtomsPerToken / hedgePrice;
      routeDetails = {
        price: netPrice, qty: swapQty, venue, txs: transactions,
      };
      lastSucess = true;
      if (i === 0) {
        break;
      }
    }
  }
  return routeDetails;
}

export async function getJupPriceAPI(baseMint: PublicKey): Promise<number> {
  const url = `https://quote-api.jup.ag/v3/price?ids=${baseMint}`;
  const { data } = await (await fetch(url)).json();
  const { price } = data[baseMint.toBase58()];
  return price;
}

export function waitForFill(conditionFunction, cycleDurationSec: number) {
  let pollCount = 0;
  const poll = (resolve) => {
    pollCount += 1;
    if (pollCount > (cycleDurationSec * RESOLVE_PERIOD_MS) / GAMMA_CYCLES) {
      resolve();
    } else if (conditionFunction()) {
      resolve();
    } else {
      setTimeout((_) => poll(resolve), RESOLVE_PERIOD_MS);
    }
  };
  return new Promise(poll);
}

// Find the max strike of a set of DIPs/SOs
export function findMaxStrike(dipProduct: DIPDeposit[]) {
  let strikeMax = dipProduct[0].strikeUsdcPerToken;
  for (const dip of dipProduct) {
    if (dip.strikeUsdcPerToken > strikeMax) { strikeMax = dip.strikeUsdcPerToken; }
  }
  return strikeMax;
}

// Find the min strike of a set of DIPs/SOs
export function findMinStrike(dipProduct: DIPDeposit[]) {
  let strikeMin = dipProduct[0].strikeUsdcPerToken;
  for (const dip of dipProduct) {
    if (dip.strikeUsdcPerToken < strikeMin) { strikeMin = dip.strikeUsdcPerToken; }
  }
  return strikeMin;
}

// Find the nearest strike of a set of DIPs/SOs
export function findNearestStrikeType(dipProduct: DIPDeposit[], fairValue: number) {
  let nearestStrike = dipProduct[0].strikeUsdcPerToken;
  let nearStrikeType: CallOrPut;
  for (const dip of dipProduct) {
    if (Math.abs(dip.strikeUsdcPerToken - fairValue) < Math.abs(nearestStrike - fairValue)) {
      nearestStrike = dip.strikeUsdcPerToken;
      nearStrikeType = dip.callOrPut;
    }
  }
  return nearStrikeType;
}

export function roundPriceToTickSize(amount: number, tickSize: number) {
  return Math.round(amount * (1 / tickSize)) / (1 / tickSize);
}

export function roundQtyToSpotSize(amount: number, spotSize: number) {
  return Math.round(amount * (1 / spotSize)) / (1 / spotSize);
}
