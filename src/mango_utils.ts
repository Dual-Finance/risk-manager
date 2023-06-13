import WebSocket from 'ws';
import { BookSide, PerpMarket, PerpOrderSide } from '@blockworks-foundation/mango-v4';
import { HedgeProduct } from './config';

export function getMangoHedgeProduct(hedgeSide: PerpOrderSide, buySpot: boolean, sellSpot: boolean):
  HedgeProduct.Spot | HedgeProduct.Perp {
  if (hedgeSide === PerpOrderSide.bid && buySpot) {
    return HedgeProduct.Spot;
  } if (hedgeSide === PerpOrderSide.ask && sellSpot) {
    return HedgeProduct.Spot;
  }
  return HedgeProduct.Perp;
}

// Splice delta hedge orders if available mango liquidity not supportive
export function orderSpliceMango(
  qty: number,
  price: number,
  notionalMax: number,
  slippage: number,
  side: BookSide,
  market: PerpMarket,
) {
  let spliceFactor: number;
  const nativeQty = market.uiBaseToLots(qty);
  if (qty > 0 && side.getImpactPriceUi(nativeQty) < price * (1 - slippage)) {
    spliceFactor = Math.max((qty * price) / notionalMax, 1);
    console.log(`Sell Price Impact: ${side.getImpactPriceUi(nativeQty)} High Slippage!`);
  } else if (
    qty < 0
    && side.getImpactPriceUi(nativeQty) > price * (1 + slippage)
  ) {
    spliceFactor = Math.max((qty * price) / notionalMax, 1);
    console.log(`Buy Price Impact: ${side.getImpactPriceUi(nativeQty)} High Slippage!`);
  } else {
    spliceFactor = 1;
    console.log(`Slippage Tolerable ${side.getImpactPriceUi(nativeQty)}`);
  }
  console.log(`Splice factor: ${spliceFactor}`);
  return spliceFactor;
}

export function connectMangoFillListener(fillFeed: WebSocket, perpMarket: PerpMarket) {
  const fillFeedUpdate = fillFeed;
  const subscriptionData = {
    command: 'subscribe',
    marketId: perpMarket.publicKey.toBase58(),
  };
  fillFeedUpdate.onopen = (_) => {
    fillFeed.send(JSON.stringify(subscriptionData));
    console.log('Connected to Mango Websocket', perpMarket.name, subscriptionData.marketId, new Date().toUTCString());
  };
  fillFeedUpdate.onerror = (error) => {
    console.log(`Websocket Error ${error.message}`);
  };
}

export function setupMangoFillListener(
  fillFeed: WebSocket,
  eventFillListener: (event: WebSocket.MessageEvent) => void,
  perpMarket: PerpMarket,
) {
  if (fillFeed.readyState === WebSocket.OPEN) {
    fillFeed.addEventListener('message', eventFillListener);
    console.log(perpMarket.name, 'Listening For Fills');
  } else {
    connectMangoFillListener(fillFeed, perpMarket);
    console.log(perpMarket.name, 'Websocket State', fillFeed.readyState);
  }
}
