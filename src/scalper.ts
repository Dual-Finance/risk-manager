import * as os from 'os';
import * as fs from 'fs';
// @ts-ignore
import * as greeks from 'greeks';
import WebSocket from "ws";
import {
  Config,
  getMarketByBaseSymbolAndKind,
  GroupConfig,
  MangoClient,
  MangoCache,
  BookSide,
  PerpMarket,
  MangoGroup,
  MarketConfig,
  PerpEventLayout,
  FillEvent,
  getUnixTs
} from '@blockworks-foundation/mango-client';
import { Keypair, Commitment, Connection } from '@solana/web3.js';
import configFile from './ids.json';
import {
  rfRate,
  networkName,
  THEO_VOL_MAP, 
  maxNotional, 
  slippageTolerance, 
  twapInterval,
  scalperWindow,
} from './config';

function readKeypair() {
  return JSON.parse(
    process.env.KEYPAIR ||
      fs.readFileSync(os.homedir() + '/mango-explorer/id.json', 'utf-8'),
  );
}

// TODO Risk Manager feeds in new DIP position automatically
// Example for Hedging and Scalping current + new DIP Position
interface DIP {splToken: string; premiumAsset: string; expiration: Date; strike: number;
  type: string; qty: number
}

const oldDIP: DIP = {splToken:'SOL', premiumAsset:'USD', expiration:new Date('2022/12/31'), 
strike:60, type:'call', qty:10};

const dipArray = [oldDIP]; // Initialize Array to hold all old DIP positions

const newDIP: DIP = {splToken:'SOL', premiumAsset:'USD', expiration:new Date('2022/12/31'), 
strike:60, type:'call', qty:7};

const impliedVol = THEO_VOL_MAP.get(newDIP.splToken);

// Add new DIP to DIP Position Array 
dipArray.push(newDIP);
//console.log('DIP Array: ', dipArray)

// TODO Iterate by splToken or run seperate instances per
async function scalperPerp() {
  // Setup Client
  const config = new Config(configFile);
  const groupConfig = config.getGroupWithName(networkName) as GroupConfig;
  const connection = new Connection(
    config.cluster_urls[groupConfig.cluster],
    'processed' as Commitment,
  );
  const client = new MangoClient(connection, groupConfig.mangoProgramId);

  // Load Group & Market
  const perpMarketConfig = getMarketByBaseSymbolAndKind(
    groupConfig,
    newDIP.splToken,
    'perp',
  );
  const mangoGroup = await client.getMangoGroup(groupConfig.publicKey);

  const perpMarket = await mangoGroup.loadPerpMarket(
    connection,
    perpMarketConfig.marketIndex,
    perpMarketConfig.baseDecimals,
    perpMarketConfig.quoteDecimals,
  );

  let [mangoCache] = await loadPrices(mangoGroup, connection, perpMarketConfig);

  // Order Authority
  const owner = Keypair.fromSecretKey(Uint8Array.from(readKeypair()));
  let mangoAccount = (
    await client.getMangoAccountsForOwner(mangoGroup, owner.publicKey)
  )[0];

  // Option Parameters
  const marketIndex = perpMarketConfig.marketIndex;
  let fairValue = mangoGroup.getPrice(marketIndex, mangoCache).toNumber();
  console.log('Fair Value: ', fairValue)

  // DELTA HEDGING //
  // Calc DIP delta for new position
  const dipTotalDelta = getDIPDelta(dipArray, fairValue);
  console.log('DIP Delta: ', dipTotalDelta)

  // Get Mango delta position
  const perpAccount = mangoAccount.perpAccounts[marketIndex];
  const mangoDelta = perpAccount.getBasePositionUi(perpMarket);
  console.log('Mango Delta: ', mangoDelta)
  
  // Get Total Delta Position to hedge
  let hedgeDeltaTotal = mangoDelta + dipTotalDelta;
  console.log('Total Hedge Delta: ', hedgeDeltaTotal)

  // Determine if hedge needs to buy or sell delta
  const hedgeSide = hedgeDeltaTotal < 0 ? 'buy' : 'sell';

  // Fetch proper orderbook
  const bookSide = hedgeDeltaTotal < 0 ? await perpMarket.loadAsks(connection) : await perpMarket.loadBids(connection);
  
  // Cancel All stale orders
  let openOrders = mangoAccount.getPerpOpenOrders();
  if (openOrders.length > 0){ 
    await client.cancelAllPerpOrders(mangoGroup, [perpMarket], mangoAccount, owner,);
    console.log('Canceling Old Orders')
  }

  // Delta Hedging Orders, send limit orders through book that should fill
  let hedgeDeltaClip : number;
  let hedgePrice : number;
  let hedgeCount = 1;
  let orderId = new Date().getTime();
  // Break up order depending on whether the book can support it
    while (Math.abs(hedgeDeltaTotal*fairValue) > 1){
      hedgeDeltaClip = hedgeDeltaTotal / orderSplice(hedgeDeltaTotal, fairValue, 
        maxNotional, slippageTolerance, bookSide, perpMarket)
      hedgePrice = hedgeDeltaTotal < 0 ? fairValue * (1+slippageTolerance*hedgeCount) : fairValue * (1-slippageTolerance*hedgeCount); // adjust hedgecount change for mainnet 
      await client.placePerpOrder2(
        mangoGroup,
        mangoAccount,
        perpMarket,
        owner,
        hedgeSide,
        hedgePrice,
        Math.abs(hedgeDeltaClip),
        { orderType: 'limit', expiryTimestamp: getUnixTs() + twapInterval-1, clientOrderId: orderId},
      );
      console.log(hedgeSide,'#', orderId, hedgeCount, 'Size:', hedgeDeltaClip,'Price:', hedgePrice)
      // Reduce hedge by what actually got filled
      let filledSize = await fillSize(perpMarket, connection, orderId)
      console.log('Filled Size', filledSize)
      hedgeDeltaTotal = hedgeDeltaTotal + filledSize;
      console.log('Remaining Size ', hedgeDeltaTotal)

      // No need to wait for the twap interval if filled
      if (Math.abs(hedgeDeltaTotal*fairValue) < 1){
        console.log('Delta Hedge Complete')
        break
      }
      // Wait the twapInterval of time before sending updated hedge price & qty
      await sleepTime(twapInterval);
      //Update Price
      [mangoCache] = await loadPrices(mangoGroup, connection, perpMarketConfig);
      fairValue = mangoGroup.getPrice(marketIndex, mangoCache).toNumber();
      // Keep count of # of hedges
      orderId = orderId +1;
      hedgeCount = hedgeCount + 1;
    }

  // GAMMA SCALPING //
  const dipTotalGamma = getDIPGamma(dipArray, fairValue);

  // Calc scalperWindow (1 hr) Std dev for gamma levels
  const hrStdDev = impliedVol / Math.sqrt(365 * 24 * 60 * 60 / scalperWindow);
  const netGamma = dipTotalGamma * hrStdDev * fairValue;
  console.log('Position Gamma of ', netGamma)

  // Place Gamma scalp bid & offer
  const gammaBid = fairValue * (1 - hrStdDev);
  const gammaBidID = orderId+1;
  const gammaAsk = fairValue * (1 + hrStdDev);
  const gammaAskID = orderId+2;
  await client.placePerpOrder2(
    mangoGroup,
    mangoAccount,
    perpMarket,
    owner,
    'buy',
    gammaBid,
    netGamma,
    { orderType: 'postOnly', expiryTimestamp: getUnixTs() + scalperWindow-1, clientOrderId: gammaBidID},
  );
  await client.placePerpOrder2(
    mangoGroup,
    mangoAccount,
    perpMarket,
    owner,
    'sell',
    fairValue * (1 + hrStdDev),
    netGamma,
    { orderType: 'postOnly', expiryTimestamp: getUnixTs() + scalperWindow-1, clientOrderId: gammaAskID},
  );
  console.log('Bid', gammaBid, 'ID', gammaBidID)
  console.log('Ask', gammaAsk, 'ID', gammaAskID)

  // Check by periods per scalperWindow for fills matching either gamma scalp and rerun after scalperWindow expires
  let periods = 180;
  let timeWaited = 0;
  let filledBidGamma: number;
  let filledAskGamma: number;
  while (timeWaited < scalperWindow){
    // Check this was buggy here updating account orders
    // mangoAccount = (await client.getMangoAccountsForOwner(mangoGroup, owner.publicKey))[0];
    //console.log('OpenOrders', mangoAccount.getPerpOpenOrders())
    await sleepTime(scalperWindow/periods);
    filledBidGamma = Math.abs(await fillSize(perpMarket, connection, gammaBidID));
    filledAskGamma = Math.abs(await fillSize(perpMarket, connection, gammaAskID));
    if (filledBidGamma > 0 || filledAskGamma > 0){
      console.log('Bid filled', filledBidGamma, 'Ask filled', filledAskGamma)
      break
    }
    timeWaited = timeWaited + scalperWindow/periods;
  }
  console.log('Event Trigger Rerun')
  scalperPerp();
}

scalperPerp();

async function loadPrices(mangoGroup: MangoGroup, connection: Connection,
  perpMarketConfig: MarketConfig){
 let [mangoCache]: [
   MangoCache,
 ] = await Promise.all([
   mangoGroup.loadCache(connection),
 ]);
 return [mangoCache]
}

function getDIPDelta(dipArray: DIP[], fairValue: number){
  let yearsUntilMaturity: number;
  let deltaSum = 0;
  for (const dip of dipArray){
    if (dip.splToken == newDIP.splToken){
      yearsUntilMaturity = (dip.expiration.getTime() - Date.now()) / (365 * 60 * 60 * 24 * 1000) + (0.5/365); // double check this needs half a day extra
      deltaSum = (greeks.getDelta(
        fairValue,
        dip.strike,
        yearsUntilMaturity,
        impliedVol,
        rfRate,
        dip.type
      )* dip.qty) + deltaSum;
      deltaSum = deltaSum;  
    }
  }
  return deltaSum
}

// Splice delta hedge orders if available liquidity not supportive
function orderSplice (qty: number, price: number, notionalMax: number,
   slippage: number, side: BookSide, market: PerpMarket){
  const [_, nativeQty] = market.uiToNativePriceQuantity(0, qty);
  if (qty > 0 && side.getImpactPriceUi(nativeQty) < (price * (1-slippage))){
    console.log('Sell Price Impact: ', side.getImpactPriceUi(nativeQty), 'High Slippage!');
    return Math.max(qty * price / notionalMax, 1)
  }
  else if (qty < 0 && side.getImpactPriceUi(nativeQty) > (price * (1+slippage))) {
    console.log('Buy Price Impact: ', side.getImpactPriceUi(nativeQty), 'High Slippage!')
    return Math.max(qty * price / notionalMax, 1)
  }
  else {
    console.log('Slippage Tolerable', side.getImpactPriceUi(nativeQty))
    return 1
  }
}

// Fill Size from Delta Hedging & Gamma Scalps
async function fillSize(perpMarket: PerpMarket, connection: Connection, orderID: number){
  let filledQty = 0;
  // Possible issue using loadFills instead of Websocket?
  for (const fill of await perpMarket.loadFills(connection)) {
  if (fill.makerClientOrderId.toNumber() == orderID || fill.takerClientOrderId.toNumber() == orderID){    
    if (fill.takerSide == "buy"){
        filledQty = filledQty + fill.quantity
      } else if ( fill.takerSide == "sell") {
        filledQty = filledQty - fill.quantity
      }
      console.log(fill.takerSide, fill.price, fill.quantity, fill.makerClientOrderId.toNumber(), fill.takerClientOrderId.toNumber());
    }
  }
  return filledQty;
}

// Sleep Time Required
function sleepTime(period: number){
  console.log('Wait ', period, 'seconds')
  return new Promise(function(resolve){
    setTimeout(resolve,period*1000)
  });
}

function getDIPGamma(dipArray: DIP[], fairValue: number){
  const impliedVol = THEO_VOL_MAP.get(newDIP.splToken);
  let yearsUntilMaturity: number;
  let gammaSum = 0;
  for (const dip of dipArray){
    if (dip.splToken == newDIP.splToken){
      yearsUntilMaturity = (dip.expiration.getTime() - Date.now()) / (365 * 60 * 60 * 24 * 1000) + (0.5/365);
      gammaSum = (greeks.getGamma(
        fairValue,
        dip.strike,
        yearsUntilMaturity,
        impliedVol,
        rfRate,
        dip.type
      )* dip.qty) + gammaSum;
      gammaSum = gammaSum;  
    }
  }
  return gammaSum
}

// EVENT TODO's//
// Recieve DIP token balance change
// addDIP()
// scalperPerp()

// Receive order fill from gamma levels
// Maybe better to Run Websocket from https://docs.mango.markets/api-and-websocket/fills-websocket-feed
// scalperPerp()

// 1 Hour Timer Expires
// scalperPerp()

// DIP Expires
// removeDIP()
// scalperPerp()
