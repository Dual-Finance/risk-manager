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
  getUnixTs,
  PerpEventLayout,
  FillEvent,
} from "@blockworks-foundation/mango-client";
import { Keypair, Commitment, Connection } from "@solana/web3.js";
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
  TickSize,
  FILLS_URL,
  IS_DEV,
  fillScan
} from "./config";
import { DIPDeposit } from "./common";
import { readKeypair, sleepTime } from "./utils";

export class Scalper {
  client: MangoClient;
  connection: Connection;
  groupConfig: GroupConfig;
  config: Config;
  owner: Keypair;
  symbol: string;
  impliedVol: number;
  tickSize: number;
  perpMarketConfig;
  marketIndex: number;

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
    this.tickSize = TickSize.get(symbol)
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

    // Open Mango Websocket
    const fillFeed = new WebSocket(FILLS_URL!);
    fillFeed.onopen = function(e) {
      console.log('Connected to Mango Websocket', new Date().toUTCString())
    };
    fillFeed.onerror = function(error) {
      console.log(`Websocket Error ${error.message}`);
    };

    let hedgeCount = 1;
    await this.deltaHedge(
      dipProduct,
      mangoGroup,
      perpMarket,
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

  async deltaHedge(
    dipProduct: DIPDeposit[],
    mangoGroup: MangoGroup,
    perpMarket: PerpMarket,
    fillFeed: WebSocket,
    hedgeCount: number
  ): Promise<void> {
    // Underlying price for delta calculation
    let [mangoCache]: MangoCache[] = await loadPrices(
      mangoGroup,
      this.connection
    );

    let mangoAccount: MangoAccount = (
      await this.client.getMangoAccountsForOwner(
        mangoGroup,
        this.owner.publicKey
      )
    )[0];

    let fairValue = mangoGroup
      .getPrice(this.marketIndex, mangoCache)
      .toNumber();

    // Calc DIP delta for new position
    const dipTotalDelta = getDIPDelta(dipProduct, fairValue, this.symbol);

    // Get Mango delta position
    let perpAccount = mangoAccount.perpAccounts[this.marketIndex];
    let mangoDelta = perpAccount.getBasePositionUi(perpMarket);

    // Get Total Delta Position to hedge
    let hedgeDeltaTotal = mangoDelta + dipTotalDelta;

    // Determine if hedge needs to buy or sell delta
    const hedgeSide = hedgeDeltaTotal < 0 ? "buy" : "sell";
    
    // Check if Delta Hedge is greater than min tick size
    if (Math.abs(hedgeDeltaTotal * fairValue) < (this.tickSize * fairValue)) {
      console.log(this.symbol, "is Delta Netural");
      return;
    }

    // Fetch proper orderbook
    const bookSide =
      hedgeDeltaTotal < 0
        ? await perpMarket.loadAsks(this.connection)
        : await perpMarket.loadBids(this.connection);

    await this.cancelStaleOrders(mangoAccount, mangoGroup, perpMarket);

    // Delta Hedging Orders, send limit orders through book that should fill
    let hedgeDeltaClip: number;
    let hedgePrice: number;
    let deltaOrderId = (new Date().getTime())*2;
    console.log(
      this.symbol,
      "Target Delta Hedge:",
      hedgeSide,
      hedgeDeltaTotal*-1,
      "DIP Delta:",
      dipTotalDelta,
      "Mango Delta:",
      mangoDelta,
      "Fair Value:", 
      fairValue
    );

    // Break up order depending on whether the book can support it
      hedgeDeltaClip =
        hedgeDeltaTotal /
        orderSplice(
          hedgeDeltaTotal,
          fairValue,
          maxNotional,
          slippageTolerance,
          bookSide,
          perpMarket
        );

      hedgePrice =
        hedgeDeltaTotal < 0
          ? IS_DEV ? fairValue * (1 + slippageTolerance*hedgeCount) : fairValue * (1 + slippageTolerance)
          : IS_DEV ? fairValue * (1 - slippageTolerance*hedgeCount) : fairValue * (1 - slippageTolerance);

      // Start listening for Delta Hedge Fills
      const deltaFillListener = async (event) => {
        const parsedEvent = JSON.parse(event.data);
        if (
          parsedEvent['status'] === 'New' &&
          parsedEvent['market'] === this.symbol.concat("-PERP")
        ) {
          const fillBytes = Buffer.from(parsedEvent['event'], 'base64');
          const fillEvent: FillEvent = PerpEventLayout.decode(fillBytes).fill;
          if (
            (fillEvent.makerClientOrderId.toString() == deltaOrderId.toString()) ||
            (fillEvent.takerClientOrderId.toString() == deltaOrderId.toString())
          ) {
            let fillQty:number;
            fillQty = hedgeSide == 'buy' ? fillEvent.quantity.toNumber()/100 : -1 * fillEvent.quantity.toNumber()/100;
            let fillPrice = fillEvent.price.toNumber()/100;
            hedgeDeltaTotal = hedgeDeltaTotal + fillQty;
            console.log(
              this.symbol,
              'Delta Filled',
              hedgeSide,
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
      fillFeed.addEventListener('message', deltaFillListener);
      console.log(this.symbol, "Listening For Delta Hedges")

      console.log(
        this.symbol,
        hedgeSide,
        "#",
        hedgeCount,
        "-",
        deltaOrderId,
        "Size:",
        Math.abs(hedgeDeltaClip),
        "Limit:",
        hedgePrice
      );
      try {
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
            expiryTimestamp: getUnixTs() + twapInterval - 1,
            clientOrderId: deltaOrderId,
          }
        );
      } catch (err) {
        console.log(err);
      }
      hedgeCount++;
      // Wait the twapInterval of time to see if WS gets any fill message
      console.log(
        this.symbol,
        "Scan Delta Fills for",
        twapInterval,
        "seconds"
      );
      for (let i=0; i<twapInterval; i++){
        // Check every second if further Delta Hedging required
        if (Math.abs(hedgeDeltaTotal * fairValue) < (this.tickSize * fairValue)) {
          fillFeed.removeEventListener('message', deltaFillListener);
          console.log(this.symbol, "Delta Hedge Complete");
          return;
        }
        await sleepTime(fillScan);
      }
      fillFeed.removeEventListener('message', deltaFillListener);
      await this.deltaHedge(
        dipProduct,
        mangoGroup,
        perpMarket,
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
    let [mangoCache]: MangoCache[] = await loadPrices(
      mangoGroup,
      this.connection
    );

    let mangoAccount: MangoAccount = (
      await this.client.getMangoAccountsForOwner(
        mangoGroup,
        this.owner.publicKey
      )
    )[0];

    // Makes the recursive gamma scalps safer. Rerun will clear any stale orders. Allows only 2 gamma orders at any time
    await this.cancelStaleOrders(mangoAccount, mangoGroup, perpMarket);

    let fairValue = mangoGroup
      .getPrice(this.marketIndex, mangoCache)
      .toNumber();
    let orderIdGamma = (new Date().getTime())*2;
    const dipTotalGamma = getDIPGamma(dipProduct, fairValue, this.symbol);

    // Calc scalperWindow std deviation spread from zScore & IV for gamma levels
    const stdDevSpread =
      this.impliedVol / Math.sqrt((365 * 24 * 60 * 60) / scalperWindow) * zScore;
    const netGamma = IS_DEV ? Math.max(0.01, dipTotalGamma * stdDevSpread * fairValue) : dipTotalGamma * stdDevSpread * fairValue;

    console.log(
      this.symbol,
      "Position Gamma:",
      netGamma,
      "Fair Value",
      fairValue
    );

    if ((netGamma * fairValue) < (this.tickSize * fairValue)){
      console.log(this.symbol, 'Gamma Hedge Too Small')
      return
    }

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
    fillFeed.addEventListener('message', gammaFillListener);
    console.log(this.symbol, "Listening For Gamma Scalps");

    // Place Gamma scalp bid & offer
    const gammaBid = fairValue * (1 - stdDevSpread);
    const gammaBidID = orderIdGamma + 1;
    const gammaAsk = fairValue * (1 + stdDevSpread);
    const gammaAskID = orderIdGamma + 2;
    try{
      await this.client.placePerpOrder2(
        mangoGroup,
        mangoAccount,
        perpMarket,
        this.owner,
        "buy",
        gammaBid,
        netGamma,
        { orderType: "postOnly", clientOrderId: gammaBidID }
      );
    } catch (err) {
      console.log(err);
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
        { orderType: "postOnly", clientOrderId: gammaAskID }
      );
    } catch (err) {
      console.log(err);
    }
    console.log(this.symbol, "Gamma Bid", gammaBid, "ID", gammaBidID);
    console.log(this.symbol, "Gamma Ask", gammaAsk, "ID", gammaAskID);
  }

  async cancelStaleOrders(
    mangoAccount: MangoAccount,
    mangoGroup: MangoGroup,
    perpMarket: PerpMarket
  ): Promise<void> {
    let openOrders = mangoAccount.getPerpOpenOrders();
    if (openOrders.length > 0) {
      for (const order of openOrders) {
        if (order.marketIndex == this.marketIndex) {
          await this.client.cancelAllPerpOrders(
            mangoGroup,
            [perpMarket],
            mangoAccount,
            this.owner
          );
          console.log(this.symbol,"Canceling Orders");
          break;
        }
      }
    }
  }
}

async function loadPrices(mangoGroup: MangoGroup, connection: Connection) {
  let [mangoCache]: [MangoCache] = await Promise.all([
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
