import * as os from 'os';
import * as fs from 'fs';
// @ts-ignore
import * as greeks from 'greeks';
import {
  Config,
  getMarketByBaseSymbolAndKind,
  GroupConfig,
  MangoClient,
  MangoCache,
  BookSide,
  PerpMarket,
  MangoGroup,
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
  monthAdj,
} from './config';

// TODO Risk Manager feeds in new DIP position automatically
// Risk Manager sends new DIP positions upon User deposit into DIPs without MM fill
// See DIP object below for fields
interface DIP {splToken: string; premiumAsset: string; expiration: Date; strike: number;
  type: string; qty: number
}

// Example for Hedging and Scalping current + new DIP Position
const oldDIP: DIP = {splToken:'SOL', premiumAsset:'USD', expiration:new Date(Date.UTC(2022,8-monthAdj,7,12,0,0,0)), 
strike:40, type:'call', qty:6};
const otherDIP: DIP = {splToken:'BTC', premiumAsset:'USD', expiration:new Date(Date.UTC(2022,8-monthAdj,6,12,0,0,0)), 
strike:25000, type:'call', qty:0.01};
const lastDIP: DIP = {splToken:'ETH', premiumAsset:'USD', expiration:new Date(Date.UTC(2022,8-monthAdj,9,12,0,0,0)), 
strike:1800, type:'call', qty:0.1};

const allDIP = [oldDIP, otherDIP, lastDIP]; // Initialize Array to hold all old DIP positions

// Recieve DIP token balance change, new DIP fed from risk manager
const newDIP: DIP = {splToken:'SOL', premiumAsset:'USD', expiration:new Date(Date.UTC(2022,12-monthAdj,31,12,0,0,0)), 
strike:60, type:'call', qty:7};
allDIP.push(newDIP); // Add new DIP to DIP Position Array 

// Remove All Expired DIP
const currentDIP = allDIP.filter(dip => ((dip.expiration.getTime() - Date.now()) / (365 * 60 * 60 * 24 * 1000)) >0)
console.log('Live Positions', currentDIP);

// Sort DIP by product
const BTC_DIP = [];
const ETH_DIP = [];
const SOL_DIP = [];
for (const dip of currentDIP){
  if (dip.splToken == 'BTC'){
    BTC_DIP.push(dip);
  } else if (dip.splToken == 'ETH') {
    ETH_DIP.push(dip);
  } else if (dip.splToken == 'SOL') {
    SOL_DIP.push(dip);
  }
}
console.log('BTC', BTC_DIP)
console.log('ETH', ETH_DIP)
console.log('SOL', SOL_DIP)

// Setup Client
const config = new Config(configFile);
const groupConfig = config.getGroupWithName(networkName) as GroupConfig;
const connection = new Connection(
  config.cluster_urls[groupConfig.cluster],
  'processed' as Commitment,
);
const client = new MangoClient(connection, groupConfig.mangoProgramId);

// Order Authority
const owner = Keypair.fromSecretKey(Uint8Array.from(readKeypair()));

// TODO setup process to restart at 12:01 UTC each day
// TODO Reconnect logic
// try {
//   scalperMango();
// } catch(e) 
// {
//   sleepTime(twapInterval);
//   scalperMango();
// }

// Run Scalper for each splToken
if (SOL_DIP.length > 0){scalperMango(SOL_DIP);}
//if (BTC_DIP.length > 0){scalperMango(BTC_DIP);}
if (ETH_DIP.length > 0){scalperMango(ETH_DIP);}

async function scalperMango(dipProduct: DIP[]) {
  
  // Symbol specific parameters
  const symbol = dipProduct[0].splToken;
  const impliedVol = THEO_VOL_MAP.get(symbol);
  
  // Load Group & Market
  const perpMarketConfig = getMarketByBaseSymbolAndKind(
   groupConfig,
   symbol,
   'perp',
  );
  const marketIndex = perpMarketConfig.marketIndex;
  const mangoGroup = await client.getMangoGroup(groupConfig.publicKey);
  const perpMarket = await mangoGroup.loadPerpMarket(
    connection,
    marketIndex,
    perpMarketConfig.baseDecimals,
    perpMarketConfig.quoteDecimals,
  );
  let [mangoCache] = await loadPrices(mangoGroup, connection);
  let mangoAccount = (
    await client.getMangoAccountsForOwner(mangoGroup, owner.publicKey)
  )[0];

  // DELTA HEDGING //
  // Underlying price for option calculation
  let fairValue = mangoGroup.getPrice(marketIndex, mangoCache).toNumber();
  // Calc DIP delta for new position
  const dipTotalDelta = getDIPDelta(dipProduct, fairValue);

  // Get Mango delta position
  const perpAccount = mangoAccount.perpAccounts[marketIndex];
  const mangoDelta = perpAccount.getBasePositionUi(perpMarket);
  
  // Get Total Delta Position to hedge
  let hedgeDeltaTotal = mangoDelta + dipTotalDelta;
  
  // Determine if hedge needs to buy or sell delta
  const hedgeSide = hedgeDeltaTotal < 0 ? 'buy' : 'sell';

  // Fetch proper orderbook
  const bookSide = hedgeDeltaTotal < 0 ? await perpMarket.loadAsks(connection) : await perpMarket.loadBids(connection);
  
  // Cancel All stale orders
  let openOrders = mangoAccount.getPerpOpenOrders();
  // console.log('All Open Orders', openOrders)
  if (openOrders.length > 0){
    for(const order of openOrders){ 
      if (order.marketIndex == marketIndex){
        await client.cancelAllPerpOrders(mangoGroup, [perpMarket], mangoAccount, owner,);
        console.log('Canceling', symbol, 'Orders')
      }
    }
  }

  // Delta Hedging Orders, send limit orders through book that should fill
  let hedgeDeltaClip : number;
  let hedgePrice : number;
  let hedgeCount = 1;
  let orderId = new Date().getTime();
  console.log(symbol, hedgeSide, 'Target Hedge Delta:', hedgeDeltaTotal, 'DIP Delta:', dipTotalDelta, 'Mango Delta:', mangoDelta)
  // Break up order depending on whether the book can support it
    while (Math.abs(hedgeDeltaTotal*fairValue) > 1){
      console.log(symbol, 'Fair Value:', fairValue)
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
      console.log(symbol, hedgeSide,'#', hedgeCount,"-", orderId, 'Size:', hedgeDeltaClip,'Price:', hedgePrice)
      
      // Reduce hedge by what actually got filled
      let filledSize = await fillSize(perpMarket, connection, orderId)
      hedgeDeltaTotal = hedgeDeltaTotal + filledSize;
      console.log(symbol,'Filled Size', filledSize, 'Remaining Size ', hedgeDeltaTotal)

      // No need to wait for the twap interval if filled
      if (Math.abs(hedgeDeltaTotal*fairValue) < 1){
        break
      }
      // Wait the twapInterval of time before sending updated hedge price & qty
      console.log(symbol, 'Wait:', twapInterval, 'seconds');
      await sleepTime(twapInterval);

      //Update Price
      [mangoCache] = await loadPrices(mangoGroup, connection);
      fairValue = mangoGroup.getPrice(marketIndex, mangoCache).toNumber();

      // Keep count of # of hedges & create new orderID
      orderId = orderId + 1;
      hedgeCount = hedgeCount + 1;
    }
  console.log(symbol,'Delta Hedge Complete')

  // GAMMA SCALPING //
  const dipTotalGamma = getDIPGamma(dipProduct, fairValue);

  // Calc scalperWindow (1 hr) Std dev for gamma levels
  const hrStdDev = impliedVol / Math.sqrt(365 * 24 * 60 * 60 / scalperWindow);
  const netGamma = dipTotalGamma * hrStdDev * fairValue;
  console.log(symbol, 'Position Gamma:', netGamma)

  // Place Gamma scalp bid & offer
  const gammaBid = fairValue * (1 - hrStdDev);
  const gammaBidID = orderId+1;
  const gammaAsk = fairValue * (1 + hrStdDev);
  const gammaAskID = orderId+2;
  // const gammaExpiryTime = new Date((getUnixTs() + scalperWindow-1)*1000);
  await client.placePerpOrder2(
    mangoGroup,
    mangoAccount,
    perpMarket,
    owner,
    'buy',
    gammaBid,
    netGamma,
    { orderType: 'postOnly', clientOrderId: gammaBidID}, // expiryTimestamp: getUnixTs() + scalperWindow-1
  );
  await client.placePerpOrder2(
    mangoGroup,
    mangoAccount,
    perpMarket,
    owner,
    'sell',
    fairValue * (1 + hrStdDev),
    netGamma,
    { orderType: 'postOnly', clientOrderId: gammaAskID},
  );
  console.log(symbol, 'Bid', gammaBid, 'ID', gammaBidID)
  console.log(symbol, 'Ask', gammaAsk, 'ID', gammaAskID)
  
  
  // Check by periods per scalperWindow for fills matching either gamma scalp and rerun after scalperWindow expires
  let periods = 180;
  let timeWaited = 0;
  let filledBidGamma: number;
  let filledAskGamma: number;
  while (timeWaited < scalperWindow){
    // Check this was buggy here updating account orders
    // Maybe better to Run Websocket from https://docs.mango.markets/api-and-websocket/fills-websocket-feed
    mangoAccount = (await client.getMangoAccountsForOwner(mangoGroup, owner.publicKey))[0];
    console.log(symbol, 'Periods Elpased:', timeWaited/(scalperWindow/periods),'OpenOrders:', mangoAccount.getPerpOpenOrders().length, 'Wait:', scalperWindow/periods, 'seconds')
    await sleepTime(scalperWindow/periods);
    filledBidGamma = Math.abs(await fillSize(perpMarket, connection, gammaBidID));
    filledAskGamma = Math.abs(await fillSize(perpMarket, connection, gammaAskID));
    if (filledBidGamma > 0 || filledAskGamma > 0){
      console.log(symbol, 'Bid filled', filledBidGamma, 'Ask filled', filledAskGamma)
      break
    }
    timeWaited = timeWaited + scalperWindow/periods;
  }
  console.log(symbol, 'Event Trigger Rerun')
  scalperMango(dipProduct);
}

function readKeypair() {
  return JSON.parse(
    process.env.KEYPAIR ||
      fs.readFileSync(os.homedir() + '/mango-explorer/id.json', 'utf-8'),
  );
}

async function loadPrices(mangoGroup: MangoGroup, connection: Connection){
 let [mangoCache]: [
   MangoCache,
 ] = await Promise.all([
   mangoGroup.loadCache(connection),
 ]);
 return [mangoCache]
}

function getDIPDelta(dipProduct: DIP[], fairValue: number){
  const impliedVol = THEO_VOL_MAP.get(dipProduct[0].splToken);
  let yearsUntilMaturity: number;
  let deltaSum = 0;
  for (const dip of dipProduct){
    yearsUntilMaturity = (dip.expiration.getTime() - Date.now()) / (365 * 60 * 60 * 24 * 1000);
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
  if (fill.makerClientOrderId.toString() == orderID.toString() || fill.takerClientOrderId.toString() == orderID.toString()){    
    if (fill.takerSide == "buy"){
        filledQty = filledQty + fill.quantity
      } else if ( fill.takerSide == "sell") {
        filledQty = filledQty - fill.quantity
      }
      //console.log(symbol, fill.takerSide, fill.price, fill.quantity, fill.makerClientOrderId.toString(), fill.takerClientOrderId.toString());
    }
  }
  return filledQty;
}

// Sleep Time Required
function sleepTime(period: number){
  return new Promise(function(resolve){
    setTimeout(resolve,period*1000)
  });
}

function getDIPGamma(dipProduct: DIP[], fairValue: number){
  const impliedVol = THEO_VOL_MAP.get(dipProduct[0].splToken);
  let yearsUntilMaturity: number;
  let gammaSum = 0;
  for (const dip of dipProduct){
    yearsUntilMaturity = (dip.expiration.getTime() - Date.now()) / (365 * 60 * 60 * 24 * 1000);
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
  return gammaSum
}

// TODO run on Serum using RLP collateral!
