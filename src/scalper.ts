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
  BN
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
  periods,
  zScore,
  TickSize,
  FILLS_URL
} from "./config";
import { DIPDeposit } from "./common";
import { readKeypair, sleepTime, timeSinceMidDay } from "./utils";

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

    // Open Mango Websocket Start to listen for fills on a specific market
    const fillFeed = new WebSocket(FILLS_URL!);
    fillFeed.onopen = function(e) {
      console.log('Connected to Mango Websocket', fillFeed.readyState)
    };
    fillFeed.onerror = function(error) {
      console.log(`Websocket Error ${error.message}`);
    };

    await this.deltaHedge(
      dipProduct,
      mangoGroup,
      perpMarket
    );
    let gammaOrderIds = await this.gammaScalp(
      dipProduct,
      mangoGroup,
      perpMarket,
    );

    const fillListener = (event) => {
      console.log('WS Message')
      const parsedEvent = JSON.parse(event.data);
      if (
        parsedEvent['status'] === 'New' &&
        parsedEvent['market'] === this.symbol.concat("-PERP")
      ) {
        const fillBytes = Buffer.from(parsedEvent['event'], 'base64');
        const fillEvent: FillEvent = PerpEventLayout.decode(fillBytes).fill;
        console.log(
          'WS Fill',
          parsedEvent.market,
          'Taker',
          fillEvent.takerSide,
          fillEvent.price.toNumber()/100,
          fillEvent.quantity.toNumber()/100,
          fillEvent.takerClientOrderId.toString(),
          fillEvent.makerClientOrderId.toString(),
          fillEvent.timestamp.toNumber()
        );

        if (
          (fillEvent.makerClientOrderId.toString() == gammaOrderIds[0].toString()) ||
          (fillEvent.takerClientOrderId.toString() == gammaOrderIds[0].toString())
        ) {
          console.log('Gamma Bid Filled', gammaOrderIds[0], new Date().toUTCString());
          // This will only run once after receiving a fill, breaks on await
          this.gammaScalp(
            dipProduct,
            mangoGroup,
            perpMarket
          );
        }
        else if (
          (fillEvent.makerClientOrderId.toString() == gammaOrderIds[1].toString()) ||
          (fillEvent.takerClientOrderId.toString() == gammaOrderIds[1].toString())
        ) {
          console.log('Gamma Ask Filled', gammaOrderIds[1], new Date().toUTCString());
          this.gammaScalp(
            dipProduct,
            mangoGroup,
            perpMarket
          );
        }
      }
    };
    // Only add one event listener
    fillFeed.addEventListener('message', fillListener);
    console.log(this.symbol, "Listening For Gamma Scalps", new Date().toUTCString())
  }

  async deltaHedge(
    dipProduct: DIPDeposit[],
    mangoGroup: MangoGroup,
    perpMarket: PerpMarket
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
    const perpAccount = mangoAccount.perpAccounts[this.marketIndex];
    const mangoDelta = perpAccount.getBasePositionUi(perpMarket);

    // Get Total Delta Position to hedge
    let hedgeDeltaTotal = mangoDelta + dipTotalDelta;

    // Determine if hedge needs to buy or sell delta
    const hedgeSide = hedgeDeltaTotal < 0 ? "buy" : "sell";

    // Fetch proper orderbook
    const bookSide =
      hedgeDeltaTotal < 0
        ? await perpMarket.loadAsks(this.connection)
        : await perpMarket.loadBids(this.connection);

    await this.cancelStaleOrders(mangoAccount, mangoGroup, perpMarket);

    // Delta Hedging Orders, send limit orders through book that should fill
    let hedgeDeltaClip: number;
    let hedgePrice: number;
    let hedgeCount = 1;
    let orderIdDelta = (new Date().getTime())*2;
    console.log(
      this.symbol,
      hedgeSide,
      "Target Hedge Delta:",
      hedgeDeltaTotal,
      "DIP Delta:",
      dipTotalDelta,
      "Mango Delta:",
      mangoDelta
    );

    // Break up order depending on whether the book can support it
    while (Math.abs(hedgeDeltaTotal * fairValue) > (this.tickSize * fairValue)) {
      console.log(this.symbol, "Fair Value:", fairValue);
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
          ? fairValue * (1 + slippageTolerance)
          : fairValue * (1 - slippageTolerance);

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
          clientOrderId: orderIdDelta,
        }
      );
      console.log(
        this.symbol,
        hedgeSide,
        "#",
        hedgeCount,
        "-",
        orderIdDelta,
        "Size:",
        Math.abs(hedgeDeltaClip),
        "Price:",
        hedgePrice
      );
      // Reduce hedge by what actually got filled
      // TODO also implement WS here
      let filledSize = await fillSize(perpMarket, this.connection, orderIdDelta);
      hedgeDeltaTotal = hedgeDeltaTotal + filledSize;
      console.log(
        this.symbol,
        "Filled",
        hedgeSide,
        "Size",
        filledSize,
        "Remaining Size ",
        hedgeDeltaTotal
      );

      // No need to wait for the twap interval if filled
      if (Math.abs(hedgeDeltaTotal * fairValue) < (this.tickSize * fairValue)) {
        break;
      }
      // Wait the twapInterval of time before sending updated hedge price & qty
      console.log(
        this.symbol,
        "Delta Hedge",
        hedgeCount + 1,
        "Wait:",
        twapInterval,
        "seconds"
      );
      await sleepTime(twapInterval);

      // Update Price
      [mangoCache] = await loadPrices(mangoGroup, this.connection);
      fairValue = mangoGroup.getPrice(this.marketIndex, mangoCache).toNumber();

      // Keep count of # of hedges & create new orderID
      orderIdDelta++;
      hedgeCount++;
    }
    console.log(this.symbol, "Delta Hedge Complete");
  }

  async gammaScalp(
    dipProduct: DIPDeposit[],
    mangoGroup: MangoGroup,
    perpMarket: PerpMarket
  ): Promise<number[]> {
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

    await this.cancelStaleOrders(mangoAccount, mangoGroup, perpMarket);

    let fairValue = mangoGroup
      .getPrice(this.marketIndex, mangoCache)
      .toNumber();
    let orderIdGamma = (new Date().getTime())*2;
    const dipTotalGamma = getDIPGamma(dipProduct, fairValue, this.symbol);

    // Calc scalperWindow std deviation spread from zScore & IV for gamma levels
    const stdDevSpread =
      this.impliedVol / Math.sqrt((365 * 24 * 60 * 60) / scalperWindow) * zScore;
    //const netGamma = dipTotalGamma * stdDevSpread * fairValue;
    const netGamma = 0.01; // Just for testing. Remove for mainnet

    console.log(
      this.symbol,
      "Position Gamma:",
      netGamma,
      "Fair Value",
      fairValue
    );

    if ((netGamma * fairValue) < (this.tickSize * fairValue)){
      console.log(this.symbol, 'Gamma Hedge too small')
      return
    }

    // Place Gamma scalp bid & offer
    const gammaBid = fairValue * (1 - stdDevSpread);
    const gammaBidID = orderIdGamma + 1;
    const gammaAsk = fairValue * (1 + stdDevSpread);
    const gammaAskID = orderIdGamma + 2;
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
    console.log(this.symbol, "Bid", gammaBid, "ID", gammaBidID);
    console.log(this.symbol, "Ask", gammaAsk, "ID", gammaAskID);
    const gammaOrders = [gammaBidID, gammaAskID];
    return gammaOrders;
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
          console.log("Canceling", this.symbol, "Orders");
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
  const [_, nativeQty] = market.uiToNativePriceQuantity(0, qty);
  if (qty > 0 && side.getImpactPriceUi(nativeQty) < price * (1 - slippage)) {
    console.log(
      "Sell Price Impact: ",
      side.getImpactPriceUi(nativeQty),
      "High Slippage!"
    );
    return Math.max((qty * price) / notionalMax, 1);
  } else if (
    qty < 0 &&
    side.getImpactPriceUi(nativeQty) > price * (1 + slippage)
  ) {
    console.log(
      "Buy Price Impact: ",
      side.getImpactPriceUi(nativeQty),
      "High Slippage!"
    );
    return Math.max((qty * price) / notionalMax, 1);
  } else {
    console.log("Slippage Tolerable", side.getImpactPriceUi(nativeQty));
    return 1;
  }
}

// Fill Size from Delta Hedging
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

async function matchOpenOrders(perpMarket: PerpMarket, mangoAccount: MangoAccount, connection: Connection, orderID: number){
  let isOpen = false;
  for (const order of await perpMarket.loadOrdersForAccount(connection, mangoAccount)){
    if (order.clientId.toString() == orderID.toString()) {
      isOpen = true;
    }
  }
  return isOpen;
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

// Maybe seperate out fill listening to here
// function fillMatcher(orderId:number, event:any) {
//   console.log('got here')
//   let fillTs: number | undefined;
//   let fill: FillEvent | undefined;
//   const parsedEvent = JSON.parse(event.data);
//   if (
//     parsedEvent['status'] === 'New' &&
//     parsedEvent['market'] === this.symbol.concat("-PERP")
//   ) {
//     const fillBytes = Buffer.from(parsedEvent['event'], 'base64');
//     const fillEvent: FillEvent = PerpEventLayout.decode(fillBytes).fill;
//     console.log(
//       'WS Fill',
//       parsedEvent.market,
//       'Taker',
//       fillEvent.takerSide,
//       fillEvent.price.toNumber()/100,
//       fillEvent.quantity.toNumber()/100,
//       fillEvent.takerClientOrderId.toString(),
//       fillEvent.makerClientOrderId.toString(),
//       fillEvent.timestamp.toNumber()
//     );
//     // Check Any Order ID
//     if (
//       (fillEvent.maker.equals(this.owner.publicKey) &&
//         fillEvent.makerClientOrderId.eq(new BN(orderId))) ||
//       (fillEvent.taker.equals(this.owner.publicKey) &&
//         fillEvent.takerClientOrderId.eq(new BN(orderId + 1)))
//     ) {
//       fill = fillEvent;
//       fillTs = Date.now();
//       console.log('benchmark::fill', fill.timestamp.toNumber(), fillTs);
//       return fill.quantity.toNumber()/100;
//     }
//   }
// };