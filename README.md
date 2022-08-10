# risk-manager
Risk management for Dual Finance protocol DIP positions

The risk manager triggers trades from the following events:

1. Recieve DIP token balance change
2. Receive order fill from gamma levels 
3. 1 Hour Timer Expires
4. DIP Expires
5. DIP Exercised

Trading events per event:
1. Cancel all orders
2. Calc net position delta & gamma
3. Buy or Sell delta to 0 via TWAP if necessary
4. Place bid & ask at gamma levels
5. Start 1 hour timer
