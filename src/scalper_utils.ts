import * as greeks from 'greeks';
import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey,
  sendAndConfirmTransaction, Transaction,
} from '@solana/web3.js';
import { Market, Orderbook } from '@project-serum/serum';
import { getAssociatedTokenAddress } from '@project-serum/associated-token';
import { StakingOptions } from '@dual-finance/staking-options';
import { CallOrPut, DIPDeposit, HedgeSide, SYMBOL } from './common';
import {
  MAX_MKT_SPREAD_PCT_FOR_PRICING, RF_RATE, PRIORITY_FEE, GAMMA_CYCLES,
  RESOLVE_PERIOD_MS, PRICE_OVERRIDE, MAX_LOAD_TIME, LIQUID_SYMBOLS,
  ELIGIBLE_SO_STATES, TREASURY_POSITIONS, INFLATION_MAP, STAKE_RATE_MAP,
  STORAGE_RATE_MAP, SLIPPAGE_MAX, THEO_VOL,
} from './config';
import {
  asyncCallWithTimeout, decimalsBaseSPL, sleepExact, splMintToToken,
  tokenToSplMint,
} from './utils';
import {
  RM_PROD_PK, MS_PER_YEAR, NO_FAIR_VALUE, OPTION_VAULT_PK, RM_BACKUP_PK,
  SUFFICIENT_BOOK_DEPTH, NO_ORACLE_PRICE,
} from './constants';
import { getChainlinkPrice, getPythPrice, getSwitchboardPrice } from './oracle';
import { getJupiterPrice } from './jupiter';

export function calcForwardPrice(symbol: SYMBOL, currentPrice: number, yearsUntilMaturity: number) {
  // Forward = Spot * e^(Cost of Carry x Years)
  // Cost of Carry  = Real Risk-Free Rate - Real Convience Yield
  // Real Risk-Free Rate = Risk-Free Rate - Inflation Rate - $ Storage Cost
  // Real Convience Yield = Stake Rate - Token Inflation Rate - Token Storage Cost
  // Cost of Carry = Quote Real Rate - Base Real Rate
  const baseRealRate = STAKE_RATE_MAP.get(symbol) - INFLATION_MAP.get(symbol)
    - STORAGE_RATE_MAP.get(symbol);
  const quoteRealRate = STAKE_RATE_MAP.get('USDC') - INFLATION_MAP.get('USDC')
    - STORAGE_RATE_MAP.get('USDC');
  // Example: SOL Cost of Carry = 5% - 4.4% - 0% - 7% + 6.325% + 0.05% = -0.025%
  const costOfCarry = quoteRealRate - baseRealRate;
  // Example SOL = $20, 30d fwd = $19.9996
  const forwardPrice = currentPrice * Math.exp(costOfCarry * yearsUntilMaturity);
  return forwardPrice;
}

export function getDIPDelta(
  dipProduct: DIPDeposit[],
  fairValue: number,
  symbol: SYMBOL,
) {
  const impliedVol = THEO_VOL;
  let deltaSum = 0;
  for (const dip of dipProduct) {
    const yearsUntilMaturity = (dip.expirationMs - Date.now()) / MS_PER_YEAR;
    const fwdPrice = calcForwardPrice(symbol, fairValue, yearsUntilMaturity);
    deltaSum += greeks.getDelta(
      fwdPrice,
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
  const impliedVol = THEO_VOL;
  let gammaSum = 0;
  for (const dip of dipProduct) {
    const yearsUntilMaturity = (dip.expirationMs - Date.now()) / MS_PER_YEAR;
    const fwdPrice = calcForwardPrice(symbol, fairValue, yearsUntilMaturity);
    gammaSum += greeks.getGamma(
      fwdPrice,
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
  const impliedVol = THEO_VOL;
  let thetaSum = 0;
  for (const dip of dipProduct) {
    const yearsUntilMaturity = (dip.expirationMs - Date.now()) / MS_PER_YEAR;
    const fwdPrice = calcForwardPrice(symbol, fairValue, yearsUntilMaturity);
    thetaSum += greeks.getTheta(
      fwdPrice,
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

// Check if there is more than SUFFICIENT_BOOK_DEPTH and split if needed.
export function openBookLiquidityCheckAndNumSplices(
  qty: number,
  price: number,
  notionalMax: number,
  hedgeSide: HedgeSide,
  bids: Orderbook,
  asks: Orderbook,
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

// This assumes that openbook has been settled. Any position yet to be settled
// is not considered. This is just in the wallet and openbook open orders. Does
// not consider mango or anywhere else.
export async function getWalletAndOpenbookSpotDelta(
  connection: Connection,
  symbol: SYMBOL,
  owner: Keypair,
  market: Market,
) {
  let accountDelta = 0;
  let tokenDelta = 0;
  let spotDelta = 0;

  let tokenDecimals = decimalsBaseSPL(symbol);

  const accountList = [RM_PROD_PK, OPTION_VAULT_PK, RM_BACKUP_PK];
  for (const account of accountList) {
    // SOL is unique because we need to consider the sol that is not in a token
    // account.
    if (symbol === 'SOL') {
      accountDelta = (await connection.getBalance(account)) / LAMPORTS_PER_SOL;
    }
    try {
      const tokenAccount = await getAssociatedTokenAddress(
        account,
        tokenToSplMint(symbol),
      );
      const balance = await connection.getTokenAccountBalance(tokenAccount);
      const tokenBalance = Number(balance.value.amount);
      tokenDelta = tokenBalance / 10 ** tokenDecimals;
    } catch (err) {
      tokenDelta = 0;
    }
    spotDelta += accountDelta + tokenDelta;
  }

  let openOrderQty = 0;
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
    units: 200_000,
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
  if (hedgeSide === 'buy') {
    return await getAssociatedTokenAddress(
      owner.publicKey,
      tokenToSplMint(quote),
    );
  } else {
    return await getAssociatedTokenAddress(
      owner.publicKey,
      tokenToSplMint(base),
    );
  }
}

export async function cancelOpenBookOrders(
  connection: Connection,
  owner: Keypair,
  spotMarket: Market,
  symbol: SYMBOL,
): Promise<void> {
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

// Check oracles in order of preference and then use openbook midpoint if all fail.
export async function getOraclePrice(symbol: SYMBOL) {
  const chainlinkPrice = await getChainlinkPrice(new PublicKey(tokenToSplMint(symbol)));
  if (chainlinkPrice !== NO_ORACLE_PRICE) {
    console.log(`${symbol} Chainlink Price: ${chainlinkPrice}`);
    return chainlinkPrice;
  }

  const sbPrice = await getSwitchboardPrice(new PublicKey(tokenToSplMint(symbol)));
  if (sbPrice !== NO_ORACLE_PRICE) {
    console.log(`${symbol} Switchboard Price: ${sbPrice}`);
    return sbPrice;
  }

  const pythPrice = await getPythPrice(new PublicKey(tokenToSplMint(symbol)));
  if (pythPrice !== NO_ORACLE_PRICE) {
    console.log(`${symbol} Pyth Price: ${pythPrice}`);
    return pythPrice;
  }

  return NO_FAIR_VALUE;
}

async function getOpenBookMidPrice(
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

// Get fair value by searching in order of preference:
// Liquid: Oracle, OpenBook midpoint
// Illiquid: Oracle, OpenBook midpoint, Jupiter
async function getFairValue(
  connection: Connection,
  spotMarket: Market,
  symbol: SYMBOL,
) {
  let fairValue = await getOraclePrice(symbol);
  if (fairValue === NO_FAIR_VALUE) {
    fairValue = await getOpenBookMidPrice(symbol, spotMarket, connection);
  }
  if (LIQUID_SYMBOLS.includes(symbol)) {
    return fairValue;
  }

  try {
    const jupPrice: number = await asyncCallWithTimeout(getJupiterPrice(symbol, 'USDC', connection), MAX_LOAD_TIME);
    if (!jupPrice) {
      console.log(symbol, 'Jupiter Price Failed');
      return fairValue;
    }
    // Override the oracle/openbook fair value if jupiter is very different.
    const oracleSlippage = Math.abs(fairValue - jupPrice) / fairValue;
    if (oracleSlippage > SLIPPAGE_MAX.get(symbol)) {
      const oracleSlippageBps = Math.round(oracleSlippage * 100 * 100);
      console.log(
        `${symbol}: Using Jupiter Mid Price ${jupPrice} Oracle Slippage: ${oracleSlippageBps}`,
      );
      return jupPrice;
    }
  } catch (err) {
    console.log(symbol, 'Jupiter Price Failed', err);
  }

  return fairValue;
}

export async function findFairValue(
  connection: Connection,
  spotMarket: Market,
  symbol: SYMBOL,
  maxTries: number,
  waitSecPerTry: number,
) {
  if (PRICE_OVERRIDE > 0) {
    return PRICE_OVERRIDE;
  }
  let fairValue = await getFairValue(connection, spotMarket, symbol);
  for (let i = 0; i < maxTries; i++) {
    if (fairValue === NO_FAIR_VALUE) {
      console.log(symbol, 'Cannot find fair value');
      await sleepExact(waitSecPerTry);
      fairValue = await getFairValue(connection, spotMarket, symbol);
    }
  }
  return fairValue;
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
    strikeMax = Math.max(strikeMax, dip.strikeUsdcPerToken);
  }
  return strikeMax;
}

// Find the min strike of a set of DIPs/SOs
export function findMinStrike(dipProduct: DIPDeposit[]) {
  let strikeMin = dipProduct[0].strikeUsdcPerToken;
  for (const dip of dipProduct) {
    strikeMin = Math.min(strikeMin, dip.strikeUsdcPerToken);
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
  symbolToSearch: SYMBOL,
  connection: Connection,
  dipProduct: DIPDeposit[],
  soHelper: StakingOptions,
) {
  console.log(symbolToSearch, 'Add Treasury Positions to Hedge');
  const accountList = [RM_PROD_PK, OPTION_VAULT_PK, RM_BACKUP_PK];
  for (const eligibleSO of ELIGIBLE_SO_STATES) {
    if (eligibleSO.symbol === symbolToSearch) {
      let parsedState;
      let optionType: CallOrPut;
      try {
        parsedState = await soHelper.getState(eligibleSO.name, tokenToSplMint(symbolToSearch));
        optionType = CallOrPut.Call;
      } catch {
        try {
          parsedState = await soHelper.getState(eligibleSO.name, tokenToSplMint('USDC'));
          optionType = CallOrPut.Put;
        } catch {
          // Skip empty so states
          continue;
        }
      }
      const {
        optionExpiration, lotSize, strikes, baseMint, quoteMint, baseDecimals, quoteDecimals,
      } = parsedState;

      // Skip expired postions if they are left in.
      const expirationMs = Number(optionExpiration) * 1_000;
      if (expirationMs < Date.now()) {
        continue;
      }

      const splTokenName: SYMBOL = optionType === CallOrPut.Put ? splMintToToken(quoteMint) : splMintToToken(baseMint);

      const baseAtomsPerToken = 10 ** baseDecimals;
      const quoteAtomsPerToken = 10 ** quoteDecimals;

      for (const strike of strikes) {
        let soMint: PublicKey;
        if (optionType === CallOrPut.Call) {
          soMint = await soHelper.soMint(
            strike.toNumber(),
            eligibleSO.name,
            tokenToSplMint(symbolToSearch),
          );
        } else {
          soMint = await soHelper.soMint(
            strike.toNumber(),
            eligibleSO.name,
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
        // Strike is atoms of quote per lot so need to divide by quote atoms
        // and multiple by base atoms.
        const strikeUsdcPerToken = optionType === CallOrPut.Call
          ? (strike.toNumber() / Number(lotSize)) / (quoteAtomsPerToken / baseAtomsPerToken)
          : 1 / ((strike.toNumber() / Number(lotSize)) / (quoteAtomsPerToken / baseAtomsPerToken));
        const qtyTokens = optionType === CallOrPut.Call
          ? (netBalance * Number(lotSize)) / baseAtomsPerToken
          : ((netBalance * Number(lotSize)) / baseAtomsPerToken) / strikeUsdcPerToken;
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
    if (symbolToSearch === positions.splTokenName) {
      dipProduct.push(positions);
    }
  }
  console.log(`${symbolToSearch} tracking ${dipProduct.length} positions`);
  for (const dip of dipProduct) {
    const dateString = new Date(dip.expirationMs).toDateString();
    console.log(
      `${dip.splTokenName} ${dip.premiumAssetName} ${dateString} $${dip.strikeUsdcPerToken} ${dip.callOrPut} ${dip.qtyTokens}`
    );
  }
}
