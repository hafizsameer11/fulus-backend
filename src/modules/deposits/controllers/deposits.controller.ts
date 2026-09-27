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
      })
      .parse(req.query ?? {});
    return ok(res, await depositsService.verifyCardDeposit(req.user.id, query));
  };

  /** Flutterwave redirect landing — WebView watches for this path. */
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
</div></body></html>`);
  };

  /** Dev / simulate hosted page so the WebView can complete without Flutterwave keys. */
  simulateCheckout = async (req: Request, res: Response) => {
    const depositId = typeof req.query.depositId === "string" ? req.query.depositId : "";
    const txRef = typeof req.query.tx_ref === "string" ? req.query.tx_ref : "";
    const redirect =
      typeof req.query.redirect === "string" && req.query.redirect
        ? req.query.redirect
        : `/api/v1/deposits/card/return?depositId=${encodeURIComponent(depositId)}&tx_ref=${encodeURIComponent(txRef)}&status=successful`;

    res
      .status(200)
      .type("html")
      .send(`<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Simulate Flutterwave</title>
<style>
body{font-family:system-ui,sans-serif;background:#0A0A0A;color:#fff;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:#161616;border-radius:24px;padding:28px 22px;max-width:380px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.45)}
.badge{display:inline-flex;align-items:center;gap:6px;background:#1a1a2e;color:#a78bfa;font-size:11px;font-weight:600;padding:6px 10px;border-radius:999px;margin-bottom:16px}
h1{font-size:22px;margin:0 0 8px}p{opacity:.65;font-size:13px;line-height:1.5;margin:0 0 22px}
button{width:100%;border:0;border-radius:16px;background:#FFD60A;color:#0A0A0A;font-weight:700;font-size:15px;padding:16px;cursor:pointer}
.muted{margin-top:14px;font-size:11px;opacity:.45;text-align:center}
</style></head>
<body><div class="card">
<span class="badge">SIMULATED · Flutterwave</span>
<h1>Pay with card</h1>
<p>This is a local checkout stand-in. Confirm to credit the NGN wallet as if Flutterwave succeeded.</p>
<button type="button" id="pay">Confirm payment</button>
<p class="muted">Ref ${txRef || "—"}</p>
</div>
<script>
document.getElementById('pay').onclick=function(){
  window.location.href=${JSON.stringify(redirect)};
};
</script></body></html>`);
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
