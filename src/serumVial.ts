import WebSocket from "ws";
import { SERUM_ACCOUNT } from "./config";

const WS_URL = "wss://api.serum-vial.dev/v1/ws";

export class SerumVialClient {
  private _ws: WebSocket | undefined = undefined;
  private _disposed = false;

  public streamData(
    channels: string[],
    markets: string[],
    onmessage: (message: any) => void
  ) {
    this._ws = new WebSocket(WS_URL);

    this._ws.onmessage = (msg) => {
      const message = JSON.parse(msg.data as string);
      if (message.type === "trade") {
        const tradeMessage = message as SerumVialTradeMessage;
        if (
          tradeMessage.makerAccount == SERUM_ACCOUNT ||
          tradeMessage.takerAccount == SERUM_ACCOUNT
        ) {
          onmessage(tradeMessage);
        }
      }
    };

    this._ws.onclose = (ev) => {
      if (this._disposed) {
        return;
      }

      console.log(
        `Connection to ${WS_URL} closed, code: ${ev.code}. Restarting....`
      );

      this.streamData(channels, markets, onmessage);
    };

    const subPayloads = channels.map((channel) => {
      return JSON.stringify({
        op: "subscribe",
        channel,
        markets,
      });
    });

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
}

export type SerumVialTradeMessage = {
  readonly type: "trade";
  readonly price: string;
  readonly size: string;
  readonly side: "buy" | "sell";
  readonly id: string;
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
