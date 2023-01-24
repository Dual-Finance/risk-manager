import WebSocket from 'ws';
import { VIAL_WS_URL } from './config';

export type SerumVialTradeMessage = {
  readonly type: 'trade';
  readonly price: string;
  readonly size: number;
  readonly side: 'buy' | 'sell';
  readonly id: number;
  readonly market: string;
  readonly version: number;
  readonly slot: number;
  readonly timestamp: string;
  readonly takerAccount: string;
  readonly makerAccount: string;
  readonly takerOrderId: string;
  readonly makerOrderId: string;
  readonly takerClientId: string;
  readonly makerClientId: string;
  readonly takerFeeCost: number;
  readonly makerFeeCost: number;
};

export function tradeMessageToString(message: SerumVialTradeMessage) {
  return `size: ${message.size} market: ${message.market} price: ${message.price} \
makerId: ${message.makerClientId} takerId: ${message.takerClientId} time: ${message.timestamp}`;
}

export class SerumVialClient {
  private ws: WebSocket | undefined = undefined;

  private disposed = false;

  public streamData(
    channels: string[],
    markets: string[],
    orderIds: string[],
    onmessage: (message: any) => void,
  ) {
    this.ws.onmessage = (msg) => {
      const message = JSON.parse(msg.data as string);
      if (message.type === 'trade') {
        const tradeMessage = message as SerumVialTradeMessage;
        for (let i = 0; i < orderIds.length; i++) {
          if (
            tradeMessage.makerClientId === orderIds[i]
            || tradeMessage.takerClientId === orderIds[i]
          ) {
            onmessage(tradeMessage);
          }
        }
      }
    };

    this.ws.onclose = (_ev) => {
      if (this.disposed) {
        return;
      }

      this.streamData(channels, markets, orderIds, onmessage);
    };

    const subPayloads = channels.map((channel) => JSON.stringify({
      op: 'subscribe',
      channel,
      markets,
    }));

    if (this.ws.readyState !== WebSocket.OPEN) {
      this.ws.onopen = () => {
        for (const subRequest of subPayloads) {
          this.ws!.send(subRequest);
        }
      };
    } else {
      for (const subRequest of subPayloads) {
        this.ws.send(subRequest);
      }
    }

    return () => {
      this.disposed = true;
      if (this.ws) {
        this.ws.close();
      }
    };
  }

  public openSerumVial() {
    this.ws = new WebSocket(VIAL_WS_URL);
  }

  public closeSerumVial() {
    this.ws.close();
  }

  public removeAnyListeners() {
    this.ws.onmessage = () => {};
  }

  public checkSerumVial() {
    const state = this.ws.readyState;
    return state;
  }
}
