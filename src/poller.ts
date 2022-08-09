import { DIPDeposit } from "./common";
import { Connection, AccountChangeCallback, PublicKey, AccountInfo, Context, clusterApiUrl } from "@solana/web3.js";

export class Poller {
    cluster: string;
    address: string;
    callback: (deposit: DIPDeposit) => void;

    constructor(cluster: string, address: string, callback: (deposit: DIPDeposit) => void) {
        this.cluster = cluster;
        this.address = address;
        this.callback = callback;
    }

    subscribe() : void {
        // https://docs.solana.com/developing/clients/jsonrpc-api#accountsubscribe
        // Account subscribe to the premium account
        const connection: Connection = new Connection(clusterApiUrl('devnet'));
        const callback: AccountChangeCallback = (accountInfo: AccountInfo<Buffer>, context: Context) => {
            console.log('AccountInfo');
            console.log(accountInfo);
            console.log('Context');
            console.log(context);
        };
        connection.onAccountChange(new PublicKey(this.address), callback);
        //onAccountChange(publicKey: PublicKey, callback: AccountChangeCallback, commitment?: Commitment): number

        // Subscribe and make a callback
        // https://www.npmjs.com/package/websocket-ts

        // OnMessage to call the callback
    }
}