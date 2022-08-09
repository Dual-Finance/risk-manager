class Poller {
    url: string;
    address: string;
    callback: () => {};

    constructor(url: string, address: string, callback: () => {}) {
        this.url = url;
        this.address = address;
        this.callback = callback;
    }

    subscribe() : void {
        // https://docs.solana.com/developing/clients/jsonrpc-api#accountsubscribe
        // Account subscribe to the premium account

        // Subscribe and make a callback
        // https://www.npmjs.com/package/websocket-ts

        // OnMessage to call the callback
    }
}