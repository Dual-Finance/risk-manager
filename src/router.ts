import { DIPDeposit } from "./common";

export class Router {
  mm_callback: (d: DIPDeposit[]) => void;
  risk_manager_callback: (d: DIPDeposit[]) => void;
  dips: { [name: string]: DIPDeposit };
  token: string;

  constructor(
    mm_callback: (d: DIPDeposit[]) => void,
    risk_manager_callback: (d: DIPDeposit[]) => void,
    token: string,
  ) {
    this.mm_callback = mm_callback;
    this.risk_manager_callback = risk_manager_callback;
    this.dips = {};
    this.token = token;
  }

  // Accepts a DIP Deposit and decides whether to send it to the mm_callback
  // or risk_manager_callback
  route(dip_deposit: DIPDeposit) {
    // TODO: Check how much there was before to figure out the amount for routing decision
    // Update the dips
    this.dips[this.dip_to_string(dip_deposit.expiration, dip_deposit.strike)] = dip_deposit;

    this.risk_manager_callback(Object.values(this.dips));
  }

  add_dip(expiration: number, strike: number): void {
    this.dips[this.dip_to_string(expiration, strike)] = {
      splToken: this.token,
      premiumAsset: 'USD',
      expiration: expiration,
      strike: strike,
      type: 'call',
      qty: 0,
    }
  }

  dip_to_string(expiration: number, strike: number): string {
    return `${expiration}${strike}`;
  }

}
