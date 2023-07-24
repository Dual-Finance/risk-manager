# risk-manager
Risk management for Dual Finance protocol DIP and SO positions

The risk manager triggers trades from the following events:

1. Receive DIP token balance change
2. Receive order fill from gamma levels 
3. Scalper window timer Expires
4. DIP expires
5. DIP exercised

Trading events per event:
1. Cancel all orders
2. Calc net position delta and gamma
3. Buy or sell delta to 0 via TWAP if necessary
4. Place bid and ask at gamma levels
5. Start scalper window timer

## Usage
```
source .env ; yarn run main
```