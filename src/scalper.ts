// @ts-ignore
import * as greeks from "greeks";
import WebSocket from 'ws';
import {
  Config,
  getMarketByBaseSymbolAndKind,
  GroupConfig,
  MangoAccount,
  MangoClient,
  MangoCache,
  BookSide,
  PerpMarket,
  MangoGroup,
  PerpEventLayout,
  FillEvent,
} from "@blockworks-foundation/mango-client";
import { Keypair, Commitment, Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { Market } from '@project-serum/serum';
import configFile from "./ids.json";
import {
  rfRate,
  networkName,
  THEO_VOL_MAP,
  maxNotional,
  slippageTolerance,
  twapInterval,
  scalperWindow,
  zScore,
  MinContractSize,
  TickSize,
  FILLS_URL,
  IS_DEV,
  fillScan,
  gammaThreshold,
  maxHedges,
  optionVaultPk,
  riskManagerPk,
  mangoTesterPk,
  percentDrift,
  DELTA_OFFSET,
  MANGO_DOWNTIME_THRESHOLD,
  fundingThreshold,
} from "./config";
import { DIPDeposit } from "./common";
import { getAssociatedTokenAddress, readKeypair, sleepExact, sleepRandom, tokenToSplMint } from "./utils";

export class Scalper {
  client: MangoClient;
  connection: Connection;
  groupConfig: GroupConfig;
  config: Config;
  owner: Keypair;
  symbol: string;
  impliedVol: number;
  minSize: number;
  tickSize: number;
  perpMarketConfig;
  marketIndex: number;
  deltaOffset: number;

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
    this.tickSize = TickSize.get(symbol);
    this.deltaOffset = DELTA_OFFSET.get(symbol);
  }

  async scalperMango(dipProduct: DIPDeposit[]): Promise<void> {
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
    if ((Date.now() - perpMarket.lastUpdated.toNumber()*1000) / (1000*60) > MANGO_DOWNTIME_THRESHOLD) {
      console.log(this.symbol, "Mango Down! Last Updated:", new Date(perpMarket.lastUpdated.toNumber()*1000))
      return;
    }

    const spotMarketConfig = getMarketByBaseSymbolAndKind(
      this.groupConfig,
      this.symbol,
      'spot',
    );
    const spotMarket = await Market.load(
      this.connection,
      spotMarketConfig.publicKey,
      undefined,
      this.groupConfig.serumProgramId,
    );

    // Open Mango Websocket
    const fillFeed = new WebSocket(FILLS_URL!);
    fillFeed.onopen = function(e) {
      console.log('Connected to Mango Websocket', new Date().toUTCString())
    };
    fillFeed.onerror = function(error) {
      console.log(`Websocket Error ${error.message}`);
    };

    let hedgeCount = 1;
    try {
      await this.deltaHedge(
        dipProduct,
        mangoGroup,
        perpMarket,
        spotMarket,
        fillFeed, 
        hedgeCount
      );
      await this.gammaScalp(
        dipProduct,
        mangoGroup,
        perpMarket,
        fillFeed
      );
    }
    catch (err){
      console.log(this.symbol, "Main Error", err)
      console.log(this.symbol, "Main Error Detail", err.stack)  
    }
  }

  async deltaHedge(
    dipProduct: DIPDeposit[],
    mangoGroup: MangoGroup,
    perpMarket: PerpMarket,
    spotMarket: Market,
    fillFeed: WebSocket,
    hedgeCount: number
  ): Promise<void> {
    // Underlying price for delta calculation
    const [mangoCache]: MangoCache[] = await loadPrices(
      mangoGroup,
      this.connection
    );

    const mangoAccount: MangoAccount = (
      await this.client.getMangoAccountsForOwner(
        mangoGroup,
        this.owner.publicKey
      )
    )[0];

    const fairValue = mangoGroup
      .getPrice(this.marketIndex, mangoCache)
      .toNumber();

    await this.cancelStaleOrders(mangoAccount, mangoGroup, perpMarket);
    
    // Funding Rate to determine spot or perp order
    const bidSide = await perpMarket.loadBids(this.connection)
    const askSide = await perpMarket.loadAsks(this.connection)
    const fundingRate = 24*365*perpMarket.getCurrentFundingRate(mangoGroup, mangoCache, this.marketIndex, bidSide, askSide)
    console.log (this.symbol, "Perp Funding Rate", fundingRate);
    const buySpot = fundingRate > fundingThreshold ? true : false;
    const sellSpot = fundingRate*-1 < fundingThreshold ? true : false; 
    // Calc DIP delta for new position
    const dipTotalDelta = getDIPDelta(dipProduct, fairValue, this.symbol);

    // Get Mango delta position
    const perpAccount = mangoAccount.perpAccounts[this.marketIndex];
    const mangoPerpDelta = perpAccount.getBasePositionUi(perpMarket);
    const mangoSpotDelta = mangoAccount.getAvailableBalance(mangoGroup, mangoCache, this.marketIndex)
      .toNumber() / Math.pow(10,this.perpMarketConfig.baseDecimals);
    // TODO Use getNetExposureByAsset()

    // Get all spot positions Option Vault, Risk Manager, Mango Tester
    const spotDelta = await getSpotDelta(this.connection, this.symbol) + this.deltaOffset;

    // Get Total Delta Position to hedge
    let hedgeDeltaTotal = IS_DEV ? 0.1 : mangoPerpDelta + dipTotalDelta + spotDelta + mangoSpotDelta;
    
    // Check if Delta Hedge is greater than min gamma threshold
    const dipTotalGamma = getDIPGamma(dipProduct, fairValue, this.symbol);
    const stdDevSpread =
      this.impliedVol / Math.sqrt((365 * 24 * 60 * 60) / scalperWindow) * zScore;
    const deltaThreshold = Math.max(dipTotalGamma * stdDevSpread * fairValue * gammaThreshold, this.minSize);
    // console.log(this.symbol, "Δ Threshold", deltaThreshold);
    if (Math.abs(hedgeDeltaTotal * fairValue) < (deltaThreshold * fairValue)) {
      console.log(this.symbol, "is Delta Netural <", deltaThreshold);
      return;
    }

    if (hedgeCount > maxHedges) {
      console.log(this.symbol, "Max Hedges Execeeded");
      return;
    }

    // Determine if hedge needs to buy or sell delta
    const hedgeSide = hedgeDeltaTotal < 0 ? "buy" : "sell";
    let hedgeProduct;
    if (hedgeSide == "buy" && buySpot) {
      hedgeProduct = "-SPOT";
    } else if (hedgeSide == "sell" && sellSpot){
      hedgeProduct = "-SPOT";
    } else {
      hedgeProduct = "-PERP";
    }
    console.log(
      this.symbol,
      "Target Delta Hedge:",
      hedgeSide,
      hedgeProduct,
      hedgeDeltaTotal*-1,
      "DIP Δ:",
      dipTotalDelta,
      "Mango Perp Δ:",
      mangoPerpDelta,
      "Mango Spot Δ:",
      mangoSpotDelta,
      "Spot Δ:",
      spotDelta,
      "Fair Value:", 
      fairValue
    );

    // Fetch proper orderbook
    const bookSide =
      hedgeDeltaTotal < 0
        ? askSide
        : bidSide;

    // Break up order depending on whether the book can support it
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

      const hedgePrice =
        hedgeDeltaTotal < 0
          ? IS_DEV ? fairValue * (1 + slippageTolerance*hedgeCount) : fairValue * (1 + slippageTolerance)
          : IS_DEV ? fairValue * (1 - slippageTolerance*hedgeCount) : fairValue * (1 - slippageTolerance);

      // Delta Hedging Orders, send limit orders through book that should fill
      const deltaOrderId = (new Date().getTime())*2;

      // Start listening for Delta Hedge Fills
      const deltaFillListener = async (event) => {
        const parsedEvent = JSON.parse(event.data);
        if (
          parsedEvent['status'] === 'New' &&
          parsedEvent['market'] === this.symbol.concat(hedgeProduct)
        ) {
          const fillBytes = Buffer.from(parsedEvent['event'], 'base64');
          const fillEvent: FillEvent = PerpEventLayout.decode(fillBytes).fill;
          if (
            (fillEvent.makerClientOrderId.toString() == deltaOrderId.toString()) ||
            (fillEvent.takerClientOrderId.toString() == deltaOrderId.toString())
          ) {
            const fillQty = hedgeSide == 'buy' ? fillEvent.quantity.toNumber() * this.minSize : -1 * fillEvent.quantity.toNumber() * this.minSize;
            const fillPrice = fillEvent.price.toNumber() * this.tickSize;
            hedgeDeltaTotal = hedgeDeltaTotal + fillQty;
            console.log(
              this.symbol,
              'Delta Filled',
              hedgeSide,
              hedgeProduct,
              "Qty",
              fillQty,
              "Price",
              fillPrice,
              "Remaining",
              hedgeDeltaTotal,
              "ID",
              deltaOrderId,
              new Date().toUTCString()
            );
            return hedgeDeltaTotal;
          }
        }
      };
      if (fillFeed.readyState == 1) {
        fillFeed.addEventListener('message', deltaFillListener);
        console.log(this.symbol, "Listening For Delta Hedges")
      } else {
        console.log(this.symbol, "Websocket State", fillFeed.readyState)
      }
      console.log(
        this.symbol,
        hedgeSide,
        hedgeProduct,
        Math.abs(hedgeDeltaClip),
        "Limit:",
        hedgePrice,
        "#",
        hedgeCount,
        "ID",
        deltaOrderId,
      );
      try {
        // SPOT order
        if (hedgeProduct == "-SPOT"){
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
        console.log(err);
        console.log(err.stack);
      }
      hedgeCount++; 

      // Wait the twapInterval of time to see if WS gets any fill message
      console.log(
        this.symbol,
        "Scan Delta Fills for ~",
        twapInterval,
        "seconds"
      );
      for (let i=0; i<twapInterval; i++){
        // Check every second if further Delta Hedging required
        if (Math.abs(hedgeDeltaTotal * fairValue) < (this.minSize * fairValue)) {
          fillFeed.removeEventListener('message', deltaFillListener);
          console.log(this.symbol, "Delta Hedge Complete: Websocket Fill");
          return;
        }
        // Use loadFills() as a backup to websocket
        const filledSize = await fillSize(perpMarket, this.connection, deltaOrderId);
        const fillDeltaTotal = mangoPerpDelta + dipTotalDelta + spotDelta + mangoSpotDelta + filledSize;
        if (Math.abs(fillDeltaTotal * fairValue) < (this.minSize * fairValue)) {
          fillFeed.removeEventListener('message', deltaFillListener);
          console.log(this.symbol, "Delta Hedge Complete: Loaded Fills");
          return;
        }    
        await sleepRandom(fillScan);
      }
      // Avoid overlap of replace orders and fills by checking one last time
      if (Math.abs(hedgeDeltaTotal * fairValue) < (this.minSize * fairValue)) {
        fillFeed.removeEventListener('message', deltaFillListener);
        console.log(this.symbol, "Delta Hedge Complete: Websocket Fill");
        return;
      }
      fillFeed.removeEventListener('message', deltaFillListener);
      const filledSize = await fillSize(perpMarket, this.connection, deltaOrderId);
      const fillDeltaTotal = mangoPerpDelta + dipTotalDelta + spotDelta + mangoSpotDelta + filledSize;
      if (Math.abs(fillDeltaTotal * fairValue) < (this.minSize * fairValue)) {
        console.log(this.symbol, "Delta Hedge Complete: Loaded Fills");
        return;
      }
      await this.deltaHedge(
        dipProduct,
        mangoGroup,
        perpMarket,
        spotMarket,
        fillFeed,
        hedgeCount
      );
  }

  async gammaScalp(
    dipProduct: DIPDeposit[],
    mangoGroup: MangoGroup,
    perpMarket: PerpMarket,
    fillFeed: WebSocket
  ): Promise<void> {
    // Underlying price for gamma calculation
    const [mangoCache]: MangoCache[] = await loadPrices(
      mangoGroup,
      this.connection
    );

    const mangoAccount: MangoAccount = (
      await this.client.getMangoAccountsForOwner(
        mangoGroup,
        this.owner.publicKey
      )
    )[0];

    // Makes the recursive gamma scalps safer. Rerun will clear any stale orders. Allows only 2 gamma orders at any time
    await this.cancelStaleOrders(mangoAccount, mangoGroup, perpMarket);

    const fairValue = mangoGroup
      .getPrice(this.marketIndex, mangoCache)
      .toNumber();
    const dipTotalGamma = getDIPGamma(dipProduct, fairValue, this.symbol);

    // Calc scalperWindow std deviation spread from zScore & IV for gamma levels
    const stdDevSpread =
      this.impliedVol / Math.sqrt((365 * 24 * 60 * 60) / scalperWindow) * zScore;
    const netGamma = IS_DEV ? Math.max(0.01, dipTotalGamma * stdDevSpread * fairValue) : dipTotalGamma * stdDevSpread * fairValue;

    console.log(
      this.symbol,
      "Position Gamma Γ:",
      netGamma,
      "Fair Value",
      fairValue
    );

    if ((netGamma * fairValue) < (this.minSize * fairValue)){
      console.log(this.symbol, 'Gamma Hedge Too Small')
      return
    }

    const orderIdGamma = (new Date().getTime())*2;
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
        if (
          (fillEvent.makerClientOrderId.toString() == gammaBidID.toString()) ||
          (fillEvent.takerClientOrderId.toString() == gammaBidID.toString())
        ) {
          console.log(this.symbol, 'Gamma Bid Filled', gammaBidID, new Date().toUTCString());
          fillFeed.removeEventListener('message', gammaFillListener);
          // TODO remove recursion or add explicit termination that corresponds to the rerun timer
          this.gammaScalp(
            dipProduct,
            mangoGroup,
            perpMarket,
            fillFeed
          );
        }
        else if (
          (fillEvent.makerClientOrderId.toString() == gammaAskID.toString()) ||
          (fillEvent.takerClientOrderId.toString() == gammaAskID.toString())
        ) {
          console.log(this.symbol, 'Gamma Ask Filled', gammaAskID, new Date().toUTCString());
          fillFeed.removeEventListener('message', gammaFillListener);
          this.gammaScalp(
            dipProduct,
            mangoGroup,
            perpMarket,
            fillFeed
          );
        }
      }
    };
    if (fillFeed.readyState == 1) {
      fillFeed.addEventListener('message', gammaFillListener);
      console.log(this.symbol, "Listening For Gamma Scalps");
    } else {
      console.log(this.symbol, "Websocket State", fillFeed.readyState)
    }

    // Place Gamma scalp bid & offer
    try{
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
    } catch (err) {
        console.log(this.symbol, "Gamma Bid Error", err);
        console.log(this.symbol, "Gamma Bid Error Details", err.stack);
    }
    try{
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
        console.log(this.symbol, "Gamma Ask Error", err);
        console.log(this.symbol, "Gamma Ask Error Details",err.stack);
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
            console.log(err);
            console.log(err.stack);
          }
          break;
        }
      }
    }
  }
}

async function loadPrices(mangoGroup: MangoGroup, connection: Connection) {
  const [mangoCache]: [MangoCache] = await Promise.all([
    mangoGroup.loadCache(connection),
  ]);
  return [mangoCache];
}

function getDIPDelta(dipProduct: DIPDeposit[], fairValue: number, symbol: string) {
  const impliedVol = THEO_VOL_MAP.get(symbol);
  let yearsUntilMaturity: number;
  let deltaSum = 0;
  for (const dip of dipProduct) {
    yearsUntilMaturity =
      (dip.expirationMs - Date.now()) / (365 * 60 * 60 * 24 * 1_000);
    deltaSum =
      greeks.getDelta(
        fairValue,
        dip.strike,
        yearsUntilMaturity,
        impliedVol,
        rfRate,
        dip.type
      ) *
        dip.qty +
      deltaSum;
  }
  return deltaSum;
}

// Splice delta hedge orders if available liquidity not supportive
function orderSplice(
  qty: number,
  price: number,
  notionalMax: number,
  slippage: number,
  side: BookSide,
  market: PerpMarket
) {
  let spliceFactor:number;
  const [_, nativeQty] = market.uiToNativePriceQuantity(0, qty);
  if (qty > 0 && side.getImpactPriceUi(nativeQty) < price * (1 - slippage)) {
    spliceFactor = Math.max((qty * price) / notionalMax, 1);
    console.log(
      "Sell Price Impact: ",
      side.getImpactPriceUi(nativeQty),
      "High Slippage!",
      spliceFactor
    );
  } else if (
    qty < 0 &&
    side.getImpactPriceUi(nativeQty) > price * (1 + slippage)
  ) {
    spliceFactor = Math.max((qty * price) / notionalMax, 1);
    console.log(
      "Buy Price Impact: ",
      side.getImpactPriceUi(nativeQty),
      "High Slippage!",
      spliceFactor
    );
  } else {
    spliceFactor = 1;
    console.log("Slippage Tolerable", side.getImpactPriceUi(nativeQty));
  }
  return spliceFactor
}

function getDIPGamma(dipProduct: DIPDeposit[], fairValue: number, symbol: string) {
  const impliedVol = THEO_VOL_MAP.get(symbol);
  let yearsUntilMaturity: number;
  let gammaSum = 0;
  for (const dip of dipProduct) {
    yearsUntilMaturity =
      (dip.expirationMs - Date.now()) / (365 * 60 * 60 * 24 * 1_000);
    gammaSum =
      greeks.getGamma(
        fairValue,
        dip.strike,
        yearsUntilMaturity,
        impliedVol,
        rfRate,
        dip.type
      ) *
        dip.qty +
      gammaSum;
    gammaSum = gammaSum;
  }
  return gammaSum;
}

// Fill Size from any perp orders
async function fillSize(
  perpMarket: PerpMarket,
  connection: Connection,
  orderID: number
) {
  let filledQty = 0;
  // Possible issue using loadFills instead of Websocket?
  for (const fill of await perpMarket.loadFills(connection)) {
    if (
      fill.makerClientOrderId.toString() == orderID.toString() ||
      fill.takerClientOrderId.toString() == orderID.toString()
    ) {
      if (fill.takerSide == "buy") {
        filledQty = filledQty + fill.quantity;
      } else if (fill.takerSide == "sell") {
        filledQty = filledQty - fill.quantity;
      }
    }
  }
  return filledQty;
}
// TODO spotFillSize()

// Get Spot Balance
async function getSpotDelta(connection: Connection, symbol: string) {
  let mainDelta = 0;
  let tokenDelta = 0;
  let spotDelta = 0;
  let tokenDecimals = 1;
  let accountList = [mangoTesterPk, optionVaultPk, riskManagerPk];
  for (const account of accountList){
    if (symbol == 'SOL'){
      mainDelta = await connection.getBalance(account)/LAMPORTS_PER_SOL;
    }
    try{
        const tokenAccount = await getAssociatedTokenAddress(tokenToSplMint(symbol), account);
        const balance = await connection.getTokenAccountBalance(tokenAccount);
        const tokenBalance = Number(balance.value.amount);
        tokenDecimals = balance.value.decimals;
        tokenDelta = tokenBalance/Math.pow(10,tokenDecimals);
    } catch (err) {
        tokenDelta = 0;
    }
    // console.log(symbol, "Spot Δ", account.toString(), mainDelta, tokenDelta, spotDelta)
    spotDelta = mainDelta + tokenDelta + spotDelta;
  }
  return spotDelta
}
