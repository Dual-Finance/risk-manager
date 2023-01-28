import WebSocket from 'ws';
import {
  Config, getMarketByBaseSymbolAndKind, GroupConfig, MangoAccount, MangoClient, MangoCache,
  PerpMarket, MangoGroup, PerpEventLayout, FillEvent, MarketConfig,
} from '@blockworks-foundation/mango-client';
import {
  Keypair, Commitment, Connection, PublicKey, Account, Transaction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import { Market } from '@project-serum/serum';
import { BN } from '@project-serum/anchor';
import { Jupiter } from '@jup-ag/core';
import configFile from './ids.json';
import {
  networkName, THEO_VOL_MAP, maxNotional, twapIntervalSec, scalperWindowSec,
  ZSCORE, MinContractSize, TickSize, FILLS_URL, IS_DEV, gammaThreshold,
  maxDeltaHedges, DELTA_OFFSET, MANGO_DOWNTIME_THRESHOLD_MIN,
  perpFundingRateThreshold, gammaCycles, MinOpenBookSize, OPENBOOK_FORK_ID,
  treasuryPositions, slippageMax, gammaCompleteThresholdPct, cluster,
  maxOrderBookSearchDepth, maxBackGammaMultiple, API_URL, MODE_BY_SYMBOL,
  whaleMaxSpread, ScalperMode,
} from './config';
import { CallOrPut, DIPDeposit, SYMBOL } from './common';
import { readKeypair, sleepExact, sleepRandom } from './utils';
import { SerumVialClient, SerumVialTradeMessage, tradeMessageToString } from './serumVial';
import {
  jupiterHedge, cancelTxOpenBookOrders, getDIPDelta, getDIPGamma, getDIPTheta,
  getFairValue, getPayerAccount, getSpotDelta, loadPrices, orderSpliceMango,
  liquidityCheckAndNumSplices, settleOpenBook, setPriorityFee, waitForFill,
  findMaxStrike, findMinStrike, findNearestStrikeType,
} from './scalper_utils';
import { OPENBOOK_MKT_MAP } from './constants';

class Scalper {
  client: MangoClient;
  connection: Connection;
  groupConfig: GroupConfig;
  config: Config;
  owner: Keypair;
  symbol: SYMBOL;
  impliedVol: number;
  minSize: number;
  minSpotSize: number;
  tickSize: number;
  perpMarketConfig: MarketConfig;
  marketIndex: number;
  deltaOffset: number;
  zScore: number;
  mode: ScalperMode;
  openBookAccount: string;
  serumVialClient: SerumVialClient;

  constructor(symbol: SYMBOL) {
    // Setup Client
    this.config = new Config(configFile);
    this.groupConfig = this.config.getGroupWithName(networkName) as GroupConfig;
    this.connection = new Connection(
      API_URL,
      'processed' as Commitment,
    );
    this.client = new MangoClient(
      this.connection,
      this.groupConfig.mangoProgramId,
    );

    // Order Authority
    this.owner = Keypair.fromSecretKey(Uint8Array.from(readKeypair()));

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
    console.log(this.symbol, 'Choosing Market to Hedge');
    this.perpMarketConfig = getMarketByBaseSymbolAndKind(
      this.groupConfig,
      this.symbol,
      'perp',
    );

    // Add Any Treasury Positions from Staking Options
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

    this.marketIndex = this.perpMarketConfig.marketIndex;
    if (this.marketIndex === undefined) {
      console.log('No Mango Market Exists. Run OpenBook');
      await this.scalperOpenBook(dipProduct);
      return;
    }

    // Setup for scalping
    const mangoGroup: MangoGroup = await this.client.getMangoGroup(
      this.groupConfig.publicKey,
    );
    const perpMarket: PerpMarket = await mangoGroup.loadPerpMarket(
      this.connection,
      this.marketIndex,
      this.perpMarketConfig.baseDecimals,
      this.perpMarketConfig.quoteDecimals,
    );

    // Check if Mango is live
    if ((Date.now() - perpMarket.lastUpdated.toNumber() * 1_000)
      / (1_000 * 60) > MANGO_DOWNTIME_THRESHOLD_MIN) {
      console.log(this.symbol, 'Mango Down! Last Updated:', new Date(perpMarket.lastUpdated.toNumber() * 1_000));
      await this.scalperOpenBook(dipProduct);
    } else {
      await this.scalperMango(dipProduct);
    }
  }

  async scalperMango(dipProduct: DIPDeposit[]): Promise<void> {
    console.log(this.symbol, 'Hedging on Mango');
    this.perpMarketConfig = getMarketByBaseSymbolAndKind(
      this.groupConfig,
      this.symbol,
      'perp',
    );
    this.marketIndex = this.perpMarketConfig.marketIndex;

    // Setup for scalping
    const mangoGroup: MangoGroup = await this.client.getMangoGroup(this.groupConfig.publicKey);
    const perpMarket: PerpMarket = await mangoGroup.loadPerpMarket(
      this.connection,
      this.marketIndex,
      this.perpMarketConfig.baseDecimals,
      this.perpMarketConfig.quoteDecimals,
    );

    const spotMarket = await Market.load(
      this.connection,
      new PublicKey(OPENBOOK_MKT_MAP.get(this.symbol)),
      undefined,
      OPENBOOK_FORK_ID,
    );

    // Open Mango Websocket
    const fillFeed = new WebSocket(FILLS_URL!);
    fillFeed.onopen = (_) => {
      console.log('Connected to Mango Websocket', new Date().toUTCString());
    };
    fillFeed.onerror = (error) => {
      console.log(`Websocket Error ${error.message}`);
    };

    try {
      await this.deltaHedge(
        dipProduct,
        mangoGroup,
        perpMarket,
        spotMarket,
        fillFeed,
        1,
      );
      await this.gammaScalp(
        dipProduct,
        mangoGroup,
        perpMarket,
        fillFeed,
        1,
      );
    } catch (err) {
      console.log(this.symbol, 'Main Error', err, err.stack);
    }
  }

  async deltaHedge(
    dipProduct: DIPDeposit[],
    mangoGroup: MangoGroup,
    perpMarket: PerpMarket,
    spotMarket: Market,
    fillFeed: WebSocket,
    deltaHedgeCount: number,
  ): Promise<void> {
    const [mangoCache]: MangoCache[] = await loadPrices(mangoGroup, this.connection);
    const mangoAccount: MangoAccount = (
      await this.client.getMangoAccountsForOwner(mangoGroup, this.owner.publicKey)
    )[0];

    // Cleanup from previous runs.
    await this.cancelStaleOrders(mangoAccount, mangoGroup, perpMarket);

    // Avoid unsafe recursion.
    if (deltaHedgeCount > maxDeltaHedges) {
      console.log(this.symbol, 'Max Hedges exceeded without getting to neutral');
      return;
    }

    // Calc DIP delta for new position
    const fairValue = mangoGroup.getPrice(this.marketIndex, mangoCache).toNumber();
    const dipTotalDelta = getDIPDelta(dipProduct, fairValue, this.symbol);

    // Get Mango delta position
    const perpAccount = mangoAccount.perpAccounts[this.marketIndex];
    const mangoPerpDelta = perpAccount.getBasePositionUi(perpMarket);
    const mangoSpotDelta = (
      mangoAccount.getAvailableBalance(mangoGroup, mangoCache, this.marketIndex)
        .toNumber() / 10 ** this.perpMarketConfig.baseDecimals);

    // Get all spot positions Option Vault, Risk Manager, Mango Tester
    const spotDelta = await getSpotDelta(this.connection, this.symbol);

    // Get Total Delta Position to hedge
    let hedgeDeltaTotal = IS_DEV
      ? 0.1
      : mangoPerpDelta + dipTotalDelta + spotDelta + mangoSpotDelta + this.deltaOffset;

    // Check whether we need to hedge.
    const dipTotalGamma = getDIPGamma(dipProduct, fairValue, this.symbol);
    const stdDevSpread = (this.impliedVol / Math.sqrt((365 * 24 * 60 * 60)
    / scalperWindowSec)) * this.zScore;
    const slippageTolerance = Math.min(stdDevSpread / 2, slippageMax.get(this.symbol));
    const deltaThreshold = Math.max(
      dipTotalGamma * stdDevSpread * fairValue * gammaThreshold,
      this.minSize,
    );
    if (Math.abs(hedgeDeltaTotal * fairValue) < (deltaThreshold * fairValue)) {
      console.log(this.symbol, 'Delta Netural <', deltaThreshold);
      return;
    }
    console.log(this.symbol, 'Above delta threshold:', deltaThreshold);

    // Funding Rate to determine spot or perp order
    const bidSide = await perpMarket.loadBids(this.connection);
    const askSide = await perpMarket.loadAsks(this.connection);
    const fundingRate = (24 * 365)
    * perpMarket.getCurrentFundingRate(mangoGroup, mangoCache, this.marketIndex, bidSide, askSide);
    const buySpot = fundingRate > perpFundingRateThreshold;
    const sellSpot = -fundingRate < perpFundingRateThreshold;
    const hedgeSide = hedgeDeltaTotal < 0 ? 'buy' : 'sell'; // TODO Make Enum everywhere
    let hedgeProduct: string;
    if (hedgeSide === 'buy' && buySpot) {
      hedgeProduct = '-SPOT';
    } else if (hedgeSide === 'sell' && sellSpot) {
      hedgeProduct = '-SPOT';
    } else {
      hedgeProduct = '-PERP';
    }

    console.log(
      this.symbol,
      'Target Delta Hedge:',
      hedgeSide,
      hedgeProduct,
      -hedgeDeltaTotal,
      'DIP Δ:',
      dipTotalDelta,
      'Mango Perp Δ:',
      mangoPerpDelta,
      'Mango Spot Δ:',
      mangoSpotDelta,
      'Spot Δ:',
      spotDelta,
      'Offset Δ',
      this.deltaOffset,
      'Fair Value:',
      fairValue,
    );

    // Determine what price to use for hedging depending on allowable slippage.
    const hedgePrice = hedgeDeltaTotal < 0
      ? fairValue * (1 + slippageTolerance) : fairValue * (1 - slippageTolerance);

    // Break up order depending on whether the book can support it
    const bookSide = hedgeDeltaTotal < 0 ? askSide : bidSide;
    const hedgeDeltaClip = hedgeDeltaTotal
      / orderSpliceMango(
        hedgeDeltaTotal,
        fairValue,
        maxNotional.get(this.symbol),
        slippageTolerance,
        bookSide,
        perpMarket,
      );

    // Unique identifier for delta order.
    const deltaOrderId = new Date().getTime() * 2;

    // Start listening for Delta Hedge Fills
    const deltaFillListener = async (event: WebSocket.MessageEvent) => {
      const parsedEvent = JSON.parse(event.data as string);
      if (parsedEvent.status === 'New' && parsedEvent.market === this.symbol.concat(hedgeProduct)) {
        const fillBytes: Buffer = Buffer.from(parsedEvent.event, 'base64');
        const fillEvent: FillEvent = PerpEventLayout.decode(fillBytes).fill;
        if (
          (fillEvent.makerClientOrderId.toString() === deltaOrderId.toString())
          || (fillEvent.takerClientOrderId.toString() === deltaOrderId.toString())
        ) {
          const fillQty = (hedgeSide === 'buy' ? 1 : -1) * fillEvent.quantity.toNumber() * this.minSize;
          const fillPrice = fillEvent.price.toNumber() * this.tickSize;
          hedgeDeltaTotal += fillQty;
          console.log(
            this.symbol,
            'Delta Filled',
            hedgeSide,
            hedgeProduct,
            'Qty',
            fillQty,
            'Price',
            fillPrice,
            'Remaining',
            hedgeDeltaTotal,
            'ID',
            deltaOrderId,
            new Date().toUTCString(),
          );
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

    console.log(
      this.symbol,
      hedgeSide,
      hedgeProduct,
      Math.abs(hedgeDeltaClip),
      'Limit:',
      hedgePrice,
      '#',
      deltaHedgeCount,
      'ID',
      deltaOrderId,
    );
    try {
      if (hedgeProduct === '-SPOT') {
        await this.client.placeSpotOrder2(
          mangoGroup,
          mangoAccount,
          spotMarket,
          this.owner,
          hedgeSide,
          hedgePrice,
          Math.abs(hedgeDeltaClip),
          'limit',
          new BN(deltaOrderId),
          true,
        );
      } else {
        await this.client.placePerpOrder2(
          mangoGroup,
          mangoAccount,
          perpMarket,
          this.owner,
          hedgeSide,
          hedgePrice,
          Math.abs(hedgeDeltaClip),
          {
            orderType: 'limit',
            clientOrderId: deltaOrderId,
          },
        );
      }
    } catch (err) {
      console.log(this.symbol, 'Failed to place order', err, err.stack);
    }

    // Wait the twapInterval of time to see if the position gets to neutral.
    console.log(this.symbol, 'Scan Delta Fills for ~', twapIntervalSec, 'seconds');
    await sleepRandom(twapIntervalSec);

    // Cleanup listener.
    fillFeed.removeEventListener('message', deltaFillListener);

    // Recursive call. This happens when we are not getting fills to get to neutral.
    await this.deltaHedge(
      dipProduct,
      mangoGroup,
      perpMarket,
      spotMarket,
      fillFeed,
      deltaHedgeCount + 1,
    );
  }

  async gammaScalp(
    dipProduct: DIPDeposit[],
    mangoGroup: MangoGroup,
    perpMarket: PerpMarket,
    fillFeed: WebSocket,
    gammaScalpCount: number,
  ): Promise<void> {
    const [mangoCache]: MangoCache[] = await loadPrices(
      mangoGroup,
      this.connection,
    );
    const mangoAccount: MangoAccount = (
      await this.client.getMangoAccountsForOwner(mangoGroup, this.owner.publicKey))[0];

    // Makes the recursive gamma scalps safer. Rerun will clear any stale
    // orders. Allows only 2 gamma orders at any time
    await this.cancelStaleOrders(mangoAccount, mangoGroup, perpMarket);

    // Avoid unsafe recursion.
    if (gammaScalpCount > gammaCycles) {
      console.log(this.symbol, 'Maximum scalps acheived!', gammaScalpCount - 1, 'Wait for Rerun');
      return;
    }

    const fairValue = mangoGroup.getPrice(this.marketIndex, mangoCache).toNumber();
    const dipTotalGamma = getDIPGamma(dipProduct, fairValue, this.symbol);

    // Calc scalperWindow std deviation spread from zScore & IV for gamma levels
    const stdDevSpread = (this.impliedVol
    / Math.sqrt((365 * 24 * 60 * 60) / scalperWindowSec))
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

    fillFeed.removeAllListeners('message');
    const gammaFillListener = (event) => {
      const parsedEvent = JSON.parse(event.data);
      if (
        parsedEvent.status === 'New'
        && parsedEvent.market === this.symbol.concat('-PERP')
      ) {
        const fillBytes = Buffer.from(parsedEvent.event, 'base64');
        const fillEvent: FillEvent = PerpEventLayout.decode(fillBytes).fill;
        const bidFill = fillEvent.makerClientOrderId.toString() === gammaBidID.toString()
          || fillEvent.takerClientOrderId.toString() === gammaBidID.toString();
        const askFill = fillEvent.makerClientOrderId.toString() === gammaAskID.toString()
          || fillEvent.takerClientOrderId.toString() === gammaAskID.toString();
        if (bidFill || askFill) {
          console.log(this.symbol, 'Gamma Filled', bidFill ? 'BID' : 'ASK', new Date().toUTCString());
          fillFeed.removeEventListener('message', gammaFillListener);
          // Do not need to remove the unfilled order since it will be cancelled
          // in the recursive call.
          this.gammaScalp(
            dipProduct,
            mangoGroup,
            perpMarket,
            fillFeed,
            gammaScalpCount + 1,
          );
        }
      }
    };
    if (fillFeed.readyState === WebSocket.OPEN) {
      fillFeed.addEventListener('message', gammaFillListener);
      console.log(this.symbol, 'Listening For Gamma Scalps');
    } else {
      console.log(this.symbol, 'Websocket State', fillFeed.readyState);
    }

    // Place Gamma scalp bid & offer
    try {
      await this.client.placePerpOrder2(
        mangoGroup,
        mangoAccount,
        perpMarket,
        this.owner,
        'buy',
        gammaBid,
        netGamma,
        { orderType: 'postOnlySlide', clientOrderId: gammaBidID },
      );
      console.log(this.symbol, 'Gamma Bid', gammaBid, 'ID', gammaBidID);
      await this.client.placePerpOrder2(
        mangoGroup,
        mangoAccount,
        perpMarket,
        this.owner,
        'sell',
        gammaAsk,
        netGamma,
        { orderType: 'postOnlySlide', clientOrderId: gammaAskID },
      );
      console.log(this.symbol, 'Gamma Ask', gammaAsk, 'ID', gammaAskID);
    } catch (err) {
      console.log(this.symbol, 'Gamma Error', err, err.stack);
    }
    console.log(
      this.symbol,
      'Market Spread %',
      ((gammaAsk - gammaBid) / fairValue) * 100,
      'Liquidity $',
      netGamma * 2 * fairValue,
    );

    // Sleep for the max time of the reruns then kill thread
    await sleepExact(scalperWindowSec);
    console.log(this.symbol, 'Remove stale gamma fill listener', gammaBidID, gammaAskID);
    fillFeed.removeEventListener('message', gammaFillListener);
  }

  async cancelStaleOrders(
    mangoAccount: MangoAccount,
    mangoGroup: MangoGroup,
    perpMarket: PerpMarket,
  ): Promise<void> {
    const openOrders = mangoAccount.getPerpOpenOrders();
    if (openOrders.length > 0) {
      for (const order of openOrders) {
        if (order.marketIndex === this.marketIndex) {
          try {
            console.log(this.symbol, 'Canceling Orders');
            await this.client.cancelAllPerpOrders(
              mangoGroup,
              [perpMarket],
              mangoAccount,
              this.owner,
            );
          } catch (err) {
            console.log(err, err.stack);
          }
          break;
        }
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
          1,
          spotMarket,
          jupiter,
        );
      } catch (err) {
        console.log(this.symbol, 'Main Delta Error', err.stack);
      }
      this.serumVialClient.removeAnyListeners();
    }

    try {
      await this.gammaScalpOpenBook(
        dipProduct,
        1,
        0,
        spotMarket,
        jupiter,
      );
      // TODO: OpenBook settlement to move to mango if needed
    } catch (err) {
      console.log(this.symbol, 'Main Gamma Error', err.stack);
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
    const cancelDelta = (
      await cancelTxOpenBookOrders(this.connection, this.owner, spotMarket, this.symbol));
    if (cancelDelta !== undefined) {
      try {
        await sendAndConfirmTransaction(this.connection, setPriorityFee(cancelDelta), [this.owner]);
      } catch (err) {
        console.log(this.symbol, 'Cancel OpenBook Orders', err, err.stack);
      }
    }

    // Settle Funds
    try {
      const settleTransaction = await settleOpenBook(this.connection, this.owner, spotMarket, this.symbol, 'USDC');
      // If there are funds ready to be settled, settle them
      if (settleTransaction !== undefined) {
        await sendAndConfirmTransaction(
          this.connection,
          setPriorityFee(settleTransaction),
          [this.owner],
        );
      }
    } catch (err) {
      console.log(this.symbol, 'Settling Funds', err, err.stack);
    }

    // Prevent too much recursion.
    if (deltaHedgeCount > maxDeltaHedges) {
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
        if (message.makerClientId === deltaID.toString()) {
          console.log(this.symbol, 'Delta Fill Maker!', hedgeSide, tradeMessageToString(message));
        } else if (message.takerClientId === deltaID.toString()) {
          console.log(this.symbol, 'Delta Fill Taker!', hedgeSide, tradeMessageToString(message));
        }
        const fillQty = (hedgeSide === 'buy' ? 1 : -1) * message.size;
        hedgeDeltaTotal += fillQty;
      },
    );

    // Find fair value.
    console.log(this.symbol, 'Loading Fair Value...');
    let fairValue = await getFairValue(this.connection, spotMarket, this.symbol, jupiter);
    for (let i = 0; i < maxDeltaHedges; i++) {
      if (fairValue === 0) {
        console.log(this.symbol, 'No Prices Refreshing Delta Hedge', i + 1, 'After', twapIntervalSec, 'Seconds');
        await sleepExact(twapIntervalSec);
        fairValue = await getFairValue(this.connection, spotMarket, this.symbol, jupiter);
      }
    }
    if (fairValue === 0) {
      console.log(this.symbol, 'No Robust Pricing. Exiting Delta Hedge', deltaHedgeCount);
      return;
    }

    // Get the DIP Delta
    const dipTotalDelta = getDIPDelta(dipProduct, fairValue, this.symbol);

    // Get all spot positions Option Vault, Risk Manager, Mango Tester
    const spotDelta = await getSpotDelta(this.connection, this.symbol);

    // Get Total Delta Position to hedge. Use .1 for DEV to force that it does something.
    hedgeDeltaTotal = IS_DEV ? 0.1 : dipTotalDelta + spotDelta + this.deltaOffset;
    hedgeSide = hedgeDeltaTotal < 0 ? 'buy' : 'sell';
    // TODO: Mango delta positions
    console.log(
      this.symbol,
      'Target Delta Hedge:',
      hedgeSide,
      'SPOT',
      -hedgeDeltaTotal,
      'DIP Δ:',
      dipTotalDelta,
      'Mango Perp Δ:',
      0,
      'Mango Spot Δ:',
      0,
      'Spot Δ:',
      spotDelta,
      'Offset Δ',
      this.deltaOffset,
      'Fair Value:',
      fairValue,
    );

    // Check whether we need to hedge.
    const dipTotalGamma = getDIPGamma(dipProduct, fairValue, this.symbol);
    const stdDevSpread = (this.impliedVol / Math.sqrt((365 * 24 * 60 * 60) / scalperWindowSec))
    * this.zScore;
    const slippageTolerance = Math.min(stdDevSpread / 2, slippageMax.get(this.symbol));
    const deltaThreshold = Math.max(
      dipTotalGamma * stdDevSpread * fairValue * gammaThreshold,
      this.minSpotSize,
    );
    let hedgePrice = hedgeDeltaTotal < 0
      ? fairValue * (1 + slippageTolerance)
      : fairValue * (1 - slippageTolerance);
    if (Math.abs(hedgeDeltaTotal * fairValue) < (deltaThreshold * fairValue)) {
      console.log(this.symbol, 'Delta Netural Within', deltaThreshold);
      return;
    }
    // Adjust delta for slippage allowed
    const slippageDIPDelta = getDIPDelta(dipProduct, hedgePrice, this.symbol);
    const dipDeltaDiff = slippageDIPDelta - dipTotalDelta;
    hedgeDeltaTotal += dipDeltaDiff;
    console.log(this.symbol, 'Adjust Slippage Delta by', dipDeltaDiff, 'to', -hedgeDeltaTotal);
    if (((-hedgeDeltaTotal * fairValue) < (deltaThreshold * fairValue) && (hedgeSide === 'buy'))
       || ((-hedgeDeltaTotal * fairValue) > (deltaThreshold * fairValue) && (hedgeSide === 'sell'))) {
      console.log(this.symbol, 'Delta Netural: Slippage', deltaThreshold);
      return;
    }
    console.log(this.symbol, 'Outside delta threshold:', Math.abs(hedgeDeltaTotal), 'vs.', deltaThreshold);

    // Load order book data
    const bids = await spotMarket.loadBids(this.connection);
    const asks = await spotMarket.loadAsks(this.connection);
    const [bidTOB, _bidSize] = bids.getL2(1)[0];
    const [askTOB, _askSize] = asks.getL2(1)[0];
    const spreadDelta = hedgeDeltaTotal < 0
      ? ((askTOB - hedgePrice) / hedgePrice) * 100
      : ((bidTOB - hedgePrice) / hedgePrice) * 100;
    // Check order book depth and splice order
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
      if (spliceFactor > 0) {
        console.log(this.symbol, 'Not enough liquidity! Try Jupiter. Adjust Price', hedgePrice, 'Splice', spliceFactor);
        // Check on jupiter and sweep price
        const jupValues = await jupiterHedge(hedgeSide, this.symbol, 'USDC', hedgeDeltaTotal, hedgePrice, jupiter);
        if (jupValues !== undefined) {
          const { setupTransaction, swapTransaction, cleanupTransaction } = jupValues.txs;
          for (const jupTx of [setupTransaction, swapTransaction, cleanupTransaction].filter(
            Boolean,
          )) {
            if (!jupTx) {
              continue;
            }
            const txid = await sendAndConfirmTransaction(this.connection, jupTx, [this.owner]);
            if (swapTransaction) {
              const spotDeltaUpdate = jupValues.qty;
              hedgeDeltaTotal += spotDeltaUpdate;
              console.log(
                this.symbol,
                'Jupiter Hedge via',
                jupValues.venue,
                'Price',
                jupValues.price,
                'Qty',
                jupValues.qty,
                `https://solana.fm/tx/${txid}${cluster?.includes('devnet') ? '?cluster=devnet' : ''}`,
              );
            }
          }
          if (Math.abs(hedgeDeltaTotal * fairValue) < (deltaThreshold * fairValue)) {
            console.log(this.symbol, 'Delta Netural: Jupiter Hedge');
            return;
          }
          console.log(this.symbol, 'Adjust', hedgeSide, 'Price', hedgePrice, 'to', jupValues.price, 'Remaining Qty', hedgeDeltaTotal);
          hedgePrice = jupValues.price;
        } else {
          console.log(this.symbol, 'No Jupiter Route Found Better than', hedgePrice);
        }
        hedgeDeltaClip = hedgeDeltaTotal / spliceFactor;
      } else {
        console.log(this.symbol, 'Sufficient liquidity. Sweep OpenBook', spliceFactor);
      }
    } catch (err) {
      console.log(this.symbol, 'Jupiter Route', err, err.stack);
    }

    try {
      const amountDelta = Math.round(
        Math.abs(hedgeDeltaClip) * (1 / this.minSpotSize),
      ) / (1 / this.minSpotSize);
      const priceDelta = Math.floor(
        Math.abs(hedgePrice) * (1 / this.tickSize),
      ) / (1 / this.tickSize);
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
    } catch (err) {
      console.log(this.symbol, 'Delta Hedge', err, err.stack);
    }

    // Rest single order & do not refresh if the hedge should be completed in a single clip
    if (spliceFactor === 1) {
      const netHedgePeriod = twapIntervalSec * maxDeltaHedges;
      console.log(this.symbol, 'Scan Delta Fills for ~', netHedgePeriod, 'seconds');
      for (let i = 0; i < maxDeltaHedges; i++) {
        // Should fix this, but the unsafe behavior is actually used.
        // eslint-disable-next-line no-loop-func
        await waitForFill(() => (
          Math.abs(hedgeDeltaTotal * fairValue) < (this.minSpotSize * fairValue)), twapIntervalSec);
        if (Math.abs(hedgeDeltaTotal * fairValue) < (this.minSpotSize * fairValue)) {
          console.log(this.symbol, 'Delta Hedge Complete: SerumVial');
          return;
        }
      }
      console.log(
        this.symbol,
        'OpenBook Delta Hedge Timeout. Spread %',
        spreadDelta,
        '> Slippage %',
        slippageTolerance * 100,
      );
    } else {
      // Wait the twapInterval of time to see if the position gets to neutral.
      console.log(this.symbol, 'Scan Delta Fills for ~', twapIntervalSec, 'seconds');
      await waitForFill(
        (_) => Math.abs(hedgeDeltaTotal * fairValue) < (this.minSpotSize * fairValue),
        twapIntervalSec,
      );
      if (Math.abs(hedgeDeltaTotal * fairValue) < (this.minSpotSize * fairValue)) {
        console.log(this.symbol, 'Delta Hedge Complete: SerumVial');
        return;
      }
      console.log(this.symbol, 'OpenBook Delta Hedge Refresh', deltaHedgeCount);
      this.serumVialClient.removeAnyListeners();
      await this.deltaHedgeOpenBook(
        dipProduct,
        deltaHedgeCount + 1,
        spotMarket,
        jupiter,
      );
    }
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
        if (message.makerClientId === backBidID.toString()) {
          console.log(this.symbol, 'Back Bid Fill!!!', tradeMessageToString(message));
          return;
        } if (message.makerClientId === backAskID.toString()) {
          console.log(this.symbol, 'Back Ask Fill!!!', tradeMessageToString(message));
          return;
        }
        gammaFillQty += Math.abs(message.size);
        if (message.makerClientId === bidID.toString()) {
          console.log(this.symbol, 'Gamma Bid Fill!', tradeMessageToString(message));
        } else if (message.makerClientId === askID.toString()) {
          console.log(this.symbol, 'Gamma Ask Fill!', tradeMessageToString(message));
        } else {
          console.log(this.symbol, 'Gamma Scalp Fill From Taker?!', tradeMessageToString(message));
        }
        if (gammaFillQty > amountGamma * gammaCompleteThresholdPct) {
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
    const cancelGammaStart = (
      await cancelTxOpenBookOrders(this.connection, this.owner, spotMarket, this.symbol));
    if (cancelGammaStart !== undefined) {
      try {
        await sendAndConfirmTransaction(
          this.connection,
          setPriorityFee(cancelGammaStart),
          [this.owner],
        );
      } catch (err) {
        console.log(this.symbol, 'Cancel OpenBook Orders', err, err.stack);
      }
    }

    // Settle Funds
    try {
      await settleOpenBook(this.connection, this.owner, spotMarket, this.symbol, 'USDC');
    } catch (err) {
      console.log(this.symbol, 'Settling Funds', err, err.stack);
    }

    // Prevent too much recursion.
    if (gammaScalpCount > gammaCycles) {
      console.log(this.symbol, 'Maximum scalps acheived!', gammaScalpCount - 1, 'Wait for Rerun');
      return;
    }

    // Find fair value.
    console.log(this.symbol, 'Loading Fair Value For Scalp', gammaScalpCount);
    let fairValue: number;
    if (priorFillPrice > 0) {
      fairValue = priorFillPrice;
      console.log(this.symbol, 'Fair Value Set to Prior Fill', fairValue);
    } else {
      fairValue = await getFairValue(this.connection, spotMarket, this.symbol, jupiter);
    }
    for (let i = 0; i < gammaCycles; i++) {
      if (fairValue === 0) {
        console.log(this.symbol, 'No Prices. Refreshing Gamma Scalp', i + 1, 'After', twapIntervalSec, 'Seconds');
        await sleepExact(twapIntervalSec);
        fairValue = await getFairValue(this.connection, spotMarket, this.symbol, jupiter);
      }
    }
    if (fairValue === 0) {
      console.log(this.symbol, 'No Robust Pricing. Exiting Gamma Scalp', gammaScalpCount);
      return;
    }
    const dipTotalGamma = getDIPGamma(dipProduct, fairValue, this.symbol);

    // Calc scalperWindow std deviation spread from zScore & IV for gamma levels
    const stdDevSpread = (this.impliedVol / Math.sqrt((365 * 24 * 60 * 60) / scalperWindowSec))
    * this.zScore;
    const netGamma = IS_DEV
      ? Math.max(0.01, dipTotalGamma * stdDevSpread * fairValue)
      : dipTotalGamma * stdDevSpread * fairValue;

    const widenSpread = (gammaScalpCount - 1) / gammaCycles;
    let gammaBid = fairValue * (1 - stdDevSpread - stdDevSpread * widenSpread);
    let gammaAsk = fairValue * (1 + stdDevSpread + stdDevSpread * widenSpread);

    // Adjust gamma prices based on strike
    // TODO: Determine if should always have this on or only on products we can't get delta neutral
    if (this.mode === ScalperMode.GammaBackStrikeAdjustment) {
      const dipTotalDelta = getDIPDelta(dipProduct, fairValue, this.symbol);
      const spotDelta = await getSpotDelta(this.connection, this.symbol);
      const isShort = dipTotalDelta + spotDelta + this.deltaOffset < 0;
      // TODO: Create a gamma table to find relevant long & short strikes
      const nearStrikeType = findNearestStrikeType(dipProduct, fairValue);
      console.log(this.symbol, 'Delta Position', dipTotalDelta + spotDelta + this.deltaOffset, nearStrikeType, 'isShort', isShort);
      if (nearStrikeType === CallOrPut.Put) {
        const maxStrike = findMaxStrike(dipProduct);
        const isOTM = (fairValue > maxStrike);
        if (isOTM && isShort) {
          gammaBid = Math.min(
            maxStrike * (1 - stdDevSpread - stdDevSpread * widenSpread),
            gammaBid,
          );
          console.log('Strike Adjusted Gamma Bid', gammaBid, maxStrike);
        }
        if (!isOTM && isShort) {
          gammaAsk = Math.max(
            maxStrike * (1 + stdDevSpread + stdDevSpread * widenSpread),
            gammaAsk,
          );
          console.log('Strike Adjusted Gamma Ask', gammaAsk, maxStrike);
        }
      }
      // TODO: Check All Call Adjustment logic
      if (nearStrikeType === CallOrPut.Call) {
        const minStrike = findMinStrike(dipProduct);
        const isOTM = (fairValue < minStrike);
        if (isOTM && !isShort) {
          gammaAsk = Math.max(
            minStrike * (1 + stdDevSpread + stdDevSpread * widenSpread),
            gammaAsk,
          );
          console.log('Strike Adjusted Gamma Ask', gammaAsk, minStrike);
        }
        if (!isOTM && !isShort) {
          gammaBid = Math.min(
            minStrike * (1 - stdDevSpread - stdDevSpread * widenSpread),
            gammaBid,
          );
          console.log('Strike Adjusted Gamma Bid', gammaBid, minStrike);
        }
      }
    }

    console.log(this.symbol, 'Position Gamma Γ:', netGamma, 'Fair Value', fairValue);
    if ((netGamma * fairValue) < (this.minSpotSize * fairValue)) {
      console.log(this.symbol, 'Gamma Hedge Too Small');
      return;
    }

    // Find the prices at which whale qty is bid & offered
    const bids = await spotMarket.loadBids(this.connection);
    const numBids = bids.getL2(maxOrderBookSearchDepth).length;
    const dimQty = maxBackGammaMultiple * netGamma;
    let bidDepth = 0;
    let whaleBidPrice : number;
    for (let i = 0; i < numBids; i++) {
      bidDepth = bids.getL2(i + 1)[i][1] + bidDepth;
      if (bidDepth >= dimQty) {
        [whaleBidPrice] = bids.getL2(i + 1)[i];
        break;
      }
    }
    const asks = await spotMarket.loadAsks(this.connection);
    const numAsks = asks.getL2(maxOrderBookSearchDepth).length;
    let askDepth = 0;
    let whaleAskPrice : number;
    for (let i = 0; i < numAsks; i++) {
      askDepth = asks.getL2(i + 1)[i][1] + askDepth;
      if (askDepth >= dimQty) {
        [whaleAskPrice] = asks.getL2(i + 1)[i];
        break;
      }
    }
    console.log(`${this.symbol} Whale Bid: ${whaleBidPrice} Ask ${whaleAskPrice} \
Spread % ${((whaleAskPrice - whaleBidPrice) / fairValue) * 100}`);

    amountGamma = Math.round(
      Math.abs(netGamma) * (1 / this.minSpotSize),
    ) / (1 / this.minSpotSize);
    const priceBid = Math.floor(Math.abs(gammaBid) * (1 / this.tickSize)) / (1 / this.tickSize);
    const priceAsk = Math.floor(Math.abs(gammaAsk) * (1 / this.tickSize)) / (1 / this.tickSize);
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
        size: amountGamma,
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
      ? Math.max(Math.floor(
        (whaleBidPrice + this.tickSize)
        * (1 / this.tickSize),
      ) / (1 / this.tickSize), gammaBid * (1 - whaleMaxSpread))
      : undefined;
    const backAskPrice = whaleAskDiff > gammaAsk - fairValue
      ? Math.min(Math.floor((
        whaleAskPrice - this.tickSize)
        * (1 / this.tickSize)) / (1 / this.tickSize), gammaAsk * (1 + whaleMaxSpread))
      : undefined;
    const whaleBidGammaQty = Math.min(
      netGamma * (maxBackGammaMultiple - 1),
      dipTotalGamma * whaleBidDiff - netGamma,
    );
    const whaleAskGammaQty = Math.min(
      netGamma * (maxBackGammaMultiple - 1),
      dipTotalGamma * whaleAskDiff - netGamma,
    );
    const backBidQty = Math.round(
      Math.abs(whaleBidGammaQty) * (1 / this.minSpotSize),
    ) / (1 / this.minSpotSize);
    const backAskQty = Math.round(
      Math.abs(whaleAskGammaQty) * (1 / this.minSpotSize),
    ) / (1 / this.minSpotSize);

    // Enter bid & offer if outside of range from gamma orders
    if (backBidPrice !== undefined) {
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
    if (backAskPrice !== undefined) {
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
    console.log(
      this.symbol,
      'Gamma Spread %',
      ((priceAsk - priceBid) / fairValue) * 100,
      'Liquidity $',
      (amountGamma * 2 + backBidQty + backAskQty) * fairValue,
    );
    if (gammaScalpCount === 1) {
      await waitForFill((_) => gammaScalpCount === gammaCycles, scalperWindowSec);
      const scalpPnL = (
        (1 + 1 / (2 * gammaCycles)) * (gammaScalpCount - 1) * stdDevSpread * fairValue)
        * netGamma * gammaScalpCount
        + ((1 + 1 / (2 * gammaCycles)) * (gammaScalpCount - 1) * stdDevSpread * fairValue)
        * gammaFillQty;
      const thetaPnL = getDIPTheta(dipProduct, fairValue, this.symbol)
        / ((24 * 60 * 60) / scalperWindowSec);
      const estTotalPnL = scalpPnL + thetaPnL;
      console.log(
        `${this.symbol} Estimated Total PnL ${estTotalPnL} Scalp PnL ${scalpPnL} \
Theta PnL ${thetaPnL} Total Scalps ${gammaScalpCount - 1}`,
      );
    }
  }
}

export default Scalper;
