// @ts-ignore
import * as greeks from "greeks";

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
  TickSize
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
    console.log("Received a deposit", dipProduct);

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

    await this.deltaHedge(
      dipProduct,
      mangoGroup,
      perpMarket
    );
    await this.gammaScalp(
      dipProduct,
      mangoGroup,
      perpMarket
    );
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
    const dipTotalDelta = getDIPDelta(dipProduct, fairValue);

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
    let orderId = new Date().getTime();
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
          clientOrderId: orderId,
        }
      );
      console.log(
        this.symbol,
        hedgeSide,
        "#",
        hedgeCount,
        "-",
        orderId,
        "Size:",
        Math.abs(hedgeDeltaClip),
        "Price:",
        hedgePrice
      );
      // Reduce hedge by what actually got filled
      let filledSize = await fillSize(perpMarket, this.connection, orderId);
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
      orderId++;
      hedgeCount++;
    }
    console.log(this.symbol, "Delta Hedge Complete");
  }

  async gammaScalp(
    dipProduct: DIPDeposit[],
    mangoGroup: MangoGroup,
    perpMarket: PerpMarket
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

    let fairValue = mangoGroup
      .getPrice(this.marketIndex, mangoCache)
      .toNumber();
    let orderId = new Date().getTime();
    const dipTotalGamma = getDIPGamma(dipProduct, fairValue);

    // Calc scalperWindow std deviation spread from zScore & IV for gamma levels
    const stdDevSpread =
      this.impliedVol / Math.sqrt((365 * 24 * 60 * 60) / scalperWindow) * zScore;
    const netGamma = dipTotalGamma * stdDevSpread * fairValue;

    console.log(
      this.symbol,
      "Position Gamma:",
      netGamma,
      "Fair Value",
      fairValue
    );

    if ((netGamma * fairValue) < (this.tickSize * fairValue)){
      console.log('Gamma Hedge too small')
      return
    }

    // Place Gamma scalp bid & offer
    const gammaBid = fairValue * (1 - stdDevSpread);
    const gammaBidID = orderId + 1;
    const gammaAsk = fairValue * (1 + stdDevSpread);
    const gammaAskID = orderId + 2;
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

    // Check by periods per scalperWindow for fills matching either gamma scalp and rerun after scalperWindow expires
    let timeWaited: number = 0;
    let filledBidGamma: number;
    let filledAskGamma: number;
    while (timeWaited < scalperWindow) {
      mangoAccount = (
        await this.client.getMangoAccountsForOwner(
          mangoGroup,
          this.owner.publicKey
        )
      )[0];
      const gammaOrders = mangoAccount.getPerpOpenOrders();
      let numGammaOrders = 0;
      for (const order of gammaOrders) {
        if (order.marketIndex == this.marketIndex) {
          numGammaOrders = numGammaOrders + 1;
        }
      }
      // Check for lost orders
      if (numGammaOrders != 2) {
        console.log("Lost Orders!");
        break;
      }
      console.log(
        this.symbol,
        "Periods Elpased:",
        timeWaited / (scalperWindow / periods),
        "GammaOrders:",
        numGammaOrders,
        "Wait:",
        scalperWindow / periods,
        "seconds"
      );
      await sleepTime(scalperWindow / periods);
      filledBidGamma = Math.abs(
        await fillSize(perpMarket, this.connection, gammaBidID)
      );
      filledAskGamma = Math.abs(
        await fillSize(perpMarket, this.connection, gammaAskID)
      );
      if (filledBidGamma > 0 || filledAskGamma > 0) {
        console.log(
          this.symbol,
          "Bid filled",
          filledBidGamma,
          "Ask filled",
          filledAskGamma
        );
        break;
      }
      // Check if near just pasted 12UTC to reset in case of DIP exiry
      if (
        timeSinceMidDay() < scalperWindow / periods &&
        timeSinceMidDay() >= 0
      ) {
        console.log(
          "MidDay Reset during Gamma Scalp",
          timeSinceMidDay(),
          "seconds past 12:00 UTC"
        );
        break;
      }
      timeWaited += scalperWindow / periods;
    }
    this.scalperMango(dipProduct); // recursion on for testing, remove when we have 10 min re-runs
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

function getDIPDelta(dipProduct: DIPDeposit[], fairValue: number) {
  const impliedVol = THEO_VOL_MAP.get(dipProduct[0].splToken);
  let yearsUntilMaturity: number;
  let deltaSum = 0;
  for (const dip of dipProduct) {
    yearsUntilMaturity =
      (dip.expiration - Date.now()) / (365 * 60 * 60 * 24 * 1_000);
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

// Fill Size from Delta Hedging & Gamma Scalps
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

function getDIPGamma(dipProduct: DIPDeposit[], fairValue: number) {
  const impliedVol = THEO_VOL_MAP.get(dipProduct[0].splToken);
  let yearsUntilMaturity: number;
  let gammaSum = 0;
  for (const dip of dipProduct) {
    yearsUntilMaturity =
      (dip.expiration - Date.now()) / (365 * 60 * 60 * 24 * 1_000);
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
