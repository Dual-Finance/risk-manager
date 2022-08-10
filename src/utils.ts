import * as os from "os";
import * as fs from "fs";

export function readKeypair() {
  return JSON.parse(
    process.env.KEYPAIR ||
      fs.readFileSync(os.homedir() + "/mango-explorer/id.json", "utf-8")
  );
}

// Sleep Time Required
export function sleepTime(period: number) {
  return new Promise(function (resolve) {
    setTimeout(resolve, period * 1_000);
  });
}
