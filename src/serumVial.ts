import WebSocket from 'ws';

const WS_URL = 'wss://vial.mngo.cloud/v1/ws';

export class SerumVialClient {
  private _ws: WebSocket | undefined = undefined;

  private _disposed = false;

  public streamData(
    channels: string[],
    markets: string[],
    orderIds: string[],
    onmessage: (message: any) => void,
  ) {
    this._ws.onmessage = (msg) => {
      const message = JSON.parse(msg.data as string);
      if (message.type === 'trade') {
        const tradeMessage = message as SerumVialTradeMessage;
        for (let i = 0; i < orderIds.length; i++) {
          if (
            tradeMessage.makerClientId == orderIds[i]
            || tradeMessage.takerClientId == orderIds[i]
          ) {
            onmessage(tradeMessage);
          }
        }
      }
    };

    this._ws.onclose = (ev) => {
      if (this._disposed) {
        return;
      }

      this.streamData(channels, markets, orderIds, onmessage);
    };

    const subPayloads = channels.map((channel) => JSON.stringify({
      op: 'subscribe',
      channel,
      markets,
    }));

    if (this._ws.readyState !== WebSocket.OPEN) {
      this._ws.onopen = () => {
        for (const subRequest of subPayloads) {
          this._ws!.send(subRequest);
        }
      };
    } else {
      for (const subRequest of subPayloads) {
        this._ws.send(subRequest);
      }
    }

    return () => {
      this._disposed = true;
      this._ws && this._ws.close();
    };
  }

  public openSerumVial() {
    this._ws = new WebSocket(WS_URL);
  }

  public closeSerumVial() {
    this._ws.close();
  }

  public removeAnyListeners() {
    this._ws.onmessage = () => {};
  }

  public checkSerumVial() {
    let state: number;
    state = this._ws.readyState;
    return state;
  }
}

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
