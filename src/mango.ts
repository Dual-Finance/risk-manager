import WebSocket from 'ws';
import {
  MangoAccount, MangoClient,
  PerpMarket, MANGO_V4_ID, Group, PerpOrderType, PerpOrderSide,
  Serum3Side, Serum3SelfTradeBehavior, Serum3OrderType,
} from '@blockworks-foundation/mango-v4';
import {
  PublicKey, TransactionInstruction,
} from '@solana/web3.js';
import { Market } from '@project-serum/serum';
import {
  maxNotional, TWAP_INTERVAL_SEC, SCALPER_WINDOW_SEC,
  FILLS_URL, IS_DEV, GAMMA_THRESHOLD,
  MAX_DELTA_HEDGES, MANGO_DOWNTIME_THRESHOLD_MIN,
  PERP_FUNDING_RATE_THRESHOLD, GAMMA_CYCLES, OPENBOOK_FORK_ID,
  slippageMax, GAMMA_COMPLETE_THRESHOLD_PCT, CLUSTER,
  HedgeProduct, HedgeSide, ScalperMode, PRIORITY_FEE,
} from './config';
import { DIPDeposit } from './common';
import {
  sleepExact, tokenToSplMint,
} from './utils';
import {
  getDIPDelta, getDIPGamma, getWalletAndOpenbookSpotDelta, waitForFill,
  roundPriceToTickSize, roundQtyToMinOrderStep, getOraclePrice,
} from './scalper_utils';
import {
  connectMangoFillListener, getMangoHedgeProduct, orderSpliceMango, setupMangoFillListener,
} from './mango_utils';
import {
  HOURS_PER_YEAR,
  MANGO_DEVNET_GROUP, MANGO_MAINNET_GROUP, NO_FAIR_VALUE, OPENBOOK_MKT_MAP, SEC_PER_YEAR,
} from './constants';
// eslint-disable-next-line import/no-cycle
import Scalper from './scalper';

export async function cancelStaleMangoOrders(
  scalper: Scalper,
  mangoClient: MangoClient,
  mangoAccount: MangoAccount,
  mangoGroup: Group,
  perpMarket: PerpMarket,
): Promise<void> {
  const openOrders = await mangoAccount.loadPerpOpenOrdersForMarket(
    mangoClient,
    mangoGroup,
    perpMarket.perpMarketIndex,
    true,
  );
  if (openOrders.length === 0) {
    return;
  }
  let foundPerpMarket = false;
  for (const order of openOrders) {
    if (order.perpMarketIndex === perpMarket.perpMarketIndex) {
      foundPerpMarket = true;
    }
  }
  if (foundPerpMarket) {
    console.log(scalper.symbol, 'Canceling All Orders');
    try {
      await mangoClient.perpCancelAllOrders(
        mangoGroup,
        mangoAccount,
        perpMarket.perpMarketIndex,
        10, /* Max number of order cancelations */
      );
    } catch (err) {
      console.log('Failed to cancel all perp orders');
      console.log(err);
    }
  }
}

export async function deltaHedgeMango(
  dipProduct: DIPDeposit[],
  scalper: Scalper,
  mangoClient: MangoClient,
  mangoAccount: MangoAccount,
  mangoGroup: Group,
  perpMarket: PerpMarket,
  spotMarket: Market,
  fillFeed: WebSocket,
  deltaHedgeCount: number,
): Promise<void> {
  await mangoAccount.reload(mangoClient);
  await mangoGroup.reloadAll(mangoClient);
  // Cleanup from previous runs.
  await cancelStaleMangoOrders(scalper, mangoClient, mangoAccount, mangoGroup, perpMarket);

  // Avoid unsafe recursion.
  if (deltaHedgeCount > MAX_DELTA_HEDGES) {
    console.log(scalper.symbol, 'Max Hedges exceeded without getting to neutral');
    return;
  }

  // Calc DIP delta for new position
  const fairValue = await getOraclePrice(scalper.symbol);
  if (fairValue === NO_FAIR_VALUE) {
    console.log(this.symbol, 'No Robust Pricing. Exiting Delta Hedge');
    return;
  }
  const dipTotalDelta = getDIPDelta(dipProduct, fairValue, scalper.symbol);

  // Get Mango delta position
  const mangoPerpDelta = mangoAccount.getPerpPositionUi(mangoGroup, perpMarket.perpMarketIndex);
  let mangoSpotDelta = 0;
  try {
    mangoSpotDelta = mangoAccount.getTokenBalanceUi(
      mangoGroup.getFirstBankByMint(tokenToSplMint(scalper.symbol)),
    );
  } catch (err) {
    console.log(scalper.symbol, 'No Mango Token Balance Possible');
  }

  const spotDelta = await getWalletAndOpenbookSpotDelta(
    scalper.connection,
    scalper.symbol,
    scalper.owner,
    spotMarket,
  );

  // Get Total Delta Position to hedge
  let hedgeDeltaTotal = mangoPerpDelta + dipTotalDelta + spotDelta
   + mangoSpotDelta + scalper.deltaOffset;

  // Check whether we need to hedge.
  const dipTotalGamma = getDIPGamma(dipProduct, fairValue, scalper.symbol);
  const stdDevSpread = (scalper.impliedVol / Math.sqrt(SEC_PER_YEAR
    / SCALPER_WINDOW_SEC)) * scalper.zScore;
  const deltaThreshold = Math.max(
    dipTotalGamma * stdDevSpread * fairValue * GAMMA_THRESHOLD,
    scalper.minSize,
  );
  if (Math.abs(hedgeDeltaTotal) < deltaThreshold) {
    console.log(scalper.symbol, 'Delta Netural', hedgeDeltaTotal, '<', deltaThreshold);
    return;
  }

  // Check what the delta is including slipapge. Avoids over trading
  const slippageTolerance = Math.min(stdDevSpread / 2, slippageMax.get(scalper.symbol));
  const IS_BUYSIDE = hedgeDeltaTotal < 0;
  let hedgePrice = IS_BUYSIDE
    ? fairValue * (1 + slippageTolerance)
    : fairValue * (1 - slippageTolerance);
  const slippageDIPDelta = getDIPDelta(dipProduct, hedgePrice, scalper.symbol);
  const dipDeltaDiff = slippageDIPDelta - dipTotalDelta;
  hedgeDeltaTotal += dipDeltaDiff;
  const hedgeSide = IS_BUYSIDE ? HedgeSide.buy : HedgeSide.sell;

  if (Math.abs(hedgeDeltaTotal) < deltaThreshold) {
    console.log(scalper.symbol, 'Adjust Delta By', dipDeltaDiff, 'Within threshold:', Math.abs(hedgeDeltaTotal), 'vs.', deltaThreshold);
    return;
  }
  console.log(scalper.symbol, 'Adjust Delta By', dipDeltaDiff, 'Outside threshold:', Math.abs(hedgeDeltaTotal), 'vs.', deltaThreshold);

  // Determine spot or perp order based on funding rate.
  const bidSide = await perpMarket.loadBids(mangoClient);
  const askSide = await perpMarket.loadAsks(mangoClient);

  // perpMarket.getCurrentFundingRate(bidSide, askSide) is the instantaneous
  // funding rate, instead, we want the last hour average.
  const fundingRateUrl = `https://api.mngo.cloud/data/v4/one-hour-funding-rate?mango-group=${MANGO_MAINNET_GROUP}`;
  const fundingRatesJson = await (await fetch(fundingRateUrl)).json();
  // Response looks like this
  // [{"mango_group":"78b8f4cGCwmZ9ysPFMWLaLTkkaYnUjwMJYStWe5RTSSX","market_index":0,"name":"BTC-PERP","start_of_period":"2023-06-08T20:46:35.000Z","end_of_period":"2023-06-08T21:46:35.000Z","earliest_block_datetime":"2023-06-08T20:46:35.000Z","latest_block_datetime":"2023-06-08T21:46:00.000Z","funding_rate_hourly":6.883314925418046e-05},{"mango_group":"78b8f4cGCwmZ9ysPFMWLaLTkkaYnUjwMJYStWe5RTSSX","market_index":1,"name":"MNGO-PERP","start_of_period":"2023-06-08T20:46:35.000Z","end_of_period":"2023-06-08T21:46:35.000Z","earliest_block_datetime":"2023-04-25T05:45:56.000Z","latest_block_datetime":"2023-04-25T05:45:56.000Z","funding_rate_hourly":0},{"mango_group":"78b8f4cGCwmZ9ysPFMWLaLTkkaYnUjwMJYStWe5RTSSX","market_index":2,"name":"SOL-PERP","start_of_period":"2023-06-08T20:46:35.000Z","end_of_period":"2023-06-08T21:46:35.000Z","earliest_block_datetime":"2023-06-08T20:46:35.000Z","latest_block_datetime":"2023-06-08T21:46:00.000Z","funding_rate_hourly":7.405662253039057e-05},{"mango_group":"78b8f4cGCwmZ9ysPFMWLaLTkkaYnUjwMJYStWe5RTSSX","market_index":3,"name":"ETH-PERP","start_of_period":"2023-06-08T20:46:35.000Z","end_of_period":"2023-06-08T21:46:35.000Z","earliest_block_datetime":"2023-06-08T20:46:33.000Z","latest_block_datetime":"2023-06-08T21:46:00.000Z","funding_rate_hourly":1.7017825133088e-05}]
  const currentFundingRate = HOURS_PER_YEAR * perpMarket.getCurrentFundingRate(bidSide, askSide);
  let fundingRate = currentFundingRate;
  for (const rate of fundingRatesJson) {
    if (rate.name == `${scalper.symbol}-PERP`) {
      fundingRate = Number(rate.funding_rate_hourly);
    }
  }
  
  const buySpot = fundingRate > PERP_FUNDING_RATE_THRESHOLD;
  const sellSpot = -fundingRate < PERP_FUNDING_RATE_THRESHOLD;
  let hedgeProduct = getMangoHedgeProduct(hedgeSide, buySpot, sellSpot);
  // Do not allow Mango balance to go negative
  if (mangoSpotDelta <= hedgeDeltaTotal) {
    hedgeProduct = HedgeProduct.Perp;
  }

  console.log(
    `${scalper.symbol} Target Delta Hedge: ${hedgeSide} ${hedgeProduct} ${-hedgeDeltaTotal} \
      DIP Δ: ${dipTotalDelta} Mango Perp Δ: ${mangoPerpDelta} Mango Spot Δ: ${mangoSpotDelta} \
      Spot Δ: ${spotDelta} Offset Δ ${scalper.deltaOffset} Fair Value: ${fairValue}`,
  );

  // Determine what price to use for hedging depending on allowable slippage.
  hedgePrice = roundPriceToTickSize(IS_BUYSIDE
    ? fairValue * (1 + slippageTolerance) : fairValue * (1 - slippageTolerance), scalper.tickSize);

  // Break up order depending on whether the book can support it
  const bookSide = IS_BUYSIDE ? askSide : bidSide;
  const hedgeDeltaClip = roundQtyToMinOrderStep(hedgeDeltaTotal
      / orderSpliceMango(
        hedgeDeltaTotal,
        fairValue,
        maxNotional.get(scalper.symbol),
        slippageTolerance,
        bookSide,
        perpMarket,
      ), scalper.minSize);

  const deltaOrderId = new Date().getTime() * 2;

  // Start listening for Delta Hedge Fills
  const deltaFillListener = (event: WebSocket.MessageEvent) => {
    const parsedEvent = JSON.parse(event.data as string);
    const {
      takerClientOrderId, makerClientOrderId, quantity, price,
    } = parsedEvent.event;
    if (takerClientOrderId === deltaOrderId || makerClientOrderId === deltaOrderId) {
      let fillQty = (hedgeSide === HedgeSide.buy ? 1 : -1) * quantity;
      if (parsedEvent.status == "revoke") {
        fillQty *= -1;
      }
      hedgeDeltaTotal += fillQty;
      console.log(`${scalper.symbol} Delta Filled ${hedgeSide} ${hedgeProduct} Qty ${fillQty} \
          Price ${price} Remaining ${hedgeDeltaTotal} ID ${deltaOrderId} ${new Date().toUTCString()}`);
    }
  };

  // Setup a listener for the delta hedges
  setupMangoFillListener(fillFeed, deltaFillListener, perpMarket);

  console.log(`${scalper.symbol} ${hedgeSide} ${hedgeProduct} ${Math.abs(hedgeDeltaClip)} \
    Limit: ${hedgePrice} # ${deltaHedgeCount} ID ${deltaOrderId}`);

  try {
    if (hedgeProduct === HedgeProduct.Spot) {
      const spotHedgeSide = hedgeSide === HedgeSide.buy ? Serum3Side.bid : Serum3Side.ask;
      await mangoClient.serum3PlaceOrder(
        mangoGroup,
        mangoAccount,
        new PublicKey(OPENBOOK_MKT_MAP.get(scalper.symbol)),
        spotHedgeSide,
        hedgePrice,
        Math.abs(hedgeDeltaClip),
        Serum3SelfTradeBehavior.decrementTake,
        Serum3OrderType.limit,
        deltaOrderId,
        10,
      );
    } else {
      const perpHedgeSide = hedgeSide === HedgeSide.buy ? PerpOrderSide.bid : PerpOrderSide.ask;
      await mangoClient.perpPlaceOrder(
        mangoGroup,
        mangoAccount,
        perpMarket.perpMarketIndex,
        perpHedgeSide,
        hedgePrice,
        Math.abs(hedgeDeltaClip),
        undefined,
        deltaOrderId,
        PerpOrderType.limit,
      );
    }
  } catch (err) {
    console.log(scalper.symbol, 'Failed to place order', err, err.stack);
  }

  // Wait the twapInterval of time to see if the position gets to neutral.
  console.log(scalper.symbol, 'Scan Delta Fills for ~', TWAP_INTERVAL_SEC, 'seconds');
  await waitForFill(
    (_) => Math.abs(hedgeDeltaTotal) < deltaThreshold,
    TWAP_INTERVAL_SEC,
  );

  // Cleanup listener.
  fillFeed.removeEventListener('message', deltaFillListener);

  if (Math.abs(hedgeDeltaTotal) < deltaThreshold) {
    fillFeed.removeEventListener('message', deltaFillListener);
    console.log(scalper.symbol, 'Delta Hedge Complete', hedgeDeltaTotal, '<', deltaThreshold);
    return;
  }

  // Recursive call, happens when we are not getting fills to get to neutral.
  await deltaHedgeMango(
    dipProduct,
    scalper,
    mangoClient,
    mangoAccount,
    mangoGroup,
    perpMarket,
    spotMarket,
    fillFeed,
    deltaHedgeCount + 1,
  );
}

export async function gammaScalpMango(
  dipProduct: DIPDeposit[],
  scalper: Scalper,
  mangoClient: MangoClient,
  mangoAccount: MangoAccount,
  mangoGroup: Group,
  perpMarket: PerpMarket,
  fillFeed: WebSocket,
  gammaScalpCount: number,
  priorFillPrice: number,
): Promise<void> {
  // Resets Mango State. Makes the recursive gamma scalps safer.
  // Rerun will clear any stale orders, thus allows 2 orders per scalp
  await mangoAccount.reload(mangoClient);
  await mangoGroup.reloadAll(mangoClient);
  await cancelStaleMangoOrders(scalper, mangoClient, mangoAccount, mangoGroup, perpMarket);

  // Avoid unsafe recursion.
  if (gammaScalpCount > GAMMA_CYCLES) {
    console.log(scalper.symbol, 'Maximum scalps acheived!', gammaScalpCount - 1, 'Wait for Rerun');
    return;
  }
  // Oracle rather than perpUI price used since doesn't depend on last trade price
  let fairValue: number;
  if (priorFillPrice > NO_FAIR_VALUE) {
    fairValue = priorFillPrice;
    console.log(scalper.symbol, 'Fair Value Set to Prior Fill', fairValue);
  } else {
    fairValue = await getOraclePrice(scalper.symbol);
    if (fairValue === NO_FAIR_VALUE) {
      console.log(this.symbol, 'No Robust Pricing. Exiting Gamma Scalp', gammaScalpCount);
      return;
    }
  }

  const dipTotalGamma = getDIPGamma(dipProduct, fairValue, scalper.symbol);

  // TODO: Allow scalper modes for back bids & strike adjustments
  // Calc scalperWindow std deviation spread from zScore & IV for gamma levels
  const stdDevSpread = (scalper.impliedVol
    / Math.sqrt(SEC_PER_YEAR / SCALPER_WINDOW_SEC))
    * scalper.zScore;
  const netGamma = IS_DEV
    ? Math.max(0.01, dipTotalGamma * stdDevSpread * fairValue)
    : dipTotalGamma * stdDevSpread * fairValue;

  const gammaOrderQty = roundQtyToMinOrderStep(netGamma, scalper.minSize);
  if (gammaOrderQty < scalper.minSize) {
    console.log(scalper.symbol, 'Gamma Hedge Too Small', gammaOrderQty, 'vs', scalper.minSize);
    return;
  }
  console.log(scalper.symbol, 'Position Gamma Γ:', gammaOrderQty, 'Fair Value', fairValue, 'Scalp #', gammaScalpCount);

  const orderIdGamma = new Date().getTime() * 2;
  const gammaBid = roundPriceToTickSize(fairValue * (1 - stdDevSpread), scalper.tickSize);
  const gammaBidID = orderIdGamma + 1;
  const gammaAsk = roundPriceToTickSize(fairValue * (1 + stdDevSpread), scalper.tickSize);
  const gammaAskID = orderIdGamma + 2;

  let gammaFillQty = 0;
  fillFeed.removeAllListeners('message');
  const gammaFillListener = (event: WebSocket.MessageEvent) => {
    const parsedEvent = JSON.parse(event.data as string);
    const {
      maker, makerClientOrderId, quantity, price,
    } = parsedEvent.event;
    if (maker !== mangoAccount.publicKey.toBase58()) {
      return;
    }
    if (makerClientOrderId === gammaBidID || makerClientOrderId === gammaAskID) {
      if (parsedEvent.status == "revoke") {
        gammaFillQty -= Math.abs(quantity);
      } else {
        gammaFillQty += Math.abs(quantity);
      }
      // Once the gamma fills have crossed the threshold, reset the orders.
      if (gammaFillQty > gammaOrderQty * GAMMA_COMPLETE_THRESHOLD_PCT) {
        console.log(
          scalper.symbol,
          'Gamma Filled',
          gammaFillQty,
          makerClientOrderId === gammaBidID ? 'Sold At' : 'Bought For',
          price,
          new Date().toUTCString(),
        );
        fillFeed.removeEventListener('message', gammaFillListener);
        // Do not need to remove the unfilled order since it will be cancelled in
        // the recursive call.
        gammaScalpMango(
          dipProduct,
          scalper,
          mangoClient,
          mangoAccount,
          mangoGroup,
          perpMarket,
          fillFeed,
          gammaScalpCount + 1,
          price,
        );
      } else {
        console.log('Gamma Partially Filled', gammaFillQty, 'of', gammaOrderQty);
      }
    }
  };
  // Setup a listener for the gamma hedges
  setupMangoFillListener(fillFeed, gammaFillListener, perpMarket);

  // Place gamma scalp bid & offer.
  try {
    const gammaBidTx = await mangoClient.perpPlaceOrderIx(
      mangoGroup,
      mangoAccount,
      perpMarket.perpMarketIndex,
      PerpOrderSide.bid,
      gammaBid,
      gammaOrderQty,
      undefined,
      gammaBidID,
      PerpOrderType.postOnlySlide,
    );
    const gammaAskTx = await mangoClient.perpPlaceOrderIx(
      mangoGroup,
      mangoAccount,
      perpMarket.perpMarketIndex,
      PerpOrderSide.ask,
      gammaAsk,
      gammaOrderQty,
      undefined,
      gammaBidID,
      PerpOrderType.postOnlySlide,
    );
    const gammaOrdersTx: TransactionInstruction[] = [gammaBidTx, gammaAskTx];
    console.log(scalper.symbol, 'Gamma Bid', gammaBid, 'ID', gammaBidID);
    console.log(scalper.symbol, 'Gamma Ask', gammaAsk, 'ID', gammaAskID);
    await mangoClient.sendAndConfirmTransaction(gammaOrdersTx);
  } catch (err) {
    // TOOO: Handle Error by exponential backoff / allow single order placement
    console.log(scalper.symbol, 'Gamma Error', err, err.stack);
  }
  console.log(`${scalper.symbol} Gamma Spread % ${((gammaAsk - gammaBid) / fairValue) * 100} Liquidity $ ${gammaOrderQty * 2 * fairValue}`);

  // Sleep for the max time of the reruns then kill thread
  await sleepExact(SCALPER_WINDOW_SEC);
  console.log(scalper.symbol, 'Remove stale gamma fill listener', gammaBidID, gammaAskID);
  fillFeed.removeEventListener('message', gammaFillListener);
}

export async function loadMangoAndPickScalper(dipProduct: DIPDeposit[], scalper: Scalper) {
  const mangoClient = MangoClient.connect(
    scalper.provider,
    CLUSTER,
    MANGO_V4_ID[CLUSTER],
    {
      idsSource: 'get-program-accounts',
      prioritizationFee: PRIORITY_FEE,
    },
  );
  const mangoGroup = await mangoClient.getGroup(IS_DEV ? MANGO_DEVNET_GROUP : MANGO_MAINNET_GROUP);
  const mangoAccount = await mangoClient.getMangoAccountForOwner(
    mangoGroup,
    scalper.owner.publicKey,
    0, /* First Mango account created */
  );
  await mangoAccount.reload(mangoClient);
  await mangoGroup.reloadAll(mangoClient);
  let perpMarket: PerpMarket;
  try {
    perpMarket = mangoGroup.getPerpMarketByName(`${scalper.symbol}-PERP`);
  } catch (err) {
    console.log('No Mango Market Exists. Run OpenBook');
    await scalper.scalperOpenBook(dipProduct);
    return;
  }

  // Check if Mango Perp is live
  const lastUpdateMango = perpMarket.fundingLastUpdated.toNumber() * 1_000;
  if ((Date.now() - lastUpdateMango)
        / (1_000 * 60) > MANGO_DOWNTIME_THRESHOLD_MIN) {
    console.log(scalper.symbol, 'Mango Down! Last Updated:', new Date(lastUpdateMango));
    await scalper.scalperOpenBook(dipProduct);
  } else {
    console.log(scalper.symbol, 'Hedging on Mango');

    let spotMarket: Market;
    if (OPENBOOK_MKT_MAP.get(scalper.symbol) !== undefined) {
      spotMarket = await Market.load(
        scalper.connection,
        new PublicKey(OPENBOOK_MKT_MAP.get(scalper.symbol)),
        undefined,
        OPENBOOK_FORK_ID,
      );
    }

    // Open Mango Websocket
    const fillFeed = new WebSocket(FILLS_URL);
    connectMangoFillListener(fillFeed, perpMarket);
    if (scalper.mode === ScalperMode.Perp) {
      try {
        await deltaHedgeMango(
          dipProduct,
          scalper,
          mangoClient,
          mangoAccount,
          mangoGroup,
          perpMarket,
          spotMarket,
          fillFeed,
          1,
        );
      } catch (err) {
        console.log(scalper.symbol, 'Delta Level Error Catch', err, err.stack);
      }
    }
    try {
      await gammaScalpMango(
        dipProduct,
        scalper,
        mangoClient,
        mangoAccount,
        mangoGroup,
        perpMarket,
        fillFeed,
        1,
        NO_FAIR_VALUE,
      );
    } catch (err) {
      console.log(scalper.symbol, 'Gamma Level Error Catch', err, err.stack);
    }
  }
}
