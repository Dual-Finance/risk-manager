import { DIPDeposit } from "./common";

export class Router {
  mm_callback: (d: DIPDeposit) => void;
  risk_manager_callback: (d: DIPDeposit) => void;

  constructor(
    mm_callback: (d: DIPDeposit) => void,
    risk_manager_callback: (d: DIPDeposit) => void
  ) {
    this.mm_callback = mm_callback;
    this.risk_manager_callback = risk_manager_callback;
  }

  // Accepts a DIP Deposit and decides whether to send it to the mm_callback
  // or risk_manager_callback
  route(dip_deposit: DIPDeposit) {
    // TODO: Decide where to send the deposit to.
    this.risk_manager_callback(dip_deposit);
  }
}
