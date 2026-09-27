import type { Request, Response } from "express";
import { created, ok } from "../../../lib/http.js";
import { UnauthorizedError } from "../../../lib/errors.js";
import {
  createDepositSchema,
  depositsService,
  initiateCardDepositSchema,
} from "../services/deposits.service.js";
import { z } from "zod";

export class DepositsController {
  createBank = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    const input = createDepositSchema.parse(req.body ?? {});
    return created(res, await depositsService.createBankDeposit(req.user.id, input));
  };

  initiateCard = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    const input = initiateCardDepositSchema.parse(req.body ?? {});
    return created(res, await depositsService.initiateCardDeposit(req.user.id, input));
  };

  verifyCard = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    const query = z
      .object({
        tx_ref: z.string().optional(),
        depositId: z.string().optional(),
        transaction_id: z.string().optional(),
      })
      .parse(req.query ?? {});
    return ok(res, await depositsService.verifyCardDeposit(req.user.id, query));
  };

  /**
   * Inline FlutterwaveCheckout HTML for the mobile/web WebView.
   * Loads https://checkout.flutterwave.com/v3.js with FLUTTERWAVE_PUBLIC_KEY.
   */
  inlineCheckout = async (req: Request, res: Response) => {
    const query = z
      .object({
        depositId: z.string().optional(),
        tx_ref: z.string().optional(),
      })
      .parse(req.query ?? {});
    const html = await depositsService.inlineCheckoutHtml(query);
    res.status(200).type("html").send(html);
  };

  /** Kept for older clients / deep links. */
  cardReturn = async (req: Request, res: Response) => {
    const depositId = typeof req.query.depositId === "string" ? req.query.depositId : "";
    const txRef = typeof req.query.tx_ref === "string" ? req.query.tx_ref : "";
    const status = typeof req.query.status === "string" ? req.query.status : "successful";
    res
      .status(200)
      .type("html")
      .send(`<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Payment complete</title>
<style>body{font-family:system-ui,sans-serif;background:#0A0A0A;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center}
.card{background:#111;border-radius:20px;padding:28px 24px;max-width:360px}
h1{font-size:20px;margin:0 0 8px}p{opacity:.7;font-size:14px;margin:0}</style></head>
<body><div class="card" data-fulus-card-return="1" data-status="${status}" data-deposit-id="${depositId}" data-tx-ref="${txRef}">
<h1>Payment complete</h1>
<p>You can return to Fulus. This window will close automatically.</p>
</div>
<script>
try {
  if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: "fulus-flw-success",
      depositId: ${JSON.stringify(depositId)},
      tx_ref: ${JSON.stringify(txRef)},
      status: ${JSON.stringify(status)}
    }));
  }
} catch (e) {}
</script>
</body></html>`);
  };

  list = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await depositsService.list(req.user.id));
  };

  virtualAccount = async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    return ok(res, await depositsService.ensureVirtualAccount(req.user.id));
  };

  confirm = async (req: Request, res: Response) => {
    const body = z.object({ amount: z.number().positive().optional() }).parse(req.body ?? {});
    return ok(res, await depositsService.confirm(String(req.params.id), body.amount));
  };
}

export const depositsController = new DepositsController();
