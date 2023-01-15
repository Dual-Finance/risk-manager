# risk-manager
Risk management for Dual Finance protocol DIP positions

The risk manager triggers trades from the following events:

1. Receive DIP token balance change
2. Receive order fill from gamma levels 
3. Scalper Window Timer Expires
4. DIP Expires
5. DIP Exercised

Trading events per event:
1. Cancel all orders
2. Calc net position delta & gamma
3. Buy or Sell delta to 0 via TWAP if necessary
4. Place bid & ask at gamma levels
5. Start Scalper Window timer

Environment Variables
DEV=true || DEV=false (Defaults to true)
RPC=[Enter RPC url]
FEE=Priority Fee to use for all txs in micro lamports
SOL, BTC, ETH, MNGO = [OFF || ON, DELTA_OFFSET, THEO_VOL, ZCORE, MODE]
Defaults to OFF,0,120%*BVE,1.258,0
Example: DEV=false RPC=https://api.mainnet-beta.solana.com FEE=1000 SOL=OFF,-117.6,0.84 BTC=OFF ETH=OFF MNGO=OFF,0,1.2 BONK=ON,0,2,1.95,1 yarn run main
