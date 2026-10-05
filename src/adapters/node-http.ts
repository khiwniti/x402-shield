// Drop-in paywall for any Node http server: wrap a handler, get x402.

import type { IncomingMessage, ServerResponse } from "node:http";
import { guard, X_PAYMENT, type Connection, type PaymentTerms, type SettlementScheme } from "../index.ts";

export type Handler = (req: IncomingMessage, res: ServerResponse, payment: { scheme: string; signature: string }) => void;

export function paywall(opts: {
  schemes: SettlementScheme[];
  connection: () => Connection;
  terms: (req: IncomingMessage) => Omit<PaymentTerms, "scheme" | "network">;
  handler: Handler;
}) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const result = await guard({
      schemes: opts.schemes,
      connection: opts.connection,
      terms: opts.terms(req),
      paymentHeader: req.headers[X_PAYMENT] as string | undefined,
    });

    if (result.status === 402) {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify(result.body));
      return;
    }
    opts.handler(req, res, result.payment);
  };
}
