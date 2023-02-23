import WebSocket from 'ws';
import {
  MangoAccount, MangoClient,
  PerpMarket, FillEvent, MANGO_V4_ID, Group, PerpOrderType, PerpOrderSide,
  Serum3Side, Serum3SelfTradeBehavior, Serum3OrderType,
} from '@blockworks-foundation/mango-v4';
import {
  Keypair, Commitment, Connection, PublicKey, Account, Transaction,
  sendAndConfirmTransaction, TransactionInstruction,
} from '@solana/web3.js';
import { Market } from '@project-serum/serum';
import { AnchorProvider, BN, Wallet } from '@project-serum/anchor';
import { Jupiter } from '@jup-ag/core';
import {
  THEO_VOL_MAP, maxNotional, TWAP_INTERVAL_SEC, SCALPER_WINDOW_SEC,
  ZSCORE, MinContractSize, TickSize, FILLS_URL, IS_DEV, GAMMA_THRESHOLD,
  MAX_DELTA_HEDGES, DELTA_OFFSET, MANGO_DOWNTIME_THRESHOLD_MIN,
  PERP_FUNDING_RATE_THRESHOLD, GAMMA_CYCLES, MinOpenBookSize, OPENBOOK_FORK_ID,
  treasuryPositions, slippageMax, GAMMA_COMPLETE_THRESHOLD_PCT, cluster,
  MAX_ORDER_BOOK_SEARCH_DEPTH, MAX_BACK_GAMMA_MULTIPLE, API_URL, MODE_BY_SYMBOL,
  WHALE_MAX_SPREAD, ScalperMode, ORDER_SIZE_BUFFER_PCT, IS_DEMO, HedgeProduct,
} from './config';
import { CallOrPut, DIPDeposit, SYMBOL } from './common';
import {
  readKeypair, sleepExact, sleepRandom, tokenToSplMint,
} from './utils';
import { SerumVialClient, SerumVialTradeMessage, tradeMessageToString } from './serumVial';
import {
  jupiterHedge, getDIPDelta, getDIPGamma, getDIPTheta, getPayerAccount,
  getSpotDelta, orderSpliceMango, liquidityCheckAndNumSplices,
  tryToSettleOpenBook, setPriorityFee, waitForFill, findMaxStrike, findMinStrike,
  findNearestStrikeType, getMangoHedgeProduct, cancelOpenBookOrders,
  findFairValue, roundPriceToTickSize, roundQtyToSpotSize,
} from './scalper_utils';
import {
  MANGO_ACCOUNT_PK, MANGO_DEMO_PK, NO_FAIR_VALUE, OPENBOOK_MKT_MAP,
  SEC_PER_YEAR, SUFFICIENT_BOOK_DEPTH,
} from './constants';

class Scalper {
  mangoClient: MangoClient;
  connection: Connection;
  owner: Keypair;
  symbol: SYMBOL;
  impliedVol: number;
  minSize: number;
  minSpotSize: number;
  tickSize: number;
  marketIndex: number;
  deltaOffset: number;
  zScore: number;
  mode: ScalperMode;
  openBookAccount: string;
  serumVialClient: SerumVialClient;
  provider: AnchorProvider;

  constructor(symbol: SYMBOL) {
    this.connection = new Connection(
      API_URL,
      'processed' as Commitment,
    );
    this.owner = Keypair.fromSecretKey(Uint8Array.from(readKeypair()));
    this.provider = new AnchorProvider(
      this.connection,
      new Wallet(this.owner),
      AnchorProvider.defaultOptions(),
    );

    this.symbol = symbol;
    this.impliedVol = THEO_VOL_MAP.get(symbol);
    this.minSize = MinContractSize.get(symbol);
    this.minSpotSize = MinOpenBookSize.get(symbol);
    this.tickSize = TickSize.get(symbol);
    this.deltaOffset = DELTA_OFFSET.get(symbol);
    this.zScore = ZSCORE.get(symbol);
    this.mode = MODE_BY_SYMBOL.get(symbol);

    this.serumVialClient = new SerumVialClient();
    this.serumVialClient.openSerumVial();
  }

  async pickAndRunScalper(dipProduct: DIPDeposit[]): Promise<void> {
    // Add any treasury positions from Staking Options.
    for (const positions of treasuryPositions) {
      if (this.symbol === positions.splTokenName) {
        dipProduct.push(positions);
      }
    }
    console.log(this.symbol, 'Tracking Positions', dipProduct.length);
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

    console.log(this.symbol, 'Choosing market to trade');

    if (this.mode === ScalperMode.Perp) {
      // Load Mango
      this.mangoClient = MangoClient.connect(
        this.provider,
        cluster,
        MANGO_V4_ID[cluster],
        {
          idsSource: 'get-program-accounts',
        },
      );
      const mangoAccount = await this.mangoClient.getMangoAccount(
        IS_DEMO ? new PublicKey(MANGO_DEMO_PK) : new PublicKey(MANGO_ACCOUNT_PK),
      );
      await mangoAccount.reload(this.mangoClient);
      const mangoGroup = await this.mangoClient.getGroup(mangoAccount.group);
      await mangoGroup.reloadAll(this.mangoClient);
      const perpMarket = mangoGroup.getPerpMarketByName('BTC-PERP');
      this.marketIndex = perpMarket.perpMarketIndex;
      if (!perpMarket) {
        console.log('No Mango Market Exists. Run OpenBook');
        await this.scalperOpenBook(dipProduct);
        return;
      }

      // Check if Mango Perp is live
      const lastUpdateMango = perpMarket.fundingLastUpdated.toNumber() * 1000;
      if ((Date.now() - lastUpdateMango)
        / (1_000 * 60) > MANGO_DOWNTIME_THRESHOLD_MIN) {
        console.log(this.symbol, 'Mango Down! Last Updated:', new Date(lastUpdateMango));
        await this.scalperOpenBook(dipProduct);
      } else {
        await this.scalperMango(dipProduct, mangoAccount, mangoGroup, perpMarket);
      }
    } else {
      await this.scalperOpenBook(dipProduct);
    }
  }

  // Delta hedge and gamma scalp on mango.
  async scalperMango(
    dipProduct: DIPDeposit[],
    mangoAccount: MangoAccount,
    mangoGroup: Group,
    perpMarket: PerpMarket,
  ): Promise<void> {
    console.log(this.symbol, 'Hedging on Mango');

    // Open Mango Websocket
    // TODO: Get Fills Feed Running
    const fillFeed = new WebSocket(FILLS_URL!);
    fillFeed.onopen = (_) => {
      console.log('Connected to Mango Websocket', new Date().toUTCString());
    };
    fillFeed.onerror = (error) => {
      console.log(`Websocket Error ${error.message}`);
    };

    try {
      await this.deltaHedgeMango(
        dipProduct,
        mangoAccount,
        mangoGroup,
        perpMarket,
        fillFeed,
        1,
      );
      await this.gammaScalpMango(
        dipProduct,
        mangoAccount,
        mangoGroup,
        perpMarket,
        fillFeed,
        1,
      );
    } catch (err) {
      console.log(this.symbol, 'Main Error', err, err.stack);
    }
  }

  async deltaHedgeMango(
    dipProduct: DIPDeposit[],
    mangoAccount: MangoAccount,
    mangoGroup: Group,
    perpMarket: PerpMarket,
    fillFeed: WebSocket,
    deltaHedgeCount: number,
  ): Promise<void> {
    await mangoGroup.reloadAll(this.mangoClient);
    // Cleanup from previous runs.
    await this.cancelStaleMangoOrders(mangoAccount, mangoGroup, perpMarket);

    // Avoid unsafe recursion.
    if (deltaHedgeCount > MAX_DELTA_HEDGES) {
      console.log(this.symbol, 'Max Hedges exceeded without getting to neutral');
      return;
    }

    // Calc DIP delta for new position
    const fairValue = perpMarket.uiPrice;
    const dipTotalDelta = getDIPDelta(dipProduct, fairValue, this.symbol);

    // Get Mango delta position
    const mangoPerpDelta = mangoAccount.getPerpPositionUi(mangoGroup, perpMarket.perpMarketIndex);
    let mangoSpotDelta = 0;
    try {
      mangoSpotDelta = mangoAccount.getTokenBalanceUi(
        mangoGroup.getFirstBankByMint(tokenToSplMint(this.symbol)),
      );
    } catch (err) {
      console.log(this.symbol, 'No Mango Token Balance Possible');
    }

    // Get all spot positions Option Vault, Risk Manager, Mango Tester
    const spotDelta = await getSpotDelta(this.connection, this.symbol);

    // Get Total Delta Position to hedge
    let hedgeDeltaTotal = IS_DEV
      ? 0.1
      : mangoPerpDelta + dipTotalDelta + spotDelta + mangoSpotDelta + this.deltaOffset;

    // Check whether we need to hedge.
    const dipTotalGamma = getDIPGamma(dipProduct, fairValue, this.symbol);
    const stdDevSpread = (this.impliedVol / Math.sqrt(SEC_PER_YEAR
    / SCALPER_WINDOW_SEC)) * this.zScore;
    const slippageTolerance = Math.min(stdDevSpread / 2, slippageMax.get(this.symbol));
    const deltaThreshold = Math.max(
      dipTotalGamma * stdDevSpread * fairValue * GAMMA_THRESHOLD,
      this.minSize,
    );
    if (Math.abs(hedgeDeltaTotal * fairValue) < (deltaThreshold * fairValue)) {
      console.log(this.symbol, 'Delta Netural <', deltaThreshold);
      return;
    }
    console.log(this.symbol, 'Above delta threshold:', deltaThreshold);

    // TODO: Add slippage delta adjustment

    // Determine spot or perp order based on funding rate.
    const bidSide = await perpMarket.loadBids(this.mangoClient);
    const askSide = await perpMarket.loadAsks(this.mangoClient);
    const fundingRate = (24 * 365)
    * perpMarket.getCurrentFundingRate(bidSide, askSide);
    const buySpot = fundingRate > PERP_FUNDING_RATE_THRESHOLD;
    const sellSpot = -fundingRate < PERP_FUNDING_RATE_THRESHOLD;
    const hedgeSide = hedgeDeltaTotal < 0 ? PerpOrderSide.bid : PerpOrderSide.ask;
    let hedgeProduct = getMangoHedgeProduct(hedgeSide, buySpot, sellSpot);
    // No OpenBook BTC market exists still
    if (this.symbol === 'BTC') {
      hedgeProduct = HedgeProduct.Perp;
    }

    console.log(
      `${this.symbol} Target Delta Hedge: ${hedgeSide} ${hedgeProduct} ${-hedgeDeltaTotal} \
      DIP Δ: ${dipTotalDelta} Mango Perp Δ: ${mangoPerpDelta} Mango Spot Δ: ${mangoSpotDelta} \
      Spot Δ: ${spotDelta} Offset Δ ${this.deltaOffset} Fair Value: ${fairValue}`,
    );

    // Determine what price to use for hedging depending on allowable slippage.
    const hedgePrice = roundPriceToTickSize(hedgeDeltaTotal < 0
      ? fairValue * (1 + slippageTolerance) : fairValue * (1 - slippageTolerance), this.tickSize);

    // Break up order depending on whether the book can support it
    const bookSide = hedgeDeltaTotal < 0 ? askSide : bidSide;
    const hedgeDeltaClip = roundQtyToSpotSize(hedgeDeltaTotal
      / orderSpliceMango(
        hedgeDeltaTotal,
        fairValue,
        maxNotional.get(this.symbol),
        slippageTolerance,
        bookSide,
        perpMarket,
      ), this.minSize);

    const deltaOrderId = new Date().getTime() * 2;

    // Start listening for Delta Hedge Fills
    const deltaFillListener = async (event: WebSocket.MessageEvent) => {
      const parsedEvent = JSON.parse(event.data as string);
      if (parsedEvent.status === 'New' && parsedEvent.market === this.symbol.concat(hedgeProduct)) {
        const fillBytes: Buffer = Buffer.from(parsedEvent.event, 'base64');
        // TODO: Confirm this parses fills
        const fillEvent: FillEvent = parsedEvent.decode(fillBytes).fill;
        if (
          (fillEvent.makerOrderId.toString() === deltaOrderId.toString())
          || (fillEvent.takerOrderId.toString() === deltaOrderId.toString())
        ) {
          const fillQty = (hedgeSide === PerpOrderSide.bid ? 1 : -1)
            * fillEvent.quantity.toNumber() * this.minSize;
          const fillPrice = fillEvent.price.toNumber() * this.tickSize;
          hedgeDeltaTotal += fillQty;

          console.log(`${this.symbol} Delta Filled ${hedgeSide} ${hedgeProduct} Qty ${fillQty} \
          Price ${fillPrice} Remaining ${hedgeDeltaTotal} ID ${deltaOrderId} ${new Date().toUTCString()}`);

          if (Math.abs(hedgeDeltaTotal * fairValue) < (this.minSize * fairValue)) {
            fillFeed.removeEventListener('message', deltaFillListener);
            console.log(this.symbol, 'Delta Hedge Complete: Websocket Fill');
          }
        }
      }
    };

    // Setup a listener for the order.
    if (fillFeed.readyState === WebSocket.OPEN) {
      fillFeed.addEventListener('message', deltaFillListener);
      console.log(this.symbol, 'Listening For Delta Hedges');
    } else {
      console.log(this.symbol, 'Websocket State', fillFeed.readyState);
    }

    console.log(`${this.symbol} ${hedgeSide} ${hedgeProduct} ${Math.abs(hedgeDeltaClip)} \
    Limit: ${hedgePrice} # ${deltaHedgeCount} ID ${deltaOrderId}`);

    try {
      // TODO: Test Spot
      if (hedgeProduct === HedgeProduct.Spot) {
        const spotHedgeSide = hedgeSide === PerpOrderSide.bid ? Serum3Side.bid : Serum3Side.ask;
        await this.mangoClient.serum3PlaceOrder(
          mangoGroup,
          mangoAccount,
          new PublicKey(OPENBOOK_MKT_MAP.get(this.symbol)),
          spotHedgeSide,
          hedgePrice,
          Math.abs(hedgeDeltaClip),
          Serum3SelfTradeBehavior.decrementTake,
          Serum3OrderType.limit,
          deltaOrderId,
          10,
        );
      } else {
        await this.mangoClient.perpPlaceOrder(
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
      console.log(this.symbol, 'Failed to place order', err, err.stack);
    }

    // Wait the twapInterval of time to see if the position gets to neutral.
    console.log(this.symbol, 'Scan Delta Fills for ~', TWAP_INTERVAL_SEC, 'seconds');
    await sleepRandom(TWAP_INTERVAL_SEC);

    // Cleanup listener.
    fillFeed.removeEventListener('message', deltaFillListener);

    // Recursive call. This happens when we are not getting fills to get to neutral.
    await this.deltaHedgeMango(
      dipProduct,
      mangoAccount,
      mangoGroup,
      perpMarket,
      fillFeed,
      deltaHedgeCount + 1,
    );
  }

  async gammaScalpMango(
    dipProduct: DIPDeposit[],
    mangoAccount,
    mangoGroup: Group,
    perpMarket: PerpMarket,
    fillFeed: WebSocket,
    gammaScalpCount: number,
  ): Promise<void> {
    await mangoGroup.reloadAll(this.mangoClient);
    // Makes the recursive gamma scalps safer. Rerun will clear any stale
    // orders. Allows only 2 gamma orders at any time
    await this.cancelStaleMangoOrders(mangoAccount, mangoGroup, perpMarket);

    // Avoid unsafe recursion.
    if (gammaScalpCount > GAMMA_CYCLES) {
      console.log(this.symbol, 'Maximum scalps acheived!', gammaScalpCount - 1, 'Wait for Rerun');
      return;
    }

    const fairValue = perpMarket.uiPrice;
    const dipTotalGamma = getDIPGamma(dipProduct, fairValue, this.symbol);

    // TODO: Allow scalper modes for back bids & strike adjustments
    // Calc scalperWindow std deviation spread from zScore & IV for gamma levels
    const stdDevSpread = (this.impliedVol
    / Math.sqrt(SEC_PER_YEAR / SCALPER_WINDOW_SEC))
    * this.zScore;
    const netGamma = IS_DEV
      ? Math.max(0.01, dipTotalGamma * stdDevSpread * fairValue)
      : dipTotalGamma * stdDevSpread * fairValue;

    console.log(this.symbol, 'Position Gamma Γ:', netGamma, 'Fair Value', fairValue);
    if ((netGamma * fairValue) < (this.minSize * fairValue)) {
      console.log(this.symbol, 'Gamma Hedge Too Small');
      return;
    }

    const orderIdGamma = new Date().getTime() * 2;
    const gammaBid = fairValue * (1 - stdDevSpread);
    const gammaBidID = orderIdGamma + 1;
    const gammaAsk = fairValue * (1 + stdDevSpread);
    const gammaAskID = orderIdGamma + 2;

    // TODO: Check fills feed works here
    fillFeed.removeAllListeners('message');
    const gammaFillListener = (event) => {
      const parsedEvent = JSON.parse(event.data);
      if (parsedEvent.status !== 'New' || parsedEvent.market !== this.symbol.concat('-PERP')) {
        return;
      }
      const fillBytes = Buffer.from(parsedEvent.event, 'base64');
      const fillEvent: FillEvent = parsedEvent.decode(fillBytes).fill;
      const bidFill = fillEvent.makerOrderId.toString() === gammaBidID.toString()
        || fillEvent.takerOrderId.toString() === gammaBidID.toString();
      const askFill = fillEvent.makerOrderId.toString() === gammaAskID.toString()
        || fillEvent.takerOrderId.toString() === gammaAskID.toString();

      if (!bidFill && !askFill) {
        return;
      }
      console.log(this.symbol, 'Gamma Filled', bidFill ? 'BID' : 'ASK', new Date().toUTCString());
      fillFeed.removeEventListener('message', gammaFillListener);
      // Do not need to remove the unfilled order since it will be cancelled in
      // the recursive call.
      this.gammaScalpMango(
        dipProduct,
        mangoAccount,
        mangoGroup,
        perpMarket,
        fillFeed,
        gammaScalpCount + 1,
      );
    };

    if (fillFeed.readyState === WebSocket.OPEN) {
      fillFeed.addEventListener('message', gammaFillListener);
      console.log(this.symbol, 'Listening For gamma scalps');
    } else {
      console.log(this.symbol, 'Websocket State', fillFeed.readyState);
    }

    // Place gamma scalp bid & offer.
    try {
      const gammaBidTx = await this.mangoClient.perpPlaceOrderIx(
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
      const gammaAskTx = await this.mangoClient.perpPlaceOrderIx(
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
      console.log(this.symbol, 'Gamma Bid', gammaBid, 'ID', gammaBidID);
      console.log(this.symbol, 'Gamma Ask', gammaAsk, 'ID', gammaAskID);
      await this.mangoClient.sendAndConfirmTransaction(gammaOrdersTx);
    } catch (err) {
      console.log(this.symbol, 'Gamma Error', err, err.stack);
    }
    console.log(`${this.symbol} Market Spread %' ${((gammaAsk - gammaBid) / fairValue) * 100} Liquidity $ ${netGamma * 2 * fairValue}`);

    // Sleep for the max time of the reruns then kill thread
    await sleepExact(SCALPER_WINDOW_SEC);
    console.log(this.symbol, 'Remove stale gamma fill listener', gammaBidID, gammaAskID);
    fillFeed.removeEventListener('message', gammaFillListener);
  }

  async cancelStaleMangoOrders(
    mangoAccount: MangoAccount,
    mangoGroup: Group,
    perpMarket: PerpMarket,
  ): Promise<void> {
    await mangoAccount.reload(this.mangoClient);
    const openOrders = await mangoAccount.loadPerpOpenOrdersForMarket(
      this.mangoClient,
      mangoGroup,
      perpMarket.perpMarketIndex,
    );
    if (openOrders.length === 0) {
      return;
    }
    for (const order of openOrders) {
      if (order.perpMarketIndex === this.marketIndex) {
        console.log(this.symbol, 'Canceling All Orders');
        await this.mangoClient.perpCancelAllOrders(
          mangoGroup,
          mangoAccount,
          perpMarket.perpMarketIndex,
          10,
        );
        break;
      }
    }
  }

  async scalperOpenBook(dipProduct: DIPDeposit[]): Promise<void> {
    console.log(this.symbol, 'Hedging on OpenBook');

    this.serumVialClient.removeAnyListeners();
    let spotMarket: Market;
    let jupiter: Jupiter;
    try {
      spotMarket = await Market.load(
        this.connection,
        new PublicKey(OPENBOOK_MKT_MAP.get(this.symbol)),
        undefined,
        OPENBOOK_FORK_ID,
      );
    } catch (err) {
      console.log(this.symbol, 'No OpenBook Market Found', err);
      return;
    }

    try {
      console.log(this.symbol, 'Loading Jupiter');
      jupiter = await Jupiter.load({
        connection: this.connection,
        cluster,
        user: this.owner,
        wrapUnwrapSOL: false,
        restrictIntermediateTokens: true,
        shouldLoadSerumOpenOrders: false,
      });
    } catch (err) {
      console.log(this.symbol, 'Jupiter Failed', err);
      return;
    }

    if (this.mode === ScalperMode.Normal) {
      try {
        await this.deltaHedgeOpenBook(
          dipProduct,
          1 /* deltaHedgeCount */,
          spotMarket,
          jupiter,
        );
        await this.gammaScalpOpenBook(
          dipProduct,
          1, /* gammaScalpCount */
          NO_FAIR_VALUE, /* priorFillPrice */
          spotMarket,
          jupiter,
        );
      } catch (err) {
        console.log(this.symbol, 'Normal scalping error', err.stack);
      }
      this.serumVialClient.removeAnyListeners();
    } else {
      try {
        await this.gammaScalpOpenBook(
          dipProduct,
          1, /* gammaScalpCount */
          NO_FAIR_VALUE, /* priorFillPrice */
          spotMarket,
          jupiter,
        );
      } catch (err) {
        console.log(this.symbol, 'Main Gamma Error', err.stack);
      }
    }
    console.log(this.symbol, 'Scalper Cycle completed', new Date().toUTCString());
    console.log('~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~');
  }

  async deltaHedgeOpenBook(
    dipProduct: DIPDeposit[],
    deltaHedgeCount: number,
    spotMarket: Market,
    jupiter: Jupiter,
  ): Promise<void> {
    // Clean the state by cancelling all existing open orders.
    await cancelOpenBookOrders(this.connection, this.owner, spotMarket, this.symbol);

    await tryToSettleOpenBook(this.connection, this.owner, spotMarket, this.symbol, 'USDC');

    // Prevent too much recursion.
    if (deltaHedgeCount > MAX_DELTA_HEDGES) {
      console.log(this.symbol, 'Max OpenBook Hedges exceeded!');
      return;
    }
    const deltaID = new BN(new Date().getTime());

    let hedgeDeltaTotal: number = 0;
    let hedgeSide: 'buy' | 'sell' = 'buy';
    this.serumVialClient.streamData(
      ['trades'],
      [`${this.symbol}/USDC`],
      [deltaID.toString()],
      (message: SerumVialTradeMessage) => {
        const side: string = message.makerClientId === deltaID.toString() ? 'Maker' : 'Taker';
        console.log(`${this.symbol} Delta Fill ${side} ${hedgeSide} ${tradeMessageToString(message)}`);
        const fillQty = (hedgeSide === 'buy' ? 1 : -1) * message.size;
        hedgeDeltaTotal += fillQty;
      },
    );

    console.log(this.symbol, 'Loading Fair Value');
    const fairValue = await findFairValue(
      this.connection,
      spotMarket,
      this.symbol,
      jupiter,
      MAX_DELTA_HEDGES,
      TWAP_INTERVAL_SEC,
    );
    if (fairValue === NO_FAIR_VALUE) {
      console.log(this.symbol, 'No Robust Pricing. Exiting Delta Hedge', deltaHedgeCount);
      return;
    }

    // Get total delta position to hedge. Use .1 for DEV to force that it does something.
    const dipTotalDelta = getDIPDelta(dipProduct, fairValue, this.symbol);
    const spotDelta = await getSpotDelta(this.connection, this.symbol);
    hedgeDeltaTotal = IS_DEV ? 0.1 : dipTotalDelta + spotDelta + this.deltaOffset;
    hedgeSide = hedgeDeltaTotal < 0 ? 'buy' : 'sell';

    console.log(
      `${this.symbol} Target Delta Hedge: ${hedgeSide} SPOT ${-hedgeDeltaTotal} DIP Δ: ${dipTotalDelta} \
      Spot Δ: ${spotDelta} Offset Δ ${this.deltaOffset} Fair Value: ${fairValue}`,
    );

    // Check whether we need to hedge.
    const dipTotalGamma = getDIPGamma(dipProduct, fairValue, this.symbol);
    const stdDevSpread = (this.impliedVol / Math.sqrt(SEC_PER_YEAR / SCALPER_WINDOW_SEC))
    * this.zScore;
    const deltaThreshold = Math.max(
      dipTotalGamma * stdDevSpread * fairValue * GAMMA_THRESHOLD,
      this.minSpotSize,
    );
    if (Math.abs(hedgeDeltaTotal) < deltaThreshold) {
      console.log(this.symbol, 'Delta Netural Within', deltaThreshold);
      return;
    }
    const slippageTolerance = Math.min(stdDevSpread / 2, slippageMax.get(this.symbol));
    let hedgePrice = hedgeDeltaTotal < 0
      ? fairValue * (1 + slippageTolerance)
      : fairValue * (1 - slippageTolerance);
    const slippageDIPDelta = getDIPDelta(dipProduct, hedgePrice, this.symbol);
    const dipDeltaDiff = slippageDIPDelta - dipTotalDelta;
    hedgeDeltaTotal += dipDeltaDiff;
    console.log(this.symbol, 'Adjust Slippage Delta by', dipDeltaDiff, 'to', -hedgeDeltaTotal);

    const notionalThreshold = deltaThreshold * fairValue;
    const notionalAmount = -hedgeDeltaTotal * fairValue;
    if ((notionalAmount < notionalThreshold && hedgeSide === 'buy')
       || (notionalAmount > notionalThreshold && hedgeSide === 'sell')) {
      console.log(this.symbol, 'Delta Netural: Slippage', deltaThreshold);
      return;
    }
    console.log(this.symbol, 'Outside delta threshold:', Math.abs(hedgeDeltaTotal), 'vs.', deltaThreshold);

    // Load order book data to determine splicing.
    const bids = await spotMarket.loadBids(this.connection);
    const asks = await spotMarket.loadAsks(this.connection);
    const spliceFactor = liquidityCheckAndNumSplices(
      hedgeDeltaTotal,
      hedgePrice,
      maxNotional.get(this.symbol),
      hedgeSide,
      bids,
      asks,
    );

    let hedgeDeltaClip = hedgeDeltaTotal;
    try {
      if (spliceFactor !== SUFFICIENT_BOOK_DEPTH) {
        console.log(this.symbol, 'Not enough liquidity! Try Jupiter. Adjust Price', hedgePrice, 'Splice', spliceFactor);
        // Check on jupiter and sweep price
        const jupValues = await jupiterHedge(hedgeSide, this.symbol, 'USDC', hedgeDeltaTotal, hedgePrice, jupiter);
        if (jupValues !== undefined) {
          const { setupTransaction, swapTransaction, cleanupTransaction } = jupValues.txs;
          for (const jupTx of [setupTransaction, swapTransaction, cleanupTransaction].filter(
            Boolean,
          )) {
            const txid = await sendAndConfirmTransaction(this.connection, jupTx, [this.owner]);
            if (jupTx === swapTransaction) {
              const spotDeltaUpdate = jupValues.qty;
              hedgeDeltaTotal += spotDeltaUpdate;
              console.log(this.symbol, 'Jupiter Hedge via', jupValues.venue, 'Price', jupValues.price, 'Qty', jupValues.qty, `https://solana.fm/tx/${txid}${cluster?.includes('devnet') ? '?cluster=devnet' : ''}`);
            }
          }
          console.log(this.symbol, 'Adjust', hedgeSide, 'Price', hedgePrice, 'to', jupValues.price, 'Remaining Qty', hedgeDeltaTotal);
          hedgePrice = jupValues.price;
        } else {
          console.log(this.symbol, 'No Jupiter Route Found Better than', hedgePrice);
        }
        hedgeDeltaClip = hedgeDeltaTotal / spliceFactor;
      } else {
        console.log(this.symbol, 'Sufficient liquidity. Sweep OpenBook');
      }

      // Return early if jupiter sweeping got within the threshold.
      if (Math.abs(hedgeDeltaTotal) < deltaThreshold) {
        console.log(this.symbol, 'Delta Netural: Jupiter Hedge');
        return;
      }
    } catch (err) {
      console.log(this.symbol, 'Jupiter Route', err, err.stack);
    }

    // Send the delta hedge order to openbook.
    const amountDelta = roundQtyToSpotSize(Math.abs(hedgeDeltaClip), this.minSpotSize);
    const priceDelta = roundPriceToTickSize(Math.abs(hedgePrice), this.tickSize);
    const payerAccount = getPayerAccount(hedgeSide, this.symbol, 'USDC');
    console.log(this.symbol, hedgeSide, 'OpenBook-SPOT', amountDelta, 'Limit:', priceDelta, '#', deltaHedgeCount, 'ID', deltaID.toString());
    const deltaOrderTx = new Transaction();
    const deltaTx = await spotMarket.makePlaceOrderTransaction(this.connection, {
      owner: new Account(this.owner.secretKey),
      payer: payerAccount,
      side: hedgeSide,
      price: priceDelta,
      size: amountDelta,
      orderType: 'limit',
      clientId: deltaID,
      selfTradeBehavior: 'abortTransaction',
    });
    deltaOrderTx.add(deltaTx.transaction);
    await sendAndConfirmTransaction(this.connection, setPriorityFee(deltaOrderTx), [this.owner]);

    // Rest single order if the hedge should be completed in a single clip
    if (spliceFactor === 1) {
      const netHedgePeriod = TWAP_INTERVAL_SEC * MAX_DELTA_HEDGES;
      console.log(this.symbol, 'Scan Delta Fills for ~', netHedgePeriod, 'seconds');

      await waitForFill(() => (Math.abs(hedgeDeltaTotal) < this.minSpotSize), TWAP_INTERVAL_SEC);
      if (Math.abs(hedgeDeltaTotal) < this.minSpotSize) {
        console.log(this.symbol, 'Delta Hedge Complete: SerumVial');
        return;
      }

      const [bidTOB, _bidSize] = bids.getL2(1)[0];
      const [askTOB, _askSize] = asks.getL2(1)[0];
      const spreadDelta = hedgeDeltaTotal < 0
        ? ((askTOB - hedgePrice) / hedgePrice) * 100
        : ((bidTOB - hedgePrice) / hedgePrice) * 100;
      console.log(`${this.symbol} OpenBook Delta Hedge Timeout. Spread % ${spreadDelta} \
      > Slippage % ${slippageTolerance * 100}`);
      return;
    }

    // Wait the twapInterval of time to see if the position gets to neutral.
    // This is the case where we are unable to fill all of the delta at once and
    // need to send multiple orders. Either it will get filled which will get
    // caught in the next run, enough time has passed and we start a new run
    // anyways.
    console.log(this.symbol, 'Scan Delta Fills for ~', TWAP_INTERVAL_SEC, 'seconds');
    await waitForFill(
      (_) => Math.abs(hedgeDeltaTotal * fairValue) < (this.minSpotSize * fairValue),
      TWAP_INTERVAL_SEC,
    );
    this.serumVialClient.removeAnyListeners();
    await this.deltaHedgeOpenBook(
      dipProduct,
      deltaHedgeCount + 1,
      spotMarket,
      jupiter,
    );
  }

  async gammaScalpOpenBook(
    dipProduct: DIPDeposit[],
    gammaScalpCount: number,
    priorFillPrice: number,
    spotMarket: Market,
    jupiter: Jupiter,
  ): Promise<void> {
    const orderIDBase = new Date().getTime() * 2;
    const bidID = new BN(orderIDBase);
    const askID = new BN(orderIDBase + 1);
    const backBidID = new BN(orderIDBase * 2);
    const backAskID = new BN(orderIDBase * 2 + 1);
    const gammaIds = [
      bidID.toString(), askID.toString(), backBidID.toString(), backAskID.toString(),
    ];

    if (this.serumVialClient.checkSerumVial() !== WebSocket.OPEN) {
      this.serumVialClient.openSerumVial();
    }

    let gammaFillQty = 0;
    let amountGamma = 0;
    this.serumVialClient.streamData(
      ['trades'],
      [`${this.symbol}/USDC`],
      gammaIds,
      (message: SerumVialTradeMessage) => {
        if (message.makerClientId === backBidID.toString()
        || message.makerClientId === backAskID.toString()) {
          console.log(this.symbol, 'Back Fill!!!', tradeMessageToString(message));
          return;
        }
        gammaFillQty += Math.abs(message.size);
        if (message.makerClientId === bidID.toString()
        || message.makerClientId === askID.toString()) {
          console.log(this.symbol, 'Gamma Fill!', tradeMessageToString(message));
        } else {
          // This should not happen. Gamma scalps should be maker orders only.
          console.log(this.symbol, 'Gamma Scalp Fill From Taker?!', tradeMessageToString(message));
        }

        // Once the gamma fills have crossed the threshold, reset the orders.
        if (gammaFillQty > amountGamma * GAMMA_COMPLETE_THRESHOLD_PCT) {
          gammaFillQty = 0;
          const fillPrice = Number(message.price);
          this.gammaScalpOpenBook(
            dipProduct,
            gammaScalpCount + 1,
            fillPrice,
            spotMarket,
            jupiter,
          );
        } else {
          console.log('Gamma Partially Filled', gammaFillQty, 'of', amountGamma);
        }
      },
    );

    // Clean the state by cancelling all existing open orders.
    await cancelOpenBookOrders(this.connection, this.owner, spotMarket, this.symbol);

    await tryToSettleOpenBook(this.connection, this.owner, spotMarket, this.symbol, 'USDC');

    // Prevent too much recursion.
    if (gammaScalpCount > GAMMA_CYCLES) {
      console.log(this.symbol, 'Maximum scalps acheived!', gammaScalpCount - 1, 'Wait for Rerun');
      return;
    }

    console.log(this.symbol, 'Loading Fair Value For Scalp', gammaScalpCount);
    let fairValue: number;
    if (priorFillPrice > NO_FAIR_VALUE) {
      fairValue = priorFillPrice;
      console.log(this.symbol, 'Fair Value Set to Prior Fill', fairValue);
    } else {
      fairValue = await findFairValue(
        this.connection,
        spotMarket,
        this.symbol,
        jupiter,
        GAMMA_CYCLES,
        TWAP_INTERVAL_SEC,
      );
      if (fairValue === NO_FAIR_VALUE) {
        console.log(this.symbol, 'No Robust Pricing. Exiting Gamma Scalp', gammaScalpCount);
        return;
      }
    }
    const dipTotalGamma = getDIPGamma(dipProduct, fairValue, this.symbol);

    // Calc scalperWindow std deviation spread from zScore & IV for gamma levels.
    const stdDevSpread = (this.impliedVol / Math.sqrt(SEC_PER_YEAR / SCALPER_WINDOW_SEC))
    * this.zScore;
    const netGamma = IS_DEV
      ? Math.max(0.01, dipTotalGamma * stdDevSpread * fairValue)
      : dipTotalGamma * stdDevSpread * fairValue;

    const stdDevWidenedSpread = ((gammaScalpCount - 1) / GAMMA_CYCLES) * stdDevSpread;
    let gammaBid = fairValue * (1 - stdDevSpread - stdDevWidenedSpread);
    let gammaAsk = fairValue * (1 + stdDevSpread + stdDevWidenedSpread);

    const spotDelta = await getSpotDelta(this.connection, this.symbol);

    // TODO: Determine if should always have this on or only on products we can't get delta neutral
    if (this.mode === ScalperMode.GammaBackStrikeAdjustment) {
      const dipTotalDelta = getDIPDelta(dipProduct, fairValue, this.symbol);
      const isShort = dipTotalDelta + spotDelta + this.deltaOffset < 0;
      // TODO: Create a gamma table to find relevant long & short strikes
      const nearStrikeType = findNearestStrikeType(dipProduct, fairValue);
      console.log(this.symbol, 'Delta Position', dipTotalDelta + spotDelta + this.deltaOffset, nearStrikeType, 'isShort', isShort);
      if (nearStrikeType === CallOrPut.Put && isShort) {
        const maxStrike = findMaxStrike(dipProduct);
        const isOTM = fairValue > maxStrike;
        if (isOTM) {
          gammaBid = Math.min(maxStrike * (1 - stdDevSpread - stdDevWidenedSpread), gammaBid);
          console.log('Strike Adjusted Gamma Bid', gammaBid, maxStrike);
        } else {
          gammaAsk = Math.max(maxStrike * (1 + stdDevSpread + stdDevWidenedSpread), gammaAsk);
          console.log('Strike Adjusted Gamma Ask', gammaAsk, maxStrike);
        }
      } else if (nearStrikeType === CallOrPut.Call && !isShort) {
        const minStrike = findMinStrike(dipProduct);
        const isOTM = (fairValue < minStrike);
        if (isOTM) {
          gammaAsk = Math.max(minStrike * (1 + stdDevSpread + stdDevWidenedSpread), gammaAsk);
          console.log('Strike Adjusted Gamma Ask', gammaAsk, minStrike);
        } else {
          gammaBid = Math.min(minStrike * (1 - stdDevSpread - stdDevWidenedSpread), gammaBid);
          console.log('Strike Adjusted Gamma Bid', gammaBid, minStrike);
        }
      }
    }

    console.log(this.symbol, 'Position Gamma Γ:', netGamma, 'Fair Value', fairValue);
    if (netGamma < this.minSpotSize) {
      console.log(this.symbol, 'Gamma Hedge Too Small');
      return;
    }

    // Find the prices at which whale qty is bid & offered
    const bids = await spotMarket.loadBids(this.connection);
    const numBids = bids.getL2(MAX_ORDER_BOOK_SEARCH_DEPTH).length;
    const dimQty = MAX_BACK_GAMMA_MULTIPLE * netGamma;
    let bidDepth = 0;
    let whaleBidPrice: number;
    // TODO: Fix this logic to avoid continuously reparsing L2.
    for (let i = 0; i < numBids; i++) {
      bidDepth += bids.getL2(i + 1)[i][1];
      if (bidDepth >= dimQty) {
        [whaleBidPrice] = bids.getL2(i + 1)[i];
        break;
      }
    }
    const asks = await spotMarket.loadAsks(this.connection);
    const numAsks = asks.getL2(MAX_ORDER_BOOK_SEARCH_DEPTH).length;
    let askDepth = 0;
    let whaleAskPrice: number;
    for (let i = 0; i < numAsks; i++) {
      askDepth += asks.getL2(i + 1)[i][1];
      if (askDepth >= dimQty) {
        [whaleAskPrice] = asks.getL2(i + 1)[i];
        break;
      }
    }
    console.log(`${this.symbol} Whale Bid: ${whaleBidPrice} Ask ${whaleAskPrice} \
    Spread % ${((whaleAskPrice - whaleBidPrice) / fairValue) * 100}`);

    amountGamma = roundQtyToSpotSize(Math.abs(netGamma), this.minSpotSize);
    // Reduce gamma ask if not enough inventory.
    const gammaAskQty = Math.abs(spotDelta) > amountGamma ? amountGamma
      : roundQtyToSpotSize(Math.abs(spotDelta * ORDER_SIZE_BUFFER_PCT), this.minSpotSize);
    const priceBid = roundPriceToTickSize(Math.abs(gammaBid), this.tickSize);
    const priceAsk = roundPriceToTickSize(Math.abs(gammaAsk), this.tickSize);
    const bidAccount = getPayerAccount('buy', this.symbol, 'USDC');
    const askAccount = getPayerAccount('sell', this.symbol, 'USDC');
    const gammaOrders = new Transaction();

    if (this.mode !== ScalperMode.BackOnly) {
      const gammaBidTx = await spotMarket.makePlaceOrderTransaction(this.connection, {
        owner: this.owner.publicKey,
        payer: bidAccount,
        side: 'buy',
        price: priceBid,
        size: amountGamma,
        orderType: 'limit',
        clientId: bidID,
        selfTradeBehavior: 'abortTransaction',
      });
      const gammaAskTx = await spotMarket.makePlaceOrderTransaction(this.connection, {
        owner: this.owner.publicKey,
        payer: askAccount,
        side: 'sell',
        price: priceAsk,
        size: gammaAskQty,
        orderType: 'limit',
        clientId: askID,
        selfTradeBehavior: 'abortTransaction',
      });
      gammaOrders.add(gammaBidTx.transaction);
      gammaOrders.add(gammaAskTx.transaction);
      console.log(this.symbol, 'Gamma', amountGamma, 'Bid', priceBid, 'BidID', bidID.toString());
      console.log(this.symbol, 'Gamma', amountGamma, 'Ask', priceAsk, 'AskID', askID.toString());
    }

    // Calculate effective gamma subject to max at price & round to nearest tick
    // size for order entry
    const whaleBidDiff = fairValue - whaleBidPrice;
    const whaleAskDiff = whaleAskPrice - fairValue;
    const backBidPrice = whaleBidDiff > fairValue - gammaBid
      ? roundPriceToTickSize(
        Math.max(whaleBidPrice + this.tickSize, gammaBid * (1 - WHALE_MAX_SPREAD)),
        this.tickSize,
      )
      : undefined;
    const backAskPrice = whaleAskDiff > gammaAsk - fairValue
      ? roundPriceToTickSize(
        Math.min(whaleAskPrice - this.tickSize, gammaAsk * (1 + WHALE_MAX_SPREAD)),
        this.tickSize,
      )
      : undefined;

    // TODO: Do the same logic for whale bid. Less likely but still applicable.
    const maxBackGamma = netGamma * (MAX_BACK_GAMMA_MULTIPLE - 1);
    const whaleBidGammaQty = Math.min(maxBackGamma, dipTotalGamma * whaleBidDiff - netGamma);
    let whaleAskGammaQty = Math.min(maxBackGamma, dipTotalGamma * whaleAskDiff - netGamma);
    // Reduce whale ask if not enough inventory
    if (whaleAskGammaQty > Math.abs(spotDelta)) {
      whaleAskGammaQty = 0;
    } else if (whaleAskGammaQty + amountGamma > Math.abs(spotDelta)) {
      whaleAskGammaQty = Math.abs(spotDelta * ORDER_SIZE_BUFFER_PCT) - amountGamma;
    }
    const backBidQty = roundQtyToSpotSize(Math.abs(whaleBidGammaQty), this.minSpotSize);
    const backAskQty = roundQtyToSpotSize(Math.abs(whaleAskGammaQty), this.minSpotSize);

    // Enter bid & offer if outside of range from gamma orders
    if (backBidPrice !== undefined && backBidQty > 0) {
      console.log(this.symbol, 'Back', backBidQty, 'Bid', backBidPrice, backBidID.toString());
      const whaleBidTx = await spotMarket.makePlaceOrderTransaction(this.connection, {
        owner: this.owner.publicKey,
        payer: bidAccount,
        side: 'buy',
        price: backBidPrice,
        size: backBidQty,
        orderType: 'limit',
        clientId: backBidID,
        selfTradeBehavior: 'abortTransaction',
      });
      gammaOrders.add(whaleBidTx.transaction);
    }
    if (backAskPrice !== undefined && backAskQty > 0) {
      console.log(this.symbol, 'Back', backAskQty, 'Ask', backAskPrice, backAskID.toString());
      const whaleAskTx = await spotMarket.makePlaceOrderTransaction(this.connection, {
        owner: this.owner.publicKey,
        payer: askAccount,
        side: 'sell',
        price: backAskPrice,
        size: backAskQty,
        orderType: 'limit',
        clientId: backAskID,
        selfTradeBehavior: 'abortTransaction',
      });
      gammaOrders.add(whaleAskTx.transaction);
    }

    try {
      await sendAndConfirmTransaction(this.connection, setPriorityFee(gammaOrders), [this.owner]);
    } catch (err) {
      console.log(this.symbol, 'Gamma Order', err, err.stack);
    }
    console.log(`${this.symbol} Gamma Spread % ${((priceAsk - priceBid) / fairValue) * 100} \
    Liquidity $ ${(amountGamma * 2 + backBidQty + backAskQty) * fairValue}`);

    // At the base level only, wait for the scalp to fill.
    if (gammaScalpCount === 1) {
      await waitForFill((_) => gammaScalpCount === GAMMA_CYCLES, SCALPER_WINDOW_SEC);

      // TODO: Remove this logging unless necessary. It is not showing new actionable info.
      const scalpPnL = (
        (1 + 1 / (2 * GAMMA_CYCLES)) * (gammaScalpCount - 1) * stdDevSpread * fairValue)
        * netGamma * gammaScalpCount
        + ((1 + 1 / (2 * GAMMA_CYCLES)) * (gammaScalpCount - 1) * stdDevSpread * fairValue)
        * gammaFillQty;
      const thetaPnL = getDIPTheta(dipProduct, fairValue, this.symbol)
        / ((24 * 60 * 60) / SCALPER_WINDOW_SEC);
      const estTotalPnL = scalpPnL + thetaPnL;
      console.log(
        `${this.symbol} Estimated Total PnL ${estTotalPnL} Scalp PnL ${scalpPnL} \
        Theta PnL ${thetaPnL} Total Scalps ${gammaScalpCount - 1}`,
      );
    }
  }
}

export default Scalper;
