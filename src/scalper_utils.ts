import * as greeks from 'greeks';
import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey,
  sendAndConfirmTransaction, Transaction,
} from '@solana/web3.js';
import { Market } from '@project-serum/serum';
import { getAssociatedTokenAddress } from '@project-serum/associated-token';
import fetch from 'node-fetch';
import { Jupiter } from '@jup-ag/core';
import JSBI from 'jsbi';
import { StakingOptions } from '@dual-finance/staking-options';
import {
  CallOrPut, DIPDeposit, RouteDetails, SYMBOL,
} from './common';
import {
  JUPITER_LIQUIDITY, MAX_MKT_SPREAD_PCT_FOR_PRICING, JUPITER_SEARCH_STEPS,
  RF_RATE, slippageMax, THEO_VOL_MAP, JUPITER_SLIPPAGE_BPS, PRIORITY_FEE,
  GAMMA_CYCLES, RESOLVE_PERIOD_MS, PRICE_OVERRIDE, HedgeSide,
  CLUSTER, MAX_LOAD_TIME, LIQUID_SYMBOLS, ELIGIBLE_SO_STATES, TREASURY_POSITIONS,
} from './config';
import {
  asyncCallWithTimeoutasync,
  decimalsBaseSPL, getChainlinkPrice, getPythPrice, getSwitchboardPrice,
  sleepExact, splMintToToken, tokenToSplMint,
} from './utils';
import {
  RM_PROD_PK, MS_PER_YEAR, NO_FAIR_VALUE, OPTION_VAULT_PK, RM_BACKUP_PK,
  SUFFICIENT_BOOK_DEPTH,
} from './constants';

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

// TODO: Update this to also take into account the openbook position
// Get Spot Balance
export async function getSpotDelta(
  connection: Connection,
  symbol: SYMBOL,
  owner: Keypair,
  market: Market,
) {
  let mainDelta = 0;
  let tokenDelta = 0;
  let spotDelta = 0;
  let tokenDecimals = 1;
  let openOrderQty = 0;
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
  if (market !== undefined) {
    const openBookOO = await market.findOpenOrdersAccountsForOwner(
      connection,
      owner.publicKey,
    );
    for (const openOrders of openBookOO) {
      openOrderQty += openOrders.baseTokenTotal.toNumber() / 10 ** tokenDecimals;
    }
  }
  return spotDelta + openOrderQty;
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
      const baseRecipientAccount = await getAssociatedTokenAddress(
        owner.publicKey,
        tokenToSplMint(base),
      );
      const quoteRecipientAccount = await getAssociatedTokenAddress(
        owner.publicKey,
        tokenToSplMint(quote),
      );
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

export async function getPayerAccount(
  hedgeSide: HedgeSide,
  base: SYMBOL,
  quote: SYMBOL,
  owner: Keypair,
) {
  const baseTokenAccount = await getAssociatedTokenAddress(
    owner.publicKey,
    tokenToSplMint(base),
  );
  const quoteTokenAccount = await getAssociatedTokenAddress(
    owner.publicKey,
    tokenToSplMint(quote),
  );
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
  try {
    await sendAndConfirmTransaction(connection, setPriorityFee(cancelTx), [owner]);
  } catch (err) {
    console.log(symbol, 'Cancel Order Failure', err);
  }
}

export async function getJupiterPrice(
  base: SYMBOL,
  quote: SYMBOL,
  connection: Connection,
  owner: Keypair,
) {
  console.log(base, 'Loading Jupiter For Price');
  const jupiter = await Jupiter.load({
    connection,
    cluster: CLUSTER,
    user: owner,
    wrapUnwrapSOL: false,
    restrictIntermediateTokens: true,
    shouldLoadSerumOpenOrders: false,
  });
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
export async function getOraclePrice(symbol: SYMBOL) {
  const chainlinkPrice = await getChainlinkPrice(new PublicKey(tokenToSplMint(symbol)));
  if (chainlinkPrice > 0) {
    console.log(`${symbol} Chainlink Price: ${chainlinkPrice}`);
    return chainlinkPrice;
  }

  const sbPrice = await getSwitchboardPrice(new PublicKey(tokenToSplMint(symbol)));
  if (sbPrice > 0) {
    console.log(`${symbol} Switchboard Price: ${sbPrice}`);
    return sbPrice;
  }

  const pythPrice = await getPythPrice(new PublicKey(tokenToSplMint(symbol)));
  if (pythPrice > 0) {
    console.log(`${symbol} Pyth Price: ${pythPrice}`);
    return pythPrice;
  }

  return NO_FAIR_VALUE;
}

export async function getOpenBookMidPrice(
  symbol: SYMBOL,
  spotMarket:Market,
  connection: Connection,
) {
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

export async function getFairValue(
  connection: Connection,
  owner: Keypair,
  spotMarket: Market,
  symbol: SYMBOL,
) {
  const fairValue = await getOraclePrice(symbol);
  if (fairValue === NO_FAIR_VALUE) {
    getOpenBookMidPrice(symbol, spotMarket, connection);
  }
  if (LIQUID_SYMBOLS.includes(symbol)) {
    return fairValue;
  }
  try {
    let jupPrice : number = await asyncCallWithTimeoutasync(getJupiterPrice(symbol, 'USDC', connection, owner), MAX_LOAD_TIME);
    jupPrice = jupPrice > 0 ? jupPrice : 0;
    const oracleSlippage = Math.abs(fairValue - jupPrice) / fairValue;
    if (oracleSlippage > slippageMax.get(symbol)) {
      const oracleSlippageBps = Math.round(oracleSlippage * 100 * 100);
      console.log(
        `${symbol}: Using Jupiter Mid Price ${jupPrice} Oracle Slippage: ${oracleSlippageBps}`,
      );
      return jupPrice;
    }
    return fairValue;
  } catch (err) {
    console.log(symbol, 'Jupiter Price Failed', err);
    return fairValue;
  }
}

export async function findFairValue(
  connection: Connection,
  owner: Keypair,
  spotMarket: Market,
  symbol: SYMBOL,
  tries: number,
  waitSecPerTry: number,
) {
  if (PRICE_OVERRIDE > 0) {
    return PRICE_OVERRIDE;
  }
  let fairValue = await getFairValue(connection, owner, spotMarket, symbol);
  for (let i = 0; i < tries; i++) {
    if (fairValue === NO_FAIR_VALUE) {
      console.log(symbol, 'Cannot find fair value');
      await sleepExact(waitSecPerTry);
      fairValue = await getFairValue(connection, owner, spotMarket, symbol);
    }
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
    const { swapTransaction } = await jupiter.exchange({ routeInfo: routes.routesInfos[0] });

    if (hedgeSide === 'sell') {
      if (netPrice > hedgePrice) {
        const swapQty = -searchQty / inAtomsPerToken;
        routeDetails = {
          price: netPrice, qty: swapQty, venue, swapTransaction,
        };
        lastSucess = true;
        if (i === 0) {
          break;
        }
      }
    } else if (netPrice < hedgePrice) {
      const swapQty = searchQty / inAtomsPerToken / hedgePrice;
      routeDetails = {
        price: netPrice, qty: swapQty, venue, swapTransaction,
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
  let nearStrikeType = dipProduct[0].callOrPut;
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

export function roundQtyToMinOrderStep(amount: number, minSize: number) {
  return Math.round(amount * (1 / minSize)) / (1 / minSize);
}

export async function getTreasuryPositions(
  symbol: SYMBOL,
  connection: Connection,
  dipProduct: DIPDeposit[],
  soHelper: StakingOptions,
) {
  console.log(symbol, 'Add Treasury Positions to Hedge');
  const accountList = [RM_PROD_PK, OPTION_VAULT_PK, RM_BACKUP_PK];
  for (const eligibileSO of ELIGIBLE_SO_STATES) {
    if (eligibileSO[0] === symbol) {
      let parsedState;
      let optionType: CallOrPut;
      try {
        parsedState = await soHelper.getState(eligibileSO[1], tokenToSplMint(symbol));
        optionType = CallOrPut.Call;
      } catch {
        parsedState = await soHelper.getState(eligibileSO[1], tokenToSplMint('USDC'));
        optionType = CallOrPut.Put;
      }
      // @ts-ignore
      const {
        optionExpiration, lotSize, strikes, baseMint, quoteMint, baseDecimals, quoteDecimals,
      } = parsedState;

      const splTokenName = optionType === CallOrPut.Put
      // @ts-ignore
        ? splMintToToken(quoteMint) : splMintToToken(baseMint);

      // @ts-ignore
      const baseAtoms = 10 ** baseDecimals;
      // @ts-ignore
      const quoteAtoms = 10 ** quoteDecimals;

      // @ts-ignore
      for (const strike of strikes) {
        let soMint: PublicKey;
        if (optionType === CallOrPut.Call) {
          soMint = await soHelper.soMint(
            strike.toNumber(),
            eligibileSO[1],
            tokenToSplMint(symbol),
          );
        } else {
          soMint = await soHelper.soMint(
            strike.toNumber(),
            eligibileSO[1],
            tokenToSplMint('USDC'),
          );
        }
        let netBalance = 0;
        for (const account of accountList) {
          const soAddress = await getAssociatedTokenAddress(account, soMint);
          try {
            netBalance += Number(
              (await connection.getTokenAccountBalance(soAddress)).value.amount,
            );
          } catch (err) {
          // Ignore Empty Accounts
          }
        }
        // strike is atoms of quote per lot so need to divide by quote atoms
        // and multiple by base atoms.
        const strikeUsdcPerToken = optionType === CallOrPut.Call
          ? (strike.toNumber() / Number(lotSize)) / (quoteAtoms / baseAtoms)
          : 1 / ((strike.toNumber() / Number(lotSize)) / (quoteAtoms / baseAtoms));
        const qtyTokens = optionType === CallOrPut.Call
          ? (netBalance * Number(lotSize)) / baseAtoms
          : ((netBalance * Number(lotSize)) / baseAtoms) / strikeUsdcPerToken;
        const expirationMs = Number(optionExpiration) * 1_000;
        dipProduct.push({
          splTokenName,
          premiumAssetName: 'USDC',
          expirationMs,
          strikeUsdcPerToken,
          callOrPut: optionType,
          qtyTokens,
        });
      }
    }
  }

  for (const positions of TREASURY_POSITIONS) {
    if (symbol === positions.splTokenName) {
      dipProduct.push(positions);
    }
  }
  console.log(symbol, 'Tracking Positions', dipProduct.length);
  for (const dip of dipProduct) {
    console.log(
      dip.splTokenName,
      dip.premiumAssetName,
      new Date(dip.expirationMs).toDateString(),
      dip.strikeUsdcPerToken,
      dip.callOrPut,
      dip.qtyTokens,
    );
  }
}
