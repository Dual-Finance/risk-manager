class Router {
    mm_callback: () => {};
    risk_manager_callback: () => {};

    constructor(mm_callback: () => {}, risk_manager_callback: () => {}) {
        this.mm_callback = mm_callback;
        this.risk_manager_callback = risk_manager_callback;
    }

    // Accepts a DIP Deposit and decides whether to send it to the mm_callback
    // or risk_manager_callback
    route() {

    }
}