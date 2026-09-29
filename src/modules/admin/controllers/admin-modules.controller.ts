import type { Request, Response } from "express";
import { ok } from "../../../lib/http.js";
import { adminModulesService } from "../services/admin-modules.service.js";

function actor(req: Request) {
  return (req as { admin?: { email?: string } }).admin?.email ?? "admin";
}

export class AdminModulesController {
  /* ------------------------------- Compliance ------------------------------- */

  getAmlRules = async (_req: Request, res: Response) =>
    ok(res, { rules: await adminModulesService.getAmlRules() });

  putAmlRules = async (req: Request, res: Response) =>
    ok(res, { rules: await adminModulesService.putAmlRules(req.body?.rules ?? req.body, actor(req)) });

  listAmlAlerts = async (req: Request, res: Response) =>
    ok(res, { alerts: await adminModulesService.listAmlAlerts(String(req.query.status ?? "all")) });

  clearAmlAlert = async (req: Request, res: Response) =>
    ok(res, {
      alert: await adminModulesService.amlAlertAction(
        String(req.params.id),
        "clear",
        actor(req),
        String(req.body?.reason ?? ""),
      ),
    });

  escalateAmlAlert = async (req: Request, res: Response) =>
    ok(res, {
      alert: await adminModulesService.amlAlertAction(
        String(req.params.id),
        "escalate",
        actor(req),
        String(req.body?.reason ?? ""),
      ),
    });

  getSanctionLists = async (_req: Request, res: Response) =>
    ok(res, { lists: await adminModulesService.getScreenLists() });

  putSanctionLists = async (req: Request, res: Response) =>
    ok(res, { lists: await adminModulesService.putScreenLists(req.body?.lists ?? req.body, actor(req)) });

  listSanctionHits = async (req: Request, res: Response) =>
    ok(res, {
      hits: await adminModulesService.listSanctionHits(
        String(req.query.status ?? "all"),
        String(req.query.list ?? "all"),
      ),
    });

  clearSanctionHit = async (req: Request, res: Response) =>
    ok(res, {
      hit: await adminModulesService.sanctionHitAction(
        String(req.params.id),
        "clear",
        actor(req),
        String(req.body?.reason ?? ""),
      ),
    });

  confirmSanctionHit = async (req: Request, res: Response) =>
    ok(res, {
      hit: await adminModulesService.sanctionHitAction(
        String(req.params.id),
        "confirm",
        actor(req),
        String(req.body?.reason ?? ""),
      ),
    });

  listCases = async (req: Request, res: Response) =>
    ok(res, {
      cases: await adminModulesService.listCases({
        type: String(req.query.type ?? "all"),
        severity: String(req.query.severity ?? "all"),
        assignee: String(req.query.assignee ?? "all"),
      }),
    });

  getCase = async (req: Request, res: Response) =>
    ok(res, { case: await adminModulesService.getCase(String(req.params.id)) });

  advanceCase = async (req: Request, res: Response) =>
    ok(res, {
      case: await adminModulesService.advanceCase(
        String(req.params.id),
        String(req.body?.stage ?? "investigating"),
        actor(req),
        String(req.body?.reason ?? ""),
      ),
    });

  listRegReports = async (_req: Request, res: Response) =>
    ok(res, { reports: await adminModulesService.listReports() });

  submitRegReport = async (req: Request, res: Response) =>
    ok(res, {
      report: await adminModulesService.submitReport(
        String(req.params.id),
        actor(req),
        String(req.body?.reason ?? ""),
      ),
    });

  listDsr = async (_req: Request, res: Response) =>
    ok(res, { requests: await adminModulesService.listDsr() });

  fulfilDsr = async (req: Request, res: Response) =>
    ok(res, {
      request: await adminModulesService.dsrAction(
        String(req.params.id),
        "fulfil",
        actor(req),
        String(req.body?.reason ?? ""),
      ),
    });

  refuseDsr = async (req: Request, res: Response) =>
    ok(res, {
      request: await adminModulesService.dsrAction(
        String(req.params.id),
        "refuse",
        actor(req),
        String(req.body?.reason ?? ""),
      ),
    });

  /* ---------------------------------- Cards --------------------------------- */

  listCardPrograms = async (_req: Request, res: Response) =>
    ok(res, { programs: await adminModulesService.listCardPrograms() });

  createCardProgram = async (req: Request, res: Response) =>
    ok(res, { program: await adminModulesService.upsertCardProgram(req.body ?? {}, actor(req)) });

  updateCardProgram = async (req: Request, res: Response) =>
    ok(res, {
      program: await adminModulesService.upsertCardProgram(
        { ...(req.body ?? {}), id: String(req.params.id) },
        actor(req),
      ),
    });

  listCardAuthorisations = async (req: Request, res: Response) =>
    ok(res, {
      authorisations: await adminModulesService.listCardAuthorisations({
        decision: String(req.query.decision ?? "all"),
        q: String(req.query.q ?? ""),
      }),
    });

  reverseCardAuthorisation = async (req: Request, res: Response) =>
    ok(res, {
      authorisation: await adminModulesService.reverseAuth(
        String(req.params.id),
        actor(req),
        String(req.body?.reason ?? ""),
      ),
    });

  getBinRules = async (_req: Request, res: Response) =>
    ok(res, { rules: await adminModulesService.getBinRules() });

  putBinRules = async (req: Request, res: Response) =>
    ok(res, { rules: await adminModulesService.putBinRules(req.body?.rules ?? req.body, actor(req)) });

  getLimitTiers = async (_req: Request, res: Response) =>
    ok(res, { tiers: await adminModulesService.getLimitTiers() });

  putLimitTiers = async (req: Request, res: Response) =>
    ok(res, { tiers: await adminModulesService.putLimitTiers(req.body?.tiers ?? req.body, actor(req)) });

  getMccRules = async (_req: Request, res: Response) =>
    ok(res, { rules: await adminModulesService.getMccRules() });

  putMccRules = async (req: Request, res: Response) =>
    ok(res, { rules: await adminModulesService.putMccRules(req.body?.rules ?? req.body, actor(req)) });

  /* --------------------------------- Crypto --------------------------------- */

  listCryptoNetworks = async (_req: Request, res: Response) =>
    ok(res, { networks: await adminModulesService.listNetworks() });

  putCryptoNetworks = async (req: Request, res: Response) => {
    const items = Array.isArray(req.body?.networks) ? req.body.networks : Array.isArray(req.body) ? req.body : [];
    const out = [];
    for (const item of items) {
      const id = String(item.id ?? "");
      if (!id) continue;
      out.push(await adminModulesService.upsertNetwork(id, item, actor(req)));
    }
    return ok(res, { networks: out.length ? out : await adminModulesService.listNetworks() });
  };

  updateCryptoNetwork = async (req: Request, res: Response) =>
    ok(res, {
      network: await adminModulesService.upsertNetwork(String(req.params.id), req.body ?? {}, actor(req)),
    });

  listCryptoExposures = async (_req: Request, res: Response) =>
    ok(res, { exposures: await adminModulesService.listExposures() });

  putCryptoExposures = async (req: Request, res: Response) => {
    const items = Array.isArray(req.body?.exposures) ? req.body.exposures : Array.isArray(req.body) ? req.body : [];
    const out = [];
    for (const item of items) {
      const asset = String(item.asset ?? "");
      if (!asset) continue;
      out.push(await adminModulesService.upsertExposure(asset, item, actor(req)));
    }
    return ok(res, { exposures: out.length ? out : await adminModulesService.listExposures() });
  };

  haltCryptoExposure = async (req: Request, res: Response) => {
    const asset = String(req.params.asset ?? "").toUpperCase();
    if (asset && asset !== "ALL") {
      const exposure = await adminModulesService.upsertExposure(
        asset,
        { ...(req.body ?? {}), autoHalt: true },
        actor(req),
      );
      return ok(res, { exposure });
    }
    return ok(res, {
      exposures: await adminModulesService.haltAllQuoting(actor(req), String(req.body?.reason ?? "")),
    });
  };

  /* ------------------------------ Engagement -------------------------------- */

  listCampaigns = async (req: Request, res: Response) =>
    ok(res, {
      campaigns: await adminModulesService.listCampaigns(
        typeof req.query.channel === "string" ? req.query.channel : undefined,
      ),
    });

  createCampaign = async (req: Request, res: Response) =>
    ok(res, { campaign: await adminModulesService.upsertCampaign(req.body ?? {}, actor(req)) });

  updateCampaign = async (req: Request, res: Response) =>
    ok(res, {
      campaign: await adminModulesService.upsertCampaign(
        { ...(req.body ?? {}), id: String(req.params.id) },
        actor(req),
      ),
    });

  launchCampaign = async (req: Request, res: Response) =>
    ok(res, {
      campaign: await adminModulesService.campaignAction(
        String(req.params.id),
        "launch",
        actor(req),
        String(req.body?.reason ?? ""),
      ),
    });

  pauseCampaign = async (req: Request, res: Response) =>
    ok(res, {
      campaign: await adminModulesService.campaignAction(
        String(req.params.id),
        "pause",
        actor(req),
        String(req.body?.reason ?? ""),
      ),
    });

  endCampaign = async (req: Request, res: Response) =>
    ok(res, {
      campaign: await adminModulesService.campaignAction(
        String(req.params.id),
        "end",
        actor(req),
        String(req.body?.reason ?? ""),
      ),
    });

  /* ------------------------------- Analytics -------------------------------- */

  analyticsMetric = async (req: Request, res: Response) => {
    const days = Number(req.query.days ?? 30) || 30;
    return ok(res, {
      key: String(req.params.key),
      series: await adminModulesService.metricSeries(String(req.params.key), days),
    });
  };

  analyticsCohorts = async (_req: Request, res: Response) =>
    ok(res, { cohorts: await adminModulesService.cohorts() });

  analyticsFunnels = async (_req: Request, res: Response) =>
    ok(res, { funnels: await adminModulesService.funnels() });

  listAnalyticsReports = async (_req: Request, res: Response) =>
    ok(res, { reports: await adminModulesService.getSavedReports() });

  createAnalyticsReport = async (req: Request, res: Response) => {
    const existing = await adminModulesService.getSavedReports();
    const list = Array.isArray(existing) ? [...existing] : [];
    const next = { id: `RPT-${Date.now().toString().slice(-6)}`, ...(req.body ?? {}) };
    list.push(next);
    const reports = await adminModulesService.putSavedReports(list, actor(req));
    return ok(res, { report: next, reports });
  };
}

export const adminModulesController = new AdminModulesController();
