import WebSocket from 'ws';
import {
  Config, getMarketByBaseSymbolAndKind, GroupConfig, MangoAccount, MangoClient, MangoCache,
  PerpMarket, MangoGroup, PerpEventLayout, FillEvent, MarketConfig,
} from "@blockworks-foundation/mango-client";
import { Keypair, Commitment, Connection, PublicKey } from "@solana/web3.js";
import { Market } from '@project-serum/serum';
import configFile from "./ids.json";
import {
  networkName, THEO_VOL_MAP, maxNotional, slippageTolerance, twapInterval, scalperWindow,
  zScore, MinContractSize, TickSize, FILLS_URL, IS_DEV, fillScan, gammaThreshold,
  maxHedges, percentDrift, DELTA_OFFSET, MANGO_DOWNTIME_THRESHOLD, fundingThreshold, gammaCycles, 
  MinOpenBookSize, openBookLiquidityFactor, OPENBOOK_FORK_ID, OPENBOOK_MKT_MAP, OPENBOOK_ACCOUNT_MAP,
} from "./config";
import { DIPDeposit } from "./common";
import { getPythPrice, readKeypair, sleepExact, sleepRandom, tokenToSplMint } from "./utils";
import { SerumVialClient, SerumVialTradeMessage } from "./serumVial";
import { DexMarket } from "@project-serum/serum-dev-tools";
import { cancelOpenBookOrders, fillSize, getDIPDelta, getDIPGamma, getSpotDelta, loadPrices, orderSplice, settleOpenBook } from './scalper_utils';

export class Scalper {
  client: MangoClient;
  connection: Connection;
  groupConfig: GroupConfig;
  config: Config;
  owner: Keypair;
  symbol: string;
  impliedVol: number;
  minSize: number;
  minSpotSize: number;
  tickSize: number;
  perpMarketConfig: MarketConfig;
  marketIndex: number;
  deltaOffset: number;
  openBookAccount: string;
  serumVialClient: SerumVialClient;

  constructor(symbol: string) {
    // Setup Client
    this.config = new Config(configFile);
    this.groupConfig = this.config.getGroupWithName(networkName) as GroupConfig;
    this.connection = new Connection(
      this.config.cluster_urls[this.groupConfig.cluster],
      "processed" as Commitment
    );
    this.client = new MangoClient(
      this.connection,
      this.groupConfig.mangoProgramId
    );

    // Order Authority
    this.owner = Keypair.fromSecretKey(Uint8Array.from(readKeypair()));

    this.symbol = symbol;
    this.impliedVol = THEO_VOL_MAP.get(symbol);
    this.minSize = MinContractSize.get(symbol);
    this.minSpotSize = MinOpenBookSize.get(symbol);
    this.tickSize = TickSize.get(symbol);
    this.deltaOffset = DELTA_OFFSET.get(symbol);
    this.openBookAccount = OPENBOOK_ACCOUNT_MAP.get(symbol);

    this.serumVialClient = new SerumVialClient();
    this.serumVialClient.openSerumVial();
  }

  async pickAndRunScalper(dipProduct: DIPDeposit[]): Promise<void> {
    console.log(this.symbol, "Choosing Market to Hedge");
    this.perpMarketConfig = getMarketByBaseSymbolAndKind(
      this.groupConfig,
      this.symbol,
      "perp"
    );
    this.marketIndex = this.perpMarketConfig.marketIndex;

    // Setup for scalping
    const mangoGroup: MangoGroup = await this.client.getMangoGroup(
      this.groupConfig.publicKey
    );
    const perpMarket: PerpMarket = await mangoGroup.loadPerpMarket(
      this.connection,
      this.marketIndex,
      this.perpMarketConfig.baseDecimals,
      this.perpMarketConfig.quoteDecimals
    );

    // Check if Mango is live
    if ((Date.now() - perpMarket.lastUpdated.toNumber() * 1_000) / (1_000 * 60) > MANGO_DOWNTIME_THRESHOLD) {
      console.log(this.symbol, "Mango Down! Last Updated:", new Date(perpMarket.lastUpdated.toNumber() * 1_000))
      await this.scalperOpenBook(dipProduct);
    } else {
      await this.scalperMango(dipProduct);
    }
  }

  async scalperMango(dipProduct: DIPDeposit[]): Promise<void> {
    console.log(this.symbol, "Hedging on Mango");
    this.perpMarketConfig = getMarketByBaseSymbolAndKind(
      this.groupConfig,
      this.symbol,
      "perp"
    );
    this.marketIndex = this.perpMarketConfig.marketIndex;

    // Setup for scalping
    const mangoGroup: MangoGroup = await this.client.getMangoGroup(this.groupConfig.publicKey);
    const perpMarket: PerpMarket = await mangoGroup.loadPerpMarket(
      this.connection,
      this.marketIndex,
      this.perpMarketConfig.baseDecimals,
      this.perpMarketConfig.quoteDecimals
    );

    const spotMarketConfig = getMarketByBaseSymbolAndKind(
      this.groupConfig,
      this.symbol,
      'spot',
    );
    const spotMarket = await Market.load(
      this.connection,
      new PublicKey (OPENBOOK_MKT_MAP.get(this.symbol)),
      undefined,
      OPENBOOK_FORK_ID,
    );
    
    // Open Mango Websocket
    const fillFeed = new WebSocket(FILLS_URL!);
    fillFeed.onopen = function(_) {
      console.log('Connected to Mango Websocket', new Date().toUTCString())
    };
    fillFeed.onerror = function(error) {
      console.log(`Websocket Error ${error.message}`);
    };

    try {
      await this.deltaHedge(
        dipProduct,
        mangoGroup,
        perpMarket,
        spotMarket,
        fillFeed, 
        1
      );
      await this.gammaScalp(
        dipProduct,
        mangoGroup,
        perpMarket,
        fillFeed,
        1
      );
    }
    catch (err){
      console.log(this.symbol, "Main Error", err, err.stack);
    }
  }

  async deltaHedge(
    dipProduct: DIPDeposit[],
    mangoGroup: MangoGroup,
    perpMarket: PerpMarket,
    spotMarket: Market,
    fillFeed: WebSocket,
    deltaHedgeCount: number
  ): Promise<void> {
    const [mangoCache]: MangoCache[] = await loadPrices(mangoGroup, this.connection);
    const mangoAccount: MangoAccount = (
      await this.client.getMangoAccountsForOwner(mangoGroup, this.owner.publicKey)
    )[0];

    // Cleanup from previous runs.
    await this.cancelStaleOrders(mangoAccount, mangoGroup, perpMarket);

    // Avoid unsafe recursion.
    if (deltaHedgeCount > maxHedges) {
      console.log(this.symbol, "Max Hedges exceeded without getting to neutral");
      return;
    }

    // Calc DIP delta for new position
    const fairValue = mangoGroup.getPrice(this.marketIndex, mangoCache).toNumber();
    const dipTotalDelta = getDIPDelta(dipProduct, fairValue, this.symbol);

    // Get Mango delta position
    const perpAccount = mangoAccount.perpAccounts[this.marketIndex];
    const mangoPerpDelta = perpAccount.getBasePositionUi(perpMarket);
    const mangoSpotDelta = mangoAccount.getAvailableBalance(mangoGroup, mangoCache, this.marketIndex)
      .toNumber() / Math.pow(10, this.perpMarketConfig.baseDecimals);

    // Get all spot positions Option Vault, Risk Manager, Mango Tester
    const spotDelta = await getSpotDelta(this.connection, this.symbol) + this.deltaOffset;

    // Get Total Delta Position to hedge
    let hedgeDeltaTotal = IS_DEV ? 0.1 : mangoPerpDelta + dipTotalDelta + spotDelta + mangoSpotDelta;
 
    // Check whether we need to hedge.
    const dipTotalGamma = getDIPGamma(dipProduct, fairValue, this.symbol);
    const stdDevSpread = this.impliedVol / Math.sqrt((365 * 24 * 60 * 60) / scalperWindow) * zScore;
    const deltaThreshold = Math.max(dipTotalGamma * stdDevSpread * fairValue * gammaThreshold, this.minSize);
    if (Math.abs(hedgeDeltaTotal * fairValue) < (deltaThreshold * fairValue)) {
      console.log(this.symbol, "Delta Netural <", deltaThreshold);
      return;
    } else {
      console.log(this.symbol, "Above delta threshold:", deltaThreshold);
    }

    // Funding Rate to determine spot or perp order
    const bidSide = await perpMarket.loadBids(this.connection)
    const askSide = await perpMarket.loadAsks(this.connection)
    const fundingRate = 24 * 365 * perpMarket.getCurrentFundingRate(mangoGroup, mangoCache, this.marketIndex, bidSide, askSide)
    const buySpot = fundingRate > fundingThreshold;
    const sellSpot = -fundingRate < fundingThreshold; 
    const hedgeSide = hedgeDeltaTotal < 0 ? "buy" : "sell";
    let hedgeProduct: string;
    if (hedgeSide == "buy" && buySpot) {
      hedgeProduct = "-SPOT";
    } else if (hedgeSide == "sell" && sellSpot){
      hedgeProduct = "-SPOT";
    } else {
      hedgeProduct = "-PERP";
    }

    console.log(
      this.symbol, "Target Delta Hedge:", hedgeSide, hedgeProduct, -hedgeDeltaTotal, "DIP Δ:",
      dipTotalDelta, "Mango Perp Δ:", mangoPerpDelta, "Mango Spot Δ:", mangoSpotDelta,
      "Spot Δ:", spotDelta, "Fair Value:",  fairValue
    );

    // Determine what price to use for hedging depending on allowable slippage.
    const hedgePrice =
      hedgeDeltaTotal < 0
        ? IS_DEV ? fairValue * (1 + slippageTolerance * deltaHedgeCount) : fairValue * (1 + slippageTolerance)
        : IS_DEV ? fairValue * (1 - slippageTolerance * deltaHedgeCount) : fairValue * (1 - slippageTolerance);

    // Break up order depending on whether the book can support it
    const bookSide = hedgeDeltaTotal < 0 ? askSide : bidSide;
    const hedgeDeltaClip =
      hedgeDeltaTotal /
      Math.min(orderSplice(
        hedgeDeltaTotal,
        fairValue,
        maxNotional,
        slippageTolerance,
        bookSide,
        perpMarket
      ), maxHedges);

    // Unique identifier for delta order.
    const deltaOrderId = new Date().getTime() * 2;

    // Start listening for Delta Hedge Fills
    const deltaFillListener = async (event: WebSocket.MessageEvent) => {
      const parsedEvent = JSON.parse(event.data as string);
      if (parsedEvent['status'] === 'New' && parsedEvent['market'] === this.symbol.concat(hedgeProduct)) {
        const fillBytes: Buffer = Buffer.from(parsedEvent['event'], 'base64');
        const fillEvent: FillEvent = PerpEventLayout.decode(fillBytes).fill;
        if (
          (fillEvent.makerClientOrderId.toString() == deltaOrderId.toString()) ||
          (fillEvent.takerClientOrderId.toString() == deltaOrderId.toString())
        ) {
          const fillQty = (hedgeSide == 'buy' ? 1 : -1) * fillEvent.quantity.toNumber() * this.minSize;
          const fillPrice = fillEvent.price.toNumber() * this.tickSize;
          hedgeDeltaTotal = hedgeDeltaTotal + fillQty;
          console.log(
            this.symbol, 'Delta Filled', hedgeSide, hedgeProduct, "Qty", fillQty,
            "Price", fillPrice, "Remaining", hedgeDeltaTotal, "ID", deltaOrderId,
            new Date().toUTCString()
          );
          return hedgeDeltaTotal;
        }
      }
    };

    // Setup a listener for the order.
    if (fillFeed.readyState == WebSocket.OPEN) {
      fillFeed.addEventListener('message', deltaFillListener);
      console.log(this.symbol, "Listening For Delta Hedges")
    } else {
      console.log(this.symbol, "Websocket State", fillFeed.readyState)
    }

    console.log(this.symbol, hedgeSide, hedgeProduct, Math.abs(hedgeDeltaClip), "Limit:", hedgePrice, "#", deltaHedgeCount, "ID", deltaOrderId);
    try {
      if (hedgeProduct == "-SPOT") {
        await this.client.placeSpotOrder2(
          mangoGroup,
          mangoAccount,
          spotMarket,
          this.owner,
          hedgeSide,
          hedgePrice,
          Math.abs(hedgeDeltaClip),
          "limit",
          deltaOrderId,
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
            orderType: "limit",
            clientOrderId: deltaOrderId,
          }
        );
      }
    } catch (err) {
      console.log(this.symbol, "Failed to place order", err, err.stack);
    }

    // Wait the twapInterval of time to see if the position gets to neutral.
    console.log(this.symbol, "Scan Delta Fills for ~", twapInterval, "seconds");
    for (let i = 0; i < twapInterval / fillScan; i++) {
      if (Math.abs(hedgeDeltaTotal * fairValue) < (this.minSize * fairValue)) {
        fillFeed.removeEventListener('message', deltaFillListener);
        console.log(this.symbol, "Delta Hedge Complete: Websocket Fill");
        return;
      }

      // Use loadFills() in fillSize() as a backup to websocket
      const filledSize = await fillSize(perpMarket, this.connection, deltaOrderId);
      const fillDeltaTotal = mangoPerpDelta + dipTotalDelta + spotDelta + mangoSpotDelta + filledSize;
      if (Math.abs(fillDeltaTotal * fairValue) < (this.minSize * fairValue)) {
        fillFeed.removeEventListener('message', deltaFillListener);
        console.log(this.symbol, "Delta Hedge Complete: Loaded Fills");
        return;
      }    
      await sleepRandom(fillScan);
    }

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
      this.connection
    );
    const mangoAccount: MangoAccount = (await this.client.getMangoAccountsForOwner(mangoGroup, this.owner.publicKey))[0];

    // Makes the recursive gamma scalps safer. Rerun will clear any stale orders. Allows only 2 gamma orders at any time
    await this.cancelStaleOrders(mangoAccount, mangoGroup, perpMarket);

    // Avoid unsafe recursion.
    if (gammaScalpCount > gammaCycles) {
      console.log(this.symbol, "Max Hedges exceeded without getting to neutral");
      return;
    }

    const fairValue = mangoGroup.getPrice(this.marketIndex, mangoCache).toNumber();
    const dipTotalGamma = getDIPGamma(dipProduct, fairValue, this.symbol);

    // Calc scalperWindow std deviation spread from zScore & IV for gamma levels
    const stdDevSpread =
      this.impliedVol / Math.sqrt((365 * 24 * 60 * 60) / scalperWindow) * zScore;
    const netGamma = IS_DEV ? Math.max(0.01, dipTotalGamma * stdDevSpread * fairValue) : dipTotalGamma * stdDevSpread * fairValue;

    console.log(this.symbol, "Position Gamma Γ:", netGamma, "Fair Value", fairValue);
    if ((netGamma * fairValue) < (this.minSize * fairValue)){
      console.log(this.symbol, 'Gamma Hedge Too Small')
      return
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
        parsedEvent['status'] === 'New' &&
        parsedEvent['market'] === this.symbol.concat("-PERP")
      ) {
        const fillBytes = Buffer.from(parsedEvent['event'], 'base64');
        const fillEvent: FillEvent = PerpEventLayout.decode(fillBytes).fill;
        const bidFill =
          fillEvent.makerClientOrderId.toString() == gammaBidID.toString() ||
          fillEvent.takerClientOrderId.toString() == gammaBidID.toString();
        const askFill =
          fillEvent.makerClientOrderId.toString() == gammaAskID.toString() ||
          fillEvent.takerClientOrderId.toString() == gammaAskID.toString();
        if (bidFill || askFill) {
          console.log(this.symbol, 'Gamma Filled', bidFill ? "BID" : "ASK", new Date().toUTCString());
          fillFeed.removeEventListener('message', gammaFillListener);
          // Do not need to remove the unfilled order since it will be cancelled in the recursive call.
          this.gammaScalp(
            dipProduct,
            mangoGroup,
            perpMarket,
            fillFeed,
            gammaScalpCount + 1
          );
        }
      }
    };
    if (fillFeed.readyState == WebSocket.OPEN) {
      fillFeed.addEventListener('message', gammaFillListener);
      console.log(this.symbol, "Listening For Gamma Scalps");
    } else {
      console.log(this.symbol, "Websocket State", fillFeed.readyState)
    }

    // Place Gamma scalp bid & offer
    try {
      await this.client.placePerpOrder2(
        mangoGroup,
        mangoAccount,
        perpMarket,
        this.owner,
        "buy",
        gammaBid,
        netGamma,
        { orderType: "postOnlySlide", clientOrderId: gammaBidID }
      );
      console.log(this.symbol, "Gamma Bid", gammaBid, "ID", gammaBidID);
      await this.client.placePerpOrder2(
        mangoGroup,
        mangoAccount,
        perpMarket,
        this.owner,
        "sell",
        gammaAsk,
        netGamma,
        { orderType: "postOnlySlide", clientOrderId: gammaAskID }
      );
      console.log(this.symbol, "Gamma Ask", gammaAsk, "ID", gammaAskID);
    } catch (err) {
      console.log(this.symbol, "Gamma Error", err, err.stack);
    }
    
    // Sleep for the max time of the reruns then kill thread
    await sleepExact((1 + percentDrift) * scalperWindow);
    console.log(this.symbol, "Remove stale gamma fill listener", gammaBidID, gammaAskID)
    fillFeed.removeEventListener('message', gammaFillListener);
  }

  async cancelStaleOrders(
    mangoAccount: MangoAccount,
    mangoGroup: MangoGroup,
    perpMarket: PerpMarket
  ): Promise<void> {
    const openOrders = mangoAccount.getPerpOpenOrders();
    if (openOrders.length > 0) {
      for (const order of openOrders) {
        if (order.marketIndex == this.marketIndex) {
          try{
            console.log(this.symbol,"Canceling Orders");
            await this.client.cancelAllPerpOrders(
              mangoGroup,
              [perpMarket],
              mangoAccount,
              this.owner
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
    console.log(this.symbol, "Hedging on OpenBook");

    this.serumVialClient.removeAnyListeners();

    try {
      await this.deltaHedgeOpenBook(
        dipProduct,
        1,
      );
      await this.gammaScalpOpenBook(
        dipProduct,
        1,
        0
      );
      // TODO: OpenBook settlement to move to mango if needed
    }
    catch (err){
      console.log(this.symbol, "Main Error", err, err.stack)
    }

    // TODO confirm unnecessary caused a crash
    // this.serumVialClient.closeSerumVial();
  }

  async deltaHedgeOpenBook(
    dipProduct: DIPDeposit[],
    deltaHedgeCount: number,
  ): Promise<void> {
    const spotMarket = await Market.load(
      this.connection,
      new PublicKey (OPENBOOK_MKT_MAP.get(this.symbol)),
      undefined,
      OPENBOOK_FORK_ID,
    );

    // Clean the state by cancelling all existing open orders.
    await cancelOpenBookOrders(this.connection, this.owner, spotMarket, this.symbol);

    // Settle Funds
    try{
      await settleOpenBook(this.connection, this.owner, spotMarket, this.symbol, "USDC");
    } catch (err) {
      console.log(this.symbol, "Settling Funds", err, err.stack);
    }

    // Prevent too much recursion.
    if (deltaHedgeCount > maxHedges) {
      console.log(this.symbol, "Max OpenBook Hedges exceeded!");
      return;
    }

    this.serumVialClient.streamData(
      ['trades'],
      [`${this.symbol}/USDC`],
      this.openBookAccount,
      (message: SerumVialTradeMessage) => {
        console.log(this.symbol, "Delta Hedge Filled!", hedgeSide, message.size, message.market, message.price, message.timestamp);
        const fillQty = (hedgeSide == 'buy' ? 1 : -1) * message.size;
        hedgeDeltaTotal = hedgeDeltaTotal + fillQty;
        this.serumVialClient.removeAnyListeners();
      }
    );

    // Find fair value.
    console.log(this.symbol, "Loading Fair Value...");
    let fairValue;
    const pythPrice = await getPythPrice(new PublicKey(tokenToSplMint(this.symbol)));
    const bids = await spotMarket.loadBids(this.connection);
    const asks = await spotMarket.loadAsks(this.connection);
    const [bidPrice, _bidSize] = bids.getL2(1)[0];
    const [askPrice, _askSize] = asks.getL2(1)[0];
    const midValue = (bidPrice + askPrice) / 2.0;
    // Handle when pyth does not have a price
    if (this.symbol == "MNGO"){
      fairValue = pythPrice.emaPrice.value;
      console.log(this.symbol, "Use Pyth EMA Price", pythPrice.emaPrice.value, "OpenBook Mid Value", midValue, "Fair Value", fairValue);
    } else {
      if (pythPrice.price > 0) {
        fairValue = midValue*openBookLiquidityFactor + pythPrice.price*(1-openBookLiquidityFactor);
        console.log(this.symbol, "Pyth Price", pythPrice.price, "OpenBook Mid Value", midValue, "Fair Value", fairValue);
      } else {
        fairValue = midValue;
        console.log(this.symbol, "Pyth Price Bad Using OpenBook Mid Value", midValue, "Fair Value", fairValue);
      }
    }
    

    // Get the DIP Delta
    const dipTotalDelta = getDIPDelta(dipProduct, fairValue, this.symbol);
  
    // Get all spot positions Option Vault, Risk Manager, Mango Tester
    const spotDelta = await getSpotDelta(this.connection, this.symbol) + this.deltaOffset;
  
    // Get Total Delta Position to hedge. Use .1 for DEV to force that it does something.
    let hedgeDeltaTotal = IS_DEV ? 0.1 : dipTotalDelta + spotDelta;
    const hedgeSide = hedgeDeltaTotal < 0 ? 'buy' : 'sell';
    // TODO: Mango delta positions
    console.log(
      this.symbol, "Target Delta Hedge:", hedgeSide, "SPOT", -hedgeDeltaTotal, "DIP Δ:",
      dipTotalDelta, "Mango Perp Δ:", 0, "Mango Spot Δ:", 0,
      "Spot Δ:", spotDelta, "Fair Value:",  fairValue
    );

    // Check whether we need to hedge.
    const dipTotalGamma = getDIPGamma(dipProduct, fairValue, this.symbol);
    const stdDevSpread = this.impliedVol / Math.sqrt((365 * 24 * 60 * 60) / scalperWindow) * zScore;
    const deltaThreshold = Math.max(dipTotalGamma * stdDevSpread * fairValue * gammaThreshold, this.minSpotSize);
    if (Math.abs(hedgeDeltaTotal * fairValue) < (deltaThreshold * fairValue)) {
      console.log(this.symbol, "Delta Netural <", deltaThreshold);
      return;
    } else {
      console.log(this.symbol, "Above delta threshold:", hedgeDeltaTotal, deltaThreshold);
    }

    // TODO: Order splicing if necessary
  
    // Place an order to get delta neutral.
    const hedgePrice = hedgeDeltaTotal < 0 ? fairValue * (1 + slippageTolerance) : fairValue * (1 - slippageTolerance);
    
    try {
      const amountDelta = Math.round(Math.abs(hedgeDeltaTotal) * (1/this.minSpotSize)) / (1/this.minSpotSize);
      const priceDelta = Math.floor(Math.abs(hedgePrice) * (1/this.tickSize)) / (1/this.tickSize);
      console.log(this.symbol, hedgeSide, "OpenBook-SPOT", Math.abs(amountDelta), "Limit:", priceDelta, "#", deltaHedgeCount);
      await DexMarket.placeOrder(
        this.connection, 
        this.owner,
        spotMarket,
        hedgeSide,
        'limit',
        amountDelta,
        priceDelta,
      );
    } catch (err) {
      console.log(this.symbol, "Delta Hedge", err, err.stack);
    }

    // Wait the twapInterval of time to see if the position gets to neutral.
    console.log(this.symbol, "Scan Delta Fills for ~", twapInterval, "seconds");
    for (let i = 0; i < twapInterval / fillScan; i++) {
      if (Math.abs(hedgeDeltaTotal * fairValue) < (this.minSpotSize * fairValue)) {
        this.serumVialClient.removeAnyListeners();
        console.log(this.symbol, "Delta Hedge Complete: SerumVial");
        return;
      }
      await sleepRandom(fillScan);
    }

    console.log(this.symbol, "OpenBook Delta Hedge Refresh", deltaHedgeCount);
    this.serumVialClient.removeAnyListeners();
    await this.deltaHedgeOpenBook(
      dipProduct,
      deltaHedgeCount + 1,
    );
  }

  async gammaScalpOpenBook(
    dipProduct: DIPDeposit[],
    gammaScalpCount: number,
    priorFillPrice: number
  ): Promise<void> {
    const spotMarket = await Market.load(
      this.connection,
      new PublicKey(OPENBOOK_MKT_MAP.get(this.symbol)),
      undefined,
      OPENBOOK_FORK_ID,
    );
    this.serumVialClient.removeAnyListeners();

    // Clean the state by cancelling all existing open orders.
    await cancelOpenBookOrders(this.connection, this.owner, spotMarket, this.symbol);

    // Settle Funds
    try {
      await settleOpenBook(this.connection, this.owner, spotMarket, this.symbol, "USDC");
    } catch (err) {
      console.log(this.symbol, "Settling Funds", err, err.stack);
    }

    // Prevent too much recursion.
    if (gammaScalpCount > gammaCycles) {
      console.log(this.symbol, "Maximum scalps acheived!", gammaScalpCount);
      return;
    }

    if (this.serumVialClient.checkSerumVial() != WebSocket.OPEN) {
      this.serumVialClient.openSerumVial();
    }

    this.serumVialClient.streamData(
      ['trades'],
      [`${this.symbol}/USDC`],
      this.openBookAccount,
      (message: SerumVialTradeMessage) => {
        console.log(this.symbol, "Gamma Scalp Filled!", message.size, message.market, message.price, message.timestamp);
        let fillPrice = Number(message.price);
        this.serumVialClient.removeAnyListeners();
        this.serumVialClient.closeSerumVial();
        this.gammaScalpOpenBook(
          dipProduct,
          gammaScalpCount + 1,
          fillPrice
        );
      }
    );

    // Find fair value.
    console.log(this.symbol, "Loading Fair Value For Scalp", gammaScalpCount);
    let fairValue;
    if (priorFillPrice > 0) {
      fairValue = priorFillPrice;
      console.log(this.symbol, "Fair Value Set to Prior Fill", fairValue);
    } else {
        const pythPrice = await getPythPrice(new PublicKey(tokenToSplMint(this.symbol)));
        const bids = await spotMarket.loadBids(this.connection);
        const asks = await spotMarket.loadAsks(this.connection);
        const [bidPrice, _bidSize] = bids.getL2(1)[0];
        const [askPrice, _askSize] = asks.getL2(1)[0];
        const midValue = (bidPrice + askPrice) / 2.0; 
      if (this.symbol == "MNGO"){
        fairValue = pythPrice.emaPrice.value;
        console.log(this.symbol, "Use Pyth EMA Price", pythPrice.emaPrice.value, "OpenBook Mid Value", midValue, "Fair Value", fairValue);
      } else {
        // Handle when pyth does not have a price
        if (pythPrice.price > 0) {
          fairValue = midValue*openBookLiquidityFactor + pythPrice.price*(1-openBookLiquidityFactor);
          console.log(this.symbol, "Pyth Price", pythPrice.price, "OpenBook Mid Value", midValue, "Fair Value", fairValue);
        } else {
          fairValue = midValue;
          console.log(this.symbol, "Pyth Price Bad Using OpenBook Mid Value", midValue, "Fair Value", fairValue);
        }
      }
    }
   
    const dipTotalGamma = getDIPGamma(dipProduct, fairValue, this.symbol);

    // Calc scalperWindow std deviation spread from zScore & IV for gamma levels
    const stdDevSpread = this.impliedVol / Math.sqrt((365 * 24 * 60 * 60) / scalperWindow) * zScore;
    const netGamma = IS_DEV ? Math.max(0.01, dipTotalGamma * stdDevSpread * fairValue) : dipTotalGamma * stdDevSpread * fairValue;
    const gammaBid = fairValue * (1 - stdDevSpread);
    const gammaAsk = fairValue * (1 + stdDevSpread);

    console.log(this.symbol, "Position Gamma Γ:", netGamma, "Fair Value", fairValue);
    if ((netGamma * fairValue) < (this.minSpotSize * fairValue)){
      console.log(this.symbol, 'Gamma Hedge Too Small')
      return
    }

    // Check again for orders to cancel
    await cancelOpenBookOrders(this.connection, this.owner, spotMarket, this.symbol);

    const amountGamma = Math.round(Math.abs(netGamma) * (1/this.minSpotSize)) / (1/this.minSpotSize);
    const priceBid = Math.floor(Math.abs(gammaBid) * (1/this.tickSize)) / (1/this.tickSize);
    const priceAsk = Math.floor(Math.abs(gammaAsk) * (1/this.tickSize)) / (1/this.tickSize);
    // TODO send these orders in parallel if possible
    try{
      await DexMarket.placeOrder(
        this.connection, 
        this.owner,
        spotMarket,
        'buy',
        'limit',
        amountGamma,
        priceBid,
      );
      console.log(this.symbol, "Gamma", amountGamma, "Bid", priceBid);
    } catch (err) {
      console.log(this.symbol, "Gamma Bid", err, err.stack);
    }
    try{
      await DexMarket.placeOrder(
      this.connection, 
      this.owner,
      spotMarket,
      'sell',
      'limit',
      amountGamma,
      priceAsk,
    );
    console.log(this.symbol, "Gamma", amountGamma, "Ask", priceAsk);
    } catch (err) {
      console.log(this.symbol, "Gamma Ask", err, err.stack);
    }

    await sleepExact((1 + percentDrift) * scalperWindow);
  }
}