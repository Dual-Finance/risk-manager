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
  HedgeProduct,
} from './config';
import { DIPDeposit } from './common';
import {
  sleepExact, tokenToSplMint,
} from './utils';
import {
  getDIPDelta, getDIPGamma,
  getSpotDelta, orderSpliceMango, waitForFill, getMangoHedgeProduct,
  roundPriceToTickSize, roundQtyToSpotSize,
} from './scalper_utils';
import {
  MANGO_DEVNET_GROUP, MANGO_MAINNET_GROUP, OPENBOOK_MKT_MAP, SEC_PER_YEAR,
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
  await mangoAccount.reload(mangoClient);
  const openOrders = await mangoAccount.loadPerpOpenOrdersForMarket(
    mangoClient,
    mangoGroup,
    perpMarket.perpMarketIndex,
  );
  if (openOrders.length === 0) {
    return;
  }
  for (const order of openOrders) {
    if (order.perpMarketIndex === perpMarket.perpMarketIndex) {
      console.log(scalper.symbol, 'Canceling All Orders');
      await mangoClient.perpCancelAllOrders(
        mangoGroup,
        mangoAccount,
        perpMarket.perpMarketIndex,
        10,
      );
      break;
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
  await mangoGroup.reloadAll(mangoClient);
  // Cleanup from previous runs.
  await cancelStaleMangoOrders(scalper, mangoClient, mangoAccount, mangoGroup, perpMarket);

  // Avoid unsafe recursion.
  if (deltaHedgeCount > MAX_DELTA_HEDGES) {
    console.log(scalper.symbol, 'Max Hedges exceeded without getting to neutral');
    return;
  }

  // Calc DIP delta for new position
  const fairValue = perpMarket.uiPrice;
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

  // Get all spot positions Option Vault, Risk Manager, Mango Tester
  const spotDelta = await getSpotDelta(
    scalper.connection,
    scalper.symbol,
    scalper.owner,
    spotMarket,
  );

  // Get Total Delta Position to hedge
  let hedgeDeltaTotal = IS_DEV
    ? 0.1
    : mangoPerpDelta + dipTotalDelta + spotDelta + mangoSpotDelta + scalper.deltaOffset;

  // Check whether we need to hedge.
  const dipTotalGamma = getDIPGamma(dipProduct, fairValue, scalper.symbol);
  const stdDevSpread = (scalper.impliedVol / Math.sqrt(SEC_PER_YEAR
    / SCALPER_WINDOW_SEC)) * scalper.zScore;
  const deltaThreshold = Math.max(
    dipTotalGamma * stdDevSpread * fairValue * GAMMA_THRESHOLD,
    scalper.minSize,
  );
  if (Math.abs(hedgeDeltaTotal) < (deltaThreshold)) {
    console.log(scalper.symbol, 'Delta Netural', hedgeDeltaTotal, '<', deltaThreshold);
    return;
  }

  // TODO: Add slippage delta adjustment
  const slippageTolerance = Math.min(stdDevSpread / 2, slippageMax.get(scalper.symbol));
  let hedgePrice = hedgeDeltaTotal < 0
    ? fairValue * (1 + slippageTolerance)
    : fairValue * (1 - slippageTolerance);
  const slippageDIPDelta = getDIPDelta(dipProduct, hedgePrice, scalper.symbol);
  const dipDeltaDiff = slippageDIPDelta - dipTotalDelta;
  hedgeDeltaTotal += dipDeltaDiff;
  console.log(scalper.symbol, 'Adjust Slippage Delta by', dipDeltaDiff, 'to', -hedgeDeltaTotal);
  const hedgeSide = hedgeDeltaTotal < 0 ? PerpOrderSide.bid : PerpOrderSide.ask;
  const hedgeSideText = hedgeSide === PerpOrderSide.bid ? 'Buy' : 'Sell';

  const notionalThreshold = deltaThreshold * fairValue;
  const notionalAmount = -hedgeDeltaTotal * fairValue;
  if ((notionalAmount < notionalThreshold && hedgeSideText === 'Buy')
       || (notionalAmount > notionalThreshold && hedgeSideText === 'Sell')) {
    console.log(scalper.symbol, 'Delta Netural: Slippage', deltaThreshold);
    return;
  }
  console.log(scalper.symbol, 'Outside delta threshold:', Math.abs(hedgeDeltaTotal), 'vs.', deltaThreshold);

  // Determine spot or perp order based on funding rate.
  const bidSide = await perpMarket.loadBids(mangoClient);
  const askSide = await perpMarket.loadAsks(mangoClient);
  const fundingRate = (24 * 365)
    * perpMarket.getCurrentFundingRate(bidSide, askSide);
  const buySpot = fundingRate > PERP_FUNDING_RATE_THRESHOLD;
  const sellSpot = -fundingRate < PERP_FUNDING_RATE_THRESHOLD;
  let hedgeProduct = getMangoHedgeProduct(hedgeSide, buySpot, sellSpot);
  // No OpenBook BTC market exists still
  if (scalper.symbol === 'BTC') {
    hedgeProduct = HedgeProduct.Perp;
  }

  console.log(
    `${scalper.symbol} Target Delta Hedge: ${hedgeSideText} ${hedgeProduct} ${-hedgeDeltaTotal} \
      DIP Δ: ${dipTotalDelta} Mango Perp Δ: ${mangoPerpDelta} Mango Spot Δ: ${mangoSpotDelta} \
      Spot Δ: ${spotDelta} Offset Δ ${scalper.deltaOffset} Fair Value: ${fairValue}`,
  );

  // Determine what price to use for hedging depending on allowable slippage.
  hedgePrice = roundPriceToTickSize(hedgeDeltaTotal < 0
    ? fairValue * (1 + slippageTolerance) : fairValue * (1 - slippageTolerance), scalper.tickSize);

  // Break up order depending on whether the book can support it
  const bookSide = hedgeDeltaTotal < 0 ? askSide : bidSide;
  const hedgeDeltaClip = roundQtyToSpotSize(hedgeDeltaTotal
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
  const deltaFillListener = async (event: WebSocket.MessageEvent) => {
    const parsedEvent = JSON.parse(event.data as string);
    const {
      owner, clientOrderId, quantity, price,
    } = parsedEvent.event;
    if (owner === mangoAccount.publicKey.toBase58() && clientOrderId === deltaOrderId) {
      const fillQty = (hedgeSide === PerpOrderSide.bid ? 1 : -1) * quantity;
      hedgeDeltaTotal += fillQty;
      console.log(`${scalper.symbol} Delta Filled ${hedgeSideText} ${hedgeProduct} Qty ${fillQty} \
          Price ${price} Remaining ${hedgeDeltaTotal} ID ${deltaOrderId} ${new Date().toUTCString()}`);
    }
  };

  // Setup a listener for the order.
  if (fillFeed.readyState === WebSocket.OPEN) {
    fillFeed.addEventListener('message', deltaFillListener);
    console.log(scalper.symbol, 'Listening For Delta Hedges');
  } else {
    console.log(scalper.symbol, 'Websocket State', fillFeed.readyState);
  }

  console.log(`${scalper.symbol} ${hedgeSideText} ${hedgeProduct} ${Math.abs(hedgeDeltaClip)} \
    Limit: ${hedgePrice} # ${deltaHedgeCount} ID ${deltaOrderId}`);

  try {
    // TODO: Test Spot
    if (hedgeProduct === HedgeProduct.Spot) {
      const spotHedgeSide = hedgeSide === PerpOrderSide.bid ? Serum3Side.bid : Serum3Side.ask;
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
      await mangoClient.perpPlaceOrder(
        mangoGroup,
        mangoAccount,
        perpMarket.perpMarketIndex,
        hedgeSide,
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
    (_) => Math.abs(hedgeDeltaTotal) < (deltaThreshold),
    TWAP_INTERVAL_SEC,
  );

  // Cleanup listener.
  fillFeed.removeEventListener('message', deltaFillListener);

  if (Math.abs(hedgeDeltaTotal) < (deltaThreshold)) {
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
): Promise<void> {
  await mangoGroup.reloadAll(mangoClient);
  // Makes the recursive gamma scalps safer. Rerun will clear any stale
  // orders. Allows only 2 gamma orders at any time
  await cancelStaleMangoOrders(scalper, mangoClient, mangoAccount, mangoGroup, perpMarket);

  // Avoid unsafe recursion.
  if (gammaScalpCount > GAMMA_CYCLES) {
    console.log(scalper.symbol, 'Maximum scalps acheived!', gammaScalpCount - 1, 'Wait for Rerun');
    return;
  }

  const fairValue = perpMarket.uiPrice;
  const dipTotalGamma = getDIPGamma(dipProduct, fairValue, scalper.symbol);

  // TODO: Allow scalper modes for back bids & strike adjustments
  // Calc scalperWindow std deviation spread from zScore & IV for gamma levels
  const stdDevSpread = (scalper.impliedVol
    / Math.sqrt(SEC_PER_YEAR / SCALPER_WINDOW_SEC))
    * scalper.zScore;
  const netGamma = IS_DEV
    ? Math.max(0.01, dipTotalGamma * stdDevSpread * fairValue)
    : dipTotalGamma * stdDevSpread * fairValue;

  console.log(scalper.symbol, 'Position Gamma Γ:', netGamma, 'Fair Value', fairValue);
  if ((netGamma * fairValue) < (scalper.minSize * fairValue)) {
    console.log(scalper.symbol, 'Gamma Hedge Too Small');
    return;
  }

  const orderIdGamma = new Date().getTime() * 2;
  const gammaBid = fairValue * (1 - stdDevSpread);
  const gammaBidID = orderIdGamma + 1;
  const gammaAsk = fairValue * (1 + stdDevSpread);
  const gammaAskID = orderIdGamma + 2;

  let gammaFillQty = 0;
  // TODO: Check fills feed works here
  fillFeed.removeAllListeners('message');
  const gammaFillListener = (event) => {
    const parsedEvent = JSON.parse(event.data);
    const {
      owner, clientOrderId, quantity, price,
    } = parsedEvent.event;
    if (owner !== mangoAccount.publicKey.toBase58()) {
      return;
    }
    if (clientOrderId === gammaBidID || clientOrderId === gammaAskID) {
      gammaFillQty += Math.abs(quantity);
      // Once the gamma fills have crossed the threshold, reset the orders.
      if (gammaFillQty > netGamma * GAMMA_COMPLETE_THRESHOLD_PCT) {
        console.log(
          scalper.symbol,
          'Gamma Filled',
          gammaFillQty,
          clientOrderId === gammaBidID ? 'BOUGHT FOR' : 'SOLD AT',
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
        );
      } else {
        console.log('Gamma Partially Filled', gammaFillQty, 'of', netGamma);
      }
    }
  };

  if (fillFeed.readyState === WebSocket.OPEN) {
    fillFeed.addEventListener('message', gammaFillListener);
    console.log(scalper.symbol, 'Listening For gamma scalps');
  } else {
    console.log(scalper.symbol, 'Websocket State', fillFeed.readyState);
  }

  // Place gamma scalp bid & offer.
  try {
    const gammaBidTx = await mangoClient.perpPlaceOrderIx(
      mangoGroup,
      mangoAccount,
      perpMarket.perpMarketIndex,
      PerpOrderSide.bid,
      gammaBid,
      netGamma,
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
      netGamma,
      undefined,
      gammaBidID,
      PerpOrderType.postOnlySlide,
    );
    const gammaOrdersTx: TransactionInstruction[] = [gammaBidTx, gammaAskTx];
    console.log(scalper.symbol, 'Gamma Bid', gammaBid, 'ID', gammaBidID);
    console.log(scalper.symbol, 'Gamma Ask', gammaAsk, 'ID', gammaAskID);
    await mangoClient.sendAndConfirmTransaction(gammaOrdersTx);
  } catch (err) {
    console.log(scalper.symbol, 'Gamma Error', err, err.stack);
  }
  console.log(`${scalper.symbol} Gamma Spread % ${((gammaAsk - gammaBid) / fairValue) * 100} Liquidity $ ${netGamma * 2 * fairValue}`);

  // Sleep for the max time of the reruns then kill thread
  await sleepExact(SCALPER_WINDOW_SEC);
  console.log(scalper.symbol, 'Remove stale gamma fill listener', gammaBidID, gammaAskID);
  fillFeed.removeEventListener('message', gammaFillListener);
}

export async function runMangoScalper(dipProduct: DIPDeposit[], scalper: Scalper) {
  // Load Mango
  // TODO: Add Priority Fee
  const mangoClient = MangoClient.connect(
    scalper.provider,
    CLUSTER,
    MANGO_V4_ID[CLUSTER],
    {
      idsSource: 'get-program-accounts',
    },
  );
  const mangoGroup = await mangoClient.getGroup(IS_DEV ? MANGO_DEVNET_GROUP : MANGO_MAINNET_GROUP);
  const mangoAccount = await mangoClient.getMangoAccountForOwner(
    mangoGroup,
    scalper.owner.publicKey,
    0,
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
  const lastUpdateMango = perpMarket.fundingLastUpdated.toNumber() * 1000;
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
    const subscriptionData = {
      command: 'subscribe',
      marketId: perpMarket.publicKey.toBase58(),
    };
    fillFeed.onopen = (_) => {
      fillFeed.send(JSON.stringify(subscriptionData));
      console.log('Connected to Mango Websocket', subscriptionData.marketId, new Date().toUTCString());
    };
    fillFeed.onerror = (error) => {
      console.log(`Websocket Error ${error.message}`);
    };

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
      await gammaScalpMango(
        dipProduct,
        scalper,
        mangoClient,
        mangoAccount,
        mangoGroup,
        perpMarket,
        fillFeed,
        1,
      );
    } catch (err) {
      console.log(scalper.symbol, 'Main Error', err, err.stack);
    }
  }
}
