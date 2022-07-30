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
  MarketConfig,
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

let oldDIP: DIP = {splToken:'SOL', premiumAsset:'USD', expiration:new Date('2022/12/31'), 
strike:60, type:'call', qty:0};

let dipArray = [oldDIP]; // Initialize Array to hold all old DIP positions

let newDIP: DIP = {splToken:'SOL', premiumAsset:'USD', expiration:new Date('2022/12/31'), 
strike:60, type:'call', qty:10};

let impliedVol = THEO_VOL_MAP.get(newDIP.splToken);

// Add new DIP to DIP Position Array 
dipArray.push(newDIP);
console.log('DIP Array: ', dipArray)

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
  let perpMarketConfig = getMarketByBaseSymbolAndKind(
    groupConfig,
    newDIP.splToken,
    'perp',
  );
  let mangoGroup = await client.getMangoGroup(groupConfig.publicKey);

  let perpMarket = await mangoGroup.loadPerpMarket(
    connection,
    perpMarketConfig.marketIndex,
    perpMarketConfig.baseDecimals,
    perpMarketConfig.quoteDecimals,
  );

  let [mangoCache] = await loadPrices(mangoGroup, connection, perpMarketConfig);

  // Order Authority
  const owner = Keypair.fromSecretKey(Uint8Array.from(readKeypair()));
  const mangoAccount = (
    await client.getMangoAccountsForOwner(mangoGroup, owner.publicKey)
  )[0];

  // Option Parameters
  let marketIndex = perpMarketConfig.marketIndex;
  let fairValue = mangoGroup.getPrice(marketIndex, mangoCache).toNumber();
  console.log('Fair Value: ', fairValue)

  // DELTA HEDGING //
  // Calc DIP delta for new position
  let dipTotalDelta = getDIPDelta(dipArray, fairValue);
  console.log('DIP Delta: ', dipTotalDelta)

  // Get Mango delta position
  let perpAccount = mangoAccount.perpAccounts[marketIndex];
  let mangoDelta = perpAccount.getBasePositionUi(perpMarket);
  console.log('Mango Delta: ', mangoDelta)
  
  // Get Total Delta Position to hedge
  let hedgeDeltaTotal = mangoDelta + dipTotalDelta;
  console.log('Total Hedge Delta: ', hedgeDeltaTotal)

  // Determine if hedge needs to buy or sell delta
  let hedgeSide;
  hedgeDeltaTotal < 0 ? hedgeSide = 'buy' : hedgeSide = 'sell';
  console.log('Hedge Side ', hedgeSide)

  // Fetch proper orderbook
  let bookSide = hedgeDeltaTotal < 0 ? await perpMarket.loadAsks(connection) : await perpMarket.loadBids(connection);
  
  // Delta Hedging Orders
  let hedgeDeltaClip : number;
  let hedgePrice : number;
  let hedgeCount = 1;
  // Break up order depending on whether the book can support it
    while (Math.abs(hedgeDeltaTotal*fairValue) > 1){
      hedgeDeltaClip = hedgeDeltaTotal / orderSplice(hedgeDeltaTotal, fairValue, 
        maxNotional, slippageTolerance, bookSide, perpMarket)
      console.log('Hedge', hedgeCount, 'Size:', hedgeDeltaClip)
      hedgePrice = hedgeDeltaTotal < 0 ? fairValue * (1+slippageTolerance) : fairValue * (1-slippageTolerance);
      console.log('Hedge', hedgeCount, 'Price:', hedgePrice)  
      await client.placePerpOrder2(
        mangoGroup,
        mangoAccount,
        perpMarket,
        owner,
        hedgeSide,
        hedgePrice,
        Math.abs(hedgeDeltaClip),
        { orderType: 'limit'},
      );
      // Check if any size in theory left
      if (hedgeDeltaTotal==hedgeDeltaClip){
        console.log('End TWAP')
        break
      }
      // Wait the twapInterval of time before sending updated hedge price & qty
      await twapTime(twapInterval);
      //Update Price
      [mangoCache] = await loadPrices(mangoGroup, connection, perpMarketConfig)
      fairValue = mangoGroup.getPrice(marketIndex, mangoCache).toNumber();
      // Calc remaining position
      // Todo reduce hedge by what actually got filled
      hedgeDeltaTotal = hedgeDeltaTotal - hedgeDeltaClip;
      console.log('Remaining Size ', hedgeDeltaTotal)
      hedgeCount = hedgeCount + 1;
    }

  // GAMMA SCALPING //
  let dipTotalGamma = getDIPGamma(dipArray, fairValue);

  // Calc 1hr Std dev for gamma levels
  let hrStdDev = impliedVol / Math.sqrt(365 * 24);
  let netGamma = dipTotalGamma * hrStdDev * fairValue;
  console.log('Position Gamma of ', netGamma)

  // Place Gamma scalp bid & offer
  let gammaBid = fairValue * (1 - hrStdDev)
  let gammaAsk = fairValue * (1 + hrStdDev)
  await client.placePerpOrder2(
    mangoGroup,
    mangoAccount,
    perpMarket,
    owner,
    'buy',
    gammaBid,
    netGamma,
    { orderType: 'limit'},
  );
  await client.placePerpOrder2(
    mangoGroup,
    mangoAccount,
    perpMarket,
    owner,
    'sell',
    fairValue * (1 + hrStdDev),
    netGamma,
    { orderType: 'limit'},
  );
  console.log('Bid', gammaBid)
  console.log('Ask', gammaAsk)

  // TODO Start 1 hour timer

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
      yearsUntilMaturity = (dip.expiration.getTime() - Date.now()) / (365 * 60 * 60 * 24 * 1000) + (0.5/365);
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
  let [_, nativeQty] = market.uiToNativePriceQuantity(0, qty);
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

// TWAP Time Required
function twapTime(period: number){
  console.log('Wait ', period, 'seconds')
  return new Promise(function(resolve){
    setTimeout(resolve,period*1000)
  });
}

function getDIPGamma(dipArray: DIP[], fairValue: number){
  let impliedVol = THEO_VOL_MAP.get(newDIP.splToken);
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
// scalperPerp()

// 1 Hour Timer Expires
// scalperPerp()

// DIP Expires
// removeDIP()
// scalperPerp()