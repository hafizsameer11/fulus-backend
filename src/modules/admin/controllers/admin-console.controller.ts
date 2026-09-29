import type { Request, Response } from "express";
import { z } from "zod";
import { ok } from "../../../lib/http.js";
import { NotFoundError } from "../../../lib/errors.js";
import { adminConsoleService } from "../services/admin-console.service.js";

function q(req: Request) {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.query)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export class AdminConsoleController {
  overview = async (_req: Request, res: Response) => ok(res, await adminConsoleService.overview());

  overviewFlow = async (req: Request, res: Response) => {
    const range = typeof req.query.range === "string" ? req.query.range : "24h";
    return ok(res, await adminConsoleService.overviewFlow(range));
  };

  overviewRails = async (_req: Request, res: Response) => ok(res, await adminConsoleService.overviewRails());

  overviewStream = async (req: Request, res: Response) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    return ok(res, await adminConsoleService.overviewStream(status));
  };

  overviewAnomalies = async (_req: Request, res: Response) =>
    ok(res, await adminConsoleService.overviewAnomalies());

  overviewWork = async (_req: Request, res: Response) => ok(res, await adminConsoleService.overviewWork());

  listIncidents = async (_req: Request, res: Response) => ok(res, await adminConsoleService.listIncidents());

  createIncident = async (req: Request, res: Response) => {
    const body = z
      .object({
        title: z.string().min(3),
        severity: z.enum(["sev1", "sev2", "sev3"]),
        rail: z.string().optional(),
        commander: z.string().optional(),
      })
      .parse(req.body ?? {});
    return ok(res, await adminConsoleService.createIncident(body), 201);
  };

  listCustomers = async (req: Request, res: Response) =>
    ok(res, await adminConsoleService.listCustomers(q(req)));

  getCustomer = async (req: Request, res: Response) => {
    const data = await adminConsoleService.getCustomer(String(req.params.id ?? ""));
    if (!data) throw new NotFoundError("Customer not found");
    return ok(res, data);
  };

  freezeUser = async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    return ok(res, await adminConsoleService.setUserStatus(id, "FROZEN", req.admin?.email ?? "admin"));
  };

  unfreezeUser = async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    return ok(res, await adminConsoleService.setUserStatus(id, "ACTIVE", req.admin?.email ?? "admin"));
  };

  setUserTier = async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const body = z.object({ tier: z.number().int().min(0).max(3) }).parse(req.body ?? {});
    return ok(res, await adminConsoleService.setUserTier(id, body.tier, req.admin?.email ?? "admin"));
  };

  listMoneyTransactions = async (req: Request, res: Response) =>
    ok(res, await adminConsoleService.listMoneyTransactions(q(req)));

  getMoneyTransaction = async (req: Request, res: Response) => {
    const data = await adminConsoleService.getMoneyTransaction(String(req.params.id ?? ""));
    if (!data) throw new NotFoundError("Transaction not found");
    return ok(res, data);
  };

  listCardPayments = async (req: Request, res: Response) =>
    ok(res, await adminConsoleService.listCardPayments(q(req)));

  listDisputes = async (req: Request, res: Response) => ok(res, await adminConsoleService.listDisputes(q(req)));

  listRefunds = async (req: Request, res: Response) => ok(res, await adminConsoleService.listRefunds(q(req)));

  listSegments = async (_req: Request, res: Response) => ok(res, await adminConsoleService.listSegments());

  createSegment = async (req: Request, res: Response) => {
    const body = z
      .object({
        name: z.string().min(2),
        description: z.string().default(""),
        rules: z.unknown(),
      })
      .parse(req.body ?? {});
    return ok(
      res,
      await adminConsoleService.createSegment({
        name: body.name,
        description: body.description,
        rules: body.rules ?? [],
        owner: req.admin?.email ?? "admin",
      }),
      201,
    );
  };

  listStatementLines = async (_req: Request, res: Response) =>
    ok(res, await adminConsoleService.listStatementLines());

  listPayoutBatches = async (_req: Request, res: Response) =>
    ok(res, await adminConsoleService.listPayoutBatches());
}

export const adminConsoleController = new AdminConsoleController();
