import WebSocket from 'ws';
import {
  Keypair, Commitment, Connection, PublicKey, Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { Market } from '@project-serum/serum';
import { Jupiter } from '@jup-ag/core';
import { AnchorProvider, BN, Wallet } from '@coral-xyz/anchor';
import { StakingOptions } from '@dual-finance/staking-options';
import {
  MAX_NOTIONAL, TWAP_INTERVAL_SEC, SCALPER_WINDOW_SEC,
  Z_SCORE, MIN_CONTRACT_SIZE, TICK_SIZE, GAMMA_THRESHOLD, MAX_DELTA_HEDGES,
  DELTA_OFFSET, GAMMA_CYCLES, MIN_OPENBOOK_SIZE, OPENBOOK_FORK_ID,
  GAMMA_COMPLETE_THRESHOLD_PCT, CLUSTER, MAX_ORDER_BOOK_SEARCH_DEPTH,
  MAX_BACK_GAMMA_MULTIPLE, API_URL, SCALPER_MODE, WHALE_MAX_SPREAD,
  ORDER_SIZE_BUFFER_PCT, BACK_GAMMA_SPREAD_RATIO, MAX_LOAD_TIME, SLIPPAGE_MAX,
  THEO_VOL, 
} from './config';
import { CallOrPut, DIPDeposit, HedgeSide, SYMBOL, ScalperMode } from './common';
import {
  asyncCallWithTimeout, getRandomNumAround, readKeypair,
} from './utils';
import { SerumVialClient, SerumVialTradeMessage, tradeMessageToString } from './serumVial';
import {
  getDIPDelta, getDIPGamma, getDIPTheta, getPayerAccount,
  getWalletAndOpenbookSpotDelta, openBookLiquidityCheckAndNumSplices,
  tryToSettleOpenBook, setPriorityFee, waitForFill, findMaxStrike,
  findMinStrike, findNearestStrikeType, cancelOpenBookOrders,
  findFairValue, roundPriceToTickSize, roundQtyToMinOrderStep, getTreasuryPositions,
} from './scalper_utils';
import {
  NO_FAIR_VALUE, OPENBOOK_MKT_MAP, SEC_PER_YEAR, SUFFICIENT_BOOK_DEPTH,
} from './constants';
// eslint-disable-next-line import/no-cycle
import { loadMangoAndPickScalper } from './mango';
import { jupiterHedge } from './jupiter';

class Scalper {
  connection: Connection;
  owner: Keypair;
  symbol: SYMBOL;
  impliedVol: number;
  minSize: number;
  minSpotSize: number;
  tickSize: number;
  deltaOffset: number;
  zScore: number;
  mode: ScalperMode;
  openBookAccount: string;
  serumVialClient: SerumVialClient;
  provider: AnchorProvider;
  soHelper: StakingOptions;

  constructor(symbol: SYMBOL) {
    this.connection = new Connection(
      API_URL,
      'processed' as Commitment,
    );
    this.soHelper = new StakingOptions(API_URL);
    this.owner = Keypair.fromSecretKey(Uint8Array.from(readKeypair()));
    this.provider = new AnchorProvider(
      this.connection,
      new Wallet(this.owner),
      AnchorProvider.defaultOptions(),
    );

    this.symbol = symbol;
    this.impliedVol = THEO_VOL;
    this.minSize = MIN_CONTRACT_SIZE.get(symbol);
    this.minSpotSize = MIN_OPENBOOK_SIZE.get(symbol);
    this.tickSize = TICK_SIZE.get(symbol);
    this.deltaOffset = DELTA_OFFSET;
    this.zScore = Z_SCORE;
    this.mode = SCALPER_MODE;

    this.serumVialClient = new SerumVialClient();
    this.serumVialClient.openSerumVial();
  }

  async pickAndRunScalper(dipProduct: DIPDeposit[]): Promise<void> {
    await getTreasuryPositions(this.symbol, this.connection, dipProduct, this.soHelper);

    console.log(this.symbol, 'Choosing market to trade for', this.owner.publicKey.toBase58());

    if (this.mode === ScalperMode.Perp || this.mode === ScalperMode.PerpGamma) {
      await loadMangoAndPickScalper(dipProduct, this);
      return;
    }
    await this.scalperOpenBook(dipProduct);
  }

  async scalperOpenBook(dipProduct: DIPDeposit[]): Promise<void> {
    console.log(this.symbol, 'Hedging on OpenBook');

    this.serumVialClient.removeAnyListeners();
    let spotMarket: Market;
    try {
      spotMarket = await Market.load(
        this.connection,
        new PublicKey(OPENBOOK_MKT_MAP.get(this.symbol)),
        undefined,
        OPENBOOK_FORK_ID,
      );
    } catch (err) {
      console.log(this.symbol, 'No OpenBook market found', err);
      return;
    }

    if (this.mode === ScalperMode.Normal) {
      try {
        await this.deltaHedgeOpenBook(
          dipProduct,
          1 /* deltaHedgeCount */,
          spotMarket,
        );
        await this.gammaScalpOpenBook(
          dipProduct,
          1, /* gammaScalpCount */
          NO_FAIR_VALUE, /* priorFillPrice */
          spotMarket,
        );
      } catch (err) {
        console.log(this.symbol, 'Normal mode scalping error', err.stack);
      }
      this.serumVialClient.removeAnyListeners();
    } else {
      try {
        await this.gammaScalpOpenBook(
          dipProduct,
          1, /* gammaScalpCount */
          NO_FAIR_VALUE, /* priorFillPrice */
          spotMarket,
        );
      } catch (err) {
        console.log(this.symbol, 'scalperOpenBook gamma error', err.stack);
      }
    }
    console.log(this.symbol, 'Scalper cycle completed', new Date().toUTCString());
    console.log('~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~');
  }

  async deltaHedgeOpenBook(
    dipProduct: DIPDeposit[],
    deltaHedgeCount: number,
    spotMarket: Market,
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
    let hedgeSide = HedgeSide.buy;
    this.serumVialClient.streamData(
      ['trades'],
      [`${this.symbol}/USDC`],
      [deltaID.toString()],
      (message: SerumVialTradeMessage) => {
        const side: string = message.makerClientId === deltaID.toString() ? 'Maker' : 'Taker';
        console.log(`${this.symbol} Delta fill ${side} ${hedgeSide} ${tradeMessageToString(message)}`);
        const fillQty = (hedgeSide === HedgeSide.buy ? 1 : -1) * message.size;
        hedgeDeltaTotal += fillQty;
      },
    );

    console.log(this.symbol, 'Loading Fair Value');
    const fairValue = await findFairValue(
      this.connection,
      spotMarket,
      this.symbol,
      MAX_DELTA_HEDGES,
      TWAP_INTERVAL_SEC,
    );
    if (fairValue === NO_FAIR_VALUE) {
      console.log(this.symbol, 'No robust pricing. Exiting Delta Hedge', deltaHedgeCount);
      return;
    }

    // Get total delta position to hedge
    const dipTotalDelta = getDIPDelta(dipProduct, fairValue, this.symbol);
    const spotDelta = await getWalletAndOpenbookSpotDelta(this.connection, this.symbol, this.owner, spotMarket);
    hedgeDeltaTotal = dipTotalDelta + spotDelta + this.deltaOffset;
    const IS_BUYSIDE = hedgeDeltaTotal < 0;
    hedgeSide = IS_BUYSIDE ? HedgeSide.buy : HedgeSide.sell;

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
      console.log(this.symbol, 'Delta netural within', deltaThreshold);
      return;
    }
    const slippageTolerance = Math.min(stdDevSpread / 2, SLIPPAGE_MAX.get(this.symbol));
    let hedgePrice = IS_BUYSIDE
      ? fairValue * (1 + slippageTolerance)
      : fairValue * (1 - slippageTolerance);
    const slippageDIPDelta = getDIPDelta(dipProduct, hedgePrice, this.symbol);
    const dipDeltaDiff = slippageDIPDelta - dipTotalDelta;
    hedgeDeltaTotal += dipDeltaDiff;
    console.log(this.symbol, 'Adjust slippage delta by', dipDeltaDiff, 'to', -hedgeDeltaTotal);

    if (Math.abs(hedgeDeltaTotal) < deltaThreshold) {
      console.log(this.symbol, 'Delta netural: slippage', deltaThreshold);
      return;
    }
    console.log(this.symbol, 'Outside delta threshold:', Math.abs(hedgeDeltaTotal), 'vs.', deltaThreshold);

    // Load order book data to determine splicing.
    const bids = await spotMarket.loadBids(this.connection);
    const asks = await spotMarket.loadAsks(this.connection);
    const spliceFactor = openBookLiquidityCheckAndNumSplices(
      hedgeDeltaTotal,
      hedgePrice,
      MAX_NOTIONAL.get(this.symbol),
      hedgeSide,
      bids,
      asks,
    );

    let hedgeDeltaClip = hedgeDeltaTotal;
    try {
      if (spliceFactor !== SUFFICIENT_BOOK_DEPTH) {
        console.log(this.symbol, 'Not enough liquidity! Try Jupiter. Adjusted price', hedgePrice, 'Splice', spliceFactor);
        const jupiter = await asyncCallWithTimeout(Jupiter.load({
          connection: this.connection,
          cluster: CLUSTER,
          user: this.owner,
          wrapUnwrapSOL: false,
          restrictIntermediateTokens: true,
          shouldLoadSerumOpenOrders: false,
        }), MAX_LOAD_TIME);
        const jupRouteDetails = await jupiterHedge(
          hedgeSide, this.symbol, 'USDC', hedgeDeltaTotal, hedgePrice, jupiter, this.connection, this.owner
        );
        if (jupRouteDetails !== undefined) {
          hedgeDeltaTotal += jupRouteDetails.qty;
          console.log(this.symbol, 'Adjust', hedgeSide, 'price', hedgePrice, 'to', jupRouteDetails.price, 'remaining qty', hedgeDeltaTotal);
          hedgePrice = jupRouteDetails.price;
        } else {
          console.log(this.symbol, 'No Jupiter Route found better than', hedgePrice);
        }

        // TODO: Re-evaluate the splice factor after jupiter routing
        hedgeDeltaClip = hedgeDeltaTotal / spliceFactor;
      }

      // Return early if jupiter sweeping got within the threshold.
      if (Math.abs(hedgeDeltaTotal) < deltaThreshold) {
        console.log(this.symbol, 'Delta netural: Jupiter hedge');
        return;
      }
    } catch (err) {
      console.log(this.symbol, 'Jupiter route error', err, err.stack);
    }

    // Send the delta hedge order to openbook.
    console.log(this.symbol, 'Sweep OpenBook');
    const amountDelta = roundQtyToMinOrderStep(Math.abs(hedgeDeltaClip), this.minSpotSize);
    const priceDelta = roundPriceToTickSize(Math.abs(hedgePrice), this.tickSize);
    const payerAccount = await getPayerAccount(hedgeSide, this.symbol, 'USDC', this.owner);
    console.log(this.symbol, hedgeSide, 'OpenBook-SPOT', amountDelta, 'Limit:', priceDelta, '#', deltaHedgeCount, 'ID', deltaID.toString());
    const deltaOrderTx = new Transaction();
    const deltaTx = await spotMarket.makePlaceOrderTransaction(this.connection, {
      owner: this.owner.publicKey,
      payer: payerAccount,
      side: hedgeSide,
      price: priceDelta,
      size: amountDelta,
      orderType: 'limit',
      clientId: deltaID,
      selfTradeBehavior: 'abortTransaction',
    });
    deltaOrderTx.add(deltaTx.transaction);
    try {
      await sendAndConfirmTransaction(this.connection, setPriorityFee(deltaOrderTx), [this.owner]);
    } catch (err) {
      console.log(this.symbol, 'Delta Order error', err, err.stack);
    }
    // Rest single order if the hedge should be completed in a single clip
    if (spliceFactor === 1) {
      const netHedgePeriod = TWAP_INTERVAL_SEC * MAX_DELTA_HEDGES;
      console.log(this.symbol, 'Scan delta fills for ~', netHedgePeriod, 'seconds');

      await waitForFill(() => (Math.abs(hedgeDeltaTotal) < deltaThreshold), TWAP_INTERVAL_SEC);
      if (Math.abs(hedgeDeltaTotal) < deltaThreshold) {
        console.log(this.symbol, 'Delta Hedge complete: SerumVial');
        return;
      }

      const [bidTOB, _bidSize] = bids.getL2(1)[0];
      const [askTOB, _askSize] = asks.getL2(1)[0];
      const spreadDelta = IS_BUYSIDE
        ? ((askTOB - hedgePrice) / hedgePrice) * 100
        : ((bidTOB - hedgePrice) / hedgePrice) * 100;
      console.log(`${this.symbol} OpenBook Delta Hedge timeout. Spread % ${spreadDelta} \
> slippage % ${slippageTolerance * 100}`);
      return;
    }

    // Wait the twapInterval of time to see if the position gets to neutral.
    // This is the case where we are unable to fill all of the delta at once and
    // need to send multiple orders. Either it will get filled which will get
    // caught in the next run, enough time has passed and we start a new run
    // anyways.
    console.log(this.symbol, 'Scan Delta Fills for ~', TWAP_INTERVAL_SEC, 'seconds');
    await waitForFill(
      (_) => Math.abs(hedgeDeltaTotal) < (deltaThreshold),
      TWAP_INTERVAL_SEC,
    );
    this.serumVialClient.removeAnyListeners();
    await this.deltaHedgeOpenBook(
      dipProduct,
      deltaHedgeCount + 1,
      spotMarket,
    );
  }

  async gammaScalpOpenBook(
    dipProduct: DIPDeposit[],
    gammaScalpCount: number,
    priorFillPrice: number,
    spotMarket: Market,
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

    console.log(this.symbol, 'Loading Fair Value For Gamma Scalp', gammaScalpCount);
    let fairValue: number;
    if (priorFillPrice > NO_FAIR_VALUE) {
      fairValue = priorFillPrice;
      console.log(this.symbol, 'Fair Value set to prior fill', fairValue);
    } else {
      fairValue = await findFairValue(
        this.connection,
        spotMarket,
        this.symbol,
        GAMMA_CYCLES,
        TWAP_INTERVAL_SEC,
      );
      if (fairValue === NO_FAIR_VALUE) {
        console.log(this.symbol, 'No robust pricing. Exiting Gamma Scalp', gammaScalpCount);
        return;
      }
    }
    const dipTotalGamma = getDIPGamma(dipProduct, fairValue, this.symbol);

    // Calc scalperWindow std deviation spread from zScore & IV for gamma levels.
    const stdDevSpread = (this.impliedVol / Math.sqrt(SEC_PER_YEAR / SCALPER_WINDOW_SEC))
    * this.zScore;
    const netGamma = dipTotalGamma * stdDevSpread * fairValue;

    const stdDevWidenedSpread = ((gammaScalpCount - 1) / GAMMA_CYCLES) * stdDevSpread;
    let gammaBid = fairValue * (1 - stdDevSpread - stdDevWidenedSpread);
    let gammaAsk = fairValue * (1 + stdDevSpread + stdDevWidenedSpread);

    const spotDelta = await getWalletAndOpenbookSpotDelta(this.connection, this.symbol, this.owner, spotMarket);

    if (this.mode === ScalperMode.GammaBackStrikeAdjustment) {
      const dipTotalDelta = getDIPDelta(dipProduct, fairValue, this.symbol);
      const isShort = dipTotalDelta + spotDelta + this.deltaOffset < 0;
      // TODO: Create a gamma table to find relevant long & short strikes
      // TODO: Track average sell or buy to allow scalps above put strike & below call strike
      const nearStrikeType = findNearestStrikeType(dipProduct, fairValue);
      console.log(this.symbol, 'Delta Position', dipTotalDelta + spotDelta + this.deltaOffset, nearStrikeType, 'isShort', isShort);
      if (nearStrikeType === CallOrPut.Put) {
        const maxStrike = findMaxStrike(dipProduct);
        const isOTM = fairValue > maxStrike;
        if (isOTM) {
          gammaBid = Math.min(maxStrike * (1 - stdDevSpread - stdDevWidenedSpread), gammaBid);
          console.log('Strike adjusted Gamma Bid', gammaBid, maxStrike);
        } else {
          gammaAsk = Math.max(maxStrike * (1 + stdDevSpread + stdDevWidenedSpread), gammaAsk);
          console.log('Strike adjusted Gamma Ask', gammaAsk, maxStrike);
        }
      } else if (nearStrikeType === CallOrPut.Call) {
        const minStrike = findMinStrike(dipProduct);
        const isOTM = (fairValue < minStrike);
        if (isOTM) {
          gammaAsk = Math.max(minStrike * (1 + stdDevSpread + stdDevWidenedSpread), gammaAsk);
          console.log('Strike adjusted Gamma Ask', gammaAsk, minStrike);
        } else {
          gammaBid = Math.min(minStrike * (1 - stdDevSpread - stdDevWidenedSpread), gammaBid);
          console.log('Strike adjusted Gamma Bid', gammaBid, minStrike);
        }
      }
    }

    console.log(this.symbol, 'Position Gamma Γ:', netGamma, 'Fair Value', fairValue);
    if (netGamma < this.minSpotSize) {
      console.log(this.symbol, 'Gamma Hedge too small');
      return;
    }

    // Find the prices at which whale qty is bid & offered
    const bids = await spotMarket.loadBids(this.connection);
    const numBids = bids.getL2(MAX_ORDER_BOOK_SEARCH_DEPTH).length;
    const randomMaxBackGammaMult = getRandomNumAround(
      MAX_BACK_GAMMA_MULTIPLE,
      BACK_GAMMA_SPREAD_RATIO,
    );
    const dimQty = randomMaxBackGammaMult * netGamma - netGamma;
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
    console.log(`${this.symbol} Dim Qty ${dimQty} Whale Bid: ${whaleBidPrice} Ask ${whaleAskPrice} \
Spread % ${((whaleAskPrice - whaleBidPrice) / fairValue) * 100}`);

    amountGamma = roundQtyToMinOrderStep(Math.abs(netGamma), this.minSpotSize);
    // Reduce gamma ask if not enough inventory. Assumes we always have enough to bid
    const gammaAskQty = Math.abs(spotDelta) > amountGamma ? amountGamma
      : roundQtyToMinOrderStep(Math.abs(spotDelta * ORDER_SIZE_BUFFER_PCT), this.minSpotSize);
    const priceBid = roundPriceToTickSize(Math.abs(gammaBid), this.tickSize);
    const priceAsk = roundPriceToTickSize(Math.abs(gammaAsk), this.tickSize);
    const bidAccount = await getPayerAccount(HedgeSide.buy, this.symbol, 'USDC', this.owner);
    const askAccount = await getPayerAccount(HedgeSide.sell, this.symbol, 'USDC', this.owner);
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
    const maxBackGamma = Math.max(netGamma * randomMaxBackGammaMult, 0);
    const whaleBidGammaQty = Math.min(maxBackGamma, dipTotalGamma * whaleBidDiff - netGamma);
    let whaleAskGammaQty = Math.min(maxBackGamma, dipTotalGamma * whaleAskDiff - netGamma);
    // Reduce whale ask if not enough inventory
    if (whaleAskGammaQty > Math.abs(spotDelta)) {
      whaleAskGammaQty = 0;
    } else if (whaleAskGammaQty + amountGamma > Math.abs(spotDelta)) {
      whaleAskGammaQty = Math.abs(spotDelta * ORDER_SIZE_BUFFER_PCT) - amountGamma;
    }
    const backBidQty = roundQtyToMinOrderStep(Math.abs(whaleBidGammaQty), this.minSpotSize);
    const backAskQty = roundQtyToMinOrderStep(Math.abs(whaleAskGammaQty), this.minSpotSize);

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
