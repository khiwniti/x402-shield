// Demo merchant API: one endpoint paid per request with a mock-USDC amount.
// Run: RPC=http://127.0.0.1:8899 MERCHANT_ATA=... MINT=... node --experimental-strip-types demo/server.ts

import { createServer } from "node:http";
import { Connection } from "@solana/web3.js";
import { solanaExact } from "../src/schemes/solana-exact.ts";
import { paywall } from "../src/adapters/node-http.ts";

const rpc = process.env.RPC ?? "http://127.0.0.1:8899";
const payTo = process.env.MERCHANT_ATA!;
const mint = process.env.MINT!;
const amount = process.env.AMOUNT ?? "10000"; // 0.01 USDC (6dp)
const port = Number(process.env.PORT ?? 4021);

const conn = new Connection(rpc, "confirmed");

createServer(
  paywall({
    schemes: [solanaExact(rpc.includes("devnet") ? "solana-devnet" : "solana-localnet")],
    connection: () => conn,
    terms: () => ({ maxTimeoutSeconds: 60, payTo, asset: mint, amount, decimals: 6 }),
    handler: (_req, res, payment) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: "🤖 premium answer", paid: payment.signature }));
    },
  })
).listen(port, () => console.log(`paywalled demo on :${port}`));
