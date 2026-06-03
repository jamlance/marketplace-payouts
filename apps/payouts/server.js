import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { mountAppCore, inkressApi } from "@inkress/apps-core";
import { openPg } from "@inkress/apps-core/pgdb";
import { openMerchantTokens } from "@inkress/apps-core/merchant-tokens";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
for (const k of ["OAUTH_CLIENT_ID", "OAUTH_CLIENT_SECRET", "INKRESS_API_BASE"]) {
  if (!process.env[k]) { console.error(`[payouts] Missing env: ${k}`); process.exit(1); }
}
const QUICK_FEE_PCT = Number(process.env.QUICK_FEE_PCT || 0.015);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";

const db = await openPg("payouts", `
  CREATE TABLE IF NOT EXISTS scheduled_payouts (
    id BIGSERIAL PRIMARY KEY, merchant_id BIGINT NOT NULL,
    amount NUMERIC NOT NULL, source_id BIGINT, destination_id BIGINT, kind TEXT NOT NULL DEFAULT 'manual',
    cadence TEXT NOT NULL DEFAULT 'once', next_run TIMESTAMPTZ NOT NULL,
    active BOOLEAN NOT NULL DEFAULT true, last_run TIMESTAMPTZ, last_result TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS quick_payout_log (
    id BIGSERIAL PRIMARY KEY, merchant_id BIGINT NOT NULL, amount NUMERIC, fee NUMERIC,
    eligible BOOLEAN, risk_score NUMERIC, reasons TEXT, reference_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`);

const app = express();
const core = mountAppCore(app, {
  clientId: process.env.OAUTH_CLIENT_ID, clientSecret: process.env.OAUTH_CLIENT_SECRET,
  apiBaseUrl: process.env.INKRESS_API_BASE, frameAncestors: process.env.FRAME_ANCESTORS,
  staticDir: path.join(__dirname, "dist"),
  // Save the merchant's refresh token so the scheduler can submit payout
  // requests in the background (requires offline_access).
  onBootstrap: (entry) => { tokens.save(entry.merchantId, entry.refreshToken).catch(() => {}); },
});
const tokens = await openMerchantTokens("payouts", core.cfg);

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const isWallet = (a) => /wallet/i.test(a.type || a.kind || "");

// --- helpers over the existing payouts OAuth surface (internal flow still approves) ---
async function accounts(token) {
  const r = await inkressApi(core.cfg, token, "financial_accounts?limit=100").catch(() => null);
  const rows = r?.result?.entries || r?.result || [];
  return {
    wallets: rows.filter(isWallet).map(fmtAcct),
    destinations: rows.filter((a) => !isWallet(a)).map(fmtAcct),
  };
}
const fmtAcct = (a) => ({ id: a.id, name: a.name || a.type, type: a.type, currency: a.currency_code || a.currency });

// merchants/account/balances returns { wallets: [{ currency_code,
// available_balance, reserved_balance, pending_balance, total_balance,
// total_revenue }], payout_period, last_payable_transaction_date,
// early_payout_percentage_limit, early_payout_value_limit }. The old code
// read `raw.available`/`raw.currency` which never matched, so the home
// page always showed "no wallet".
async function balances(token) {
  const r = await inkressApi(core.cfg, token, "merchants/account/balances", { method: "POST", body: JSON.stringify({}) }).catch(() => null);
  const raw = r?.result || r || {};
  const rows = Array.isArray(raw.wallets) ? raw.wallets : (Array.isArray(raw) ? raw : []);
  return {
    balances: rows.map((b) => ({
      currency: b.currency_code || b.currency,
      available: round2(b.available_balance ?? b.available),
      pending: round2(b.pending_balance ?? b.pending_payout_balance ?? b.pending),
      reserved: round2(b.reserved_balance ?? b.reserved),
      total: round2(b.total_balance ?? b.total),
      revenue: round2(b.total_revenue ?? b.revenue),
    })),
    payout_period: raw.payout_period ?? null,
    last_payable_transaction_date: raw.last_payable_transaction_date ?? null,
    early_payout_percentage_limit: raw.early_payout_percentage_limit ?? null,
    early_payout_value_limit: raw.early_payout_value_limit ?? null,
  };
}

// Estimate the next standard payout date from the merchant's payout
// period (days, or a named cadence) and the last payable transaction.
function estimateNextPayout(period, lastDate) {
  if (!lastDate) return null;
  const days = typeof period === "number"
    ? period
    : ({ daily: 1, weekly: 7, biweekly: 14, fortnightly: 14, monthly: 30 }[String(period || "").toLowerCase()] ?? Number(period));
  if (!days || Number.isNaN(days)) return null;
  const d = new Date(lastDate);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

async function payoutHistory(token) {
  const r = await inkressApi(core.cfg, token, "financial_requests?limit=50&order=id desc").catch(() => null);
  const rows = r?.result?.entries || [];
  return rows.filter((p) => p.type === 1 || p.type == null).map((p) => ({
    id: p.id, total: round2(p.total), fee: round2(p.fee_total), status: payoutStatus(p.status),
    currency: p.currency_code || p.currency?.code, due_at: p.due_at, created_at: p.inserted_at || p.created_at,
    speed: p.sub_type === 2 ? "quick" : "standard",
  }));
}
const payoutStatus = (s) => ({ 1: "pending", 2: "processing", 3: "paid", 4: "rejected", 5: "failed" }[s] || "pending");

// Submit a payout request to the existing internal flow (payouts:create).
async function submitPayout(token, { amount, source_id, destination_id, kind = "manual", data = {} }) {
  const body = { total: amount, source_id, destination_id, kind, type: 1, data };
  const r = await inkressApi(core.cfg, token, "financial_requests", { method: "POST", body: JSON.stringify(body) });
  return r;
}

// --- LLM eligibility pre-screen for quick payouts (does NOT release funds) ---
async function assessEligibility(token, amount, currency) {
  // Compact risk context from the merchant's own order + payout history.
  const ordersR = await inkressApi(core.cfg, token, "orders?limit=100&order=id desc").catch(() => null);
  const orders = ordersR?.result?.entries || [];
  const paid = orders.filter((o) => o.status === 3).length;
  const refunds = orders.filter((o) => o.status === 11).length;
  const hist = await payoutHistory(token).catch(() => []);
  const failed = hist.filter((p) => p.status === "failed" || p.status === "rejected").length;
  const ctx = {
    paid_orders: paid, total_orders: orders.length, refunds, refund_rate: orders.length ? Math.round((refunds / orders.length) * 100) : 0,
    prior_payouts: hist.length, failed_payouts: failed, requested_amount: amount, currency,
  };

  // Rules fallback (also the safety net if the LLM is unavailable).
  const rules = () => {
    const reasons = [];
    let ok = true;
    if (paid < 5) { ok = false; reasons.push("Fewer than 5 paid orders on record."); }
    if (ctx.refund_rate >= 15) { ok = false; reasons.push(`High refund rate (${ctx.refund_rate}%).`); }
    if (failed >= 2) { ok = false; reasons.push("Multiple prior failed/rejected payouts."); }
    return { eligible: ok, risk_score: ok ? 0.2 : 0.8, reasons: reasons.length ? reasons : ["Healthy order + payout history."], source: "rules" };
  };

  if (!ANTHROPIC_API_KEY) return rules();
  try {
    const prompt = `You are a payments risk analyst deciding if a merchant qualifies for an EXPEDITED (next-day) payout. This does NOT release funds — payouts are still approved internally. You are only pre-screening eligibility for the faster option.\nMerchant signals (JSON): ${JSON.stringify(ctx)}\nReturn ONLY compact JSON: {"eligible": boolean, "risk_score": number 0-1, "reasons": string[]}. Decline (eligible:false) if signals suggest fraud/chargeback risk or too little history.`;
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 400, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(12000),
    });
    if (!resp.ok) return rules();
    const j = await resp.json();
    const text = (j?.content || []).map((c) => c.text || "").join("");
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return rules();
    const v = JSON.parse(m[0]);
    return { eligible: !!v.eligible, risk_score: Number(v.risk_score) || 0.5, reasons: Array.isArray(v.reasons) ? v.reasons : [], source: "llm" };
  } catch {
    return rules();
  }
}

// ----------------------------------------------------------------- routes ----
app.get("/api/overview", core.requireSession, async (req, res) => {
  try {
    const t = req.session.accessToken;
    const [bal, acct, hist] = await Promise.all([balances(t), accounts(t), payoutHistory(t)]);
    // Merge balance amounts into the wallet accounts (which carry the
    // source_id needed to request a payout) by currency, so the UI can
    // show a spendable balance against each selectable source.
    const byCur = new Map(bal.balances.map((b) => [b.currency, b]));
    const wallets = acct.wallets.map((w) => {
      const b = byCur.get(w.currency) || {};
      return { ...w, available: b.available ?? null, pending: b.pending ?? null, reserved: b.reserved ?? null, total: b.total ?? null };
    });
    res.json({
      balances: bal.balances,
      wallets,
      destinations: acct.destinations,
      payouts: hist,
      quick_fee_pct: QUICK_FEE_PCT,
      payout_info: {
        payout_period: bal.payout_period,
        last_payable_transaction_date: bal.last_payable_transaction_date,
        next_payout_estimate: estimateNextPayout(bal.payout_period, bal.last_payable_transaction_date),
        early_payout_percentage_limit: bal.early_payout_percentage_limit,
        early_payout_value_limit: bal.early_payout_value_limit,
      },
    });
  } catch (err) { res.status(502).json({ error: err?.message || "overview_failed" }); }
});

// Individual payout detail — full record for the detail view.
app.get("/api/payout/:id", core.requireSession, async (req, res) => {
  try {
    const r = await inkressApi(core.cfg, req.session.accessToken, `financial_requests/${encodeURIComponent(req.params.id)}`).catch(() => null);
    const p = r?.result;
    if (!p || (p.merchant_id && req.session.merchantId && Number(p.merchant_id) !== Number(req.session.merchantId)))
      return res.status(404).json({ error: "not_found" });
    res.json({ payout: {
      id: p.id, total: round2(p.total), fee: round2(p.fee_total),
      status: payoutStatus(p.status), currency: p.currency_code || p.currency?.code,
      kind: p.kind, speed: p.sub_type === 2 ? "quick" : "standard",
      source_id: p.source_id, destination_id: p.destination_id,
      due_at: p.due_at, created_at: p.inserted_at || p.created_at,
      processed_at: p.processed_at || null, reference_id: p.reference_id || null,
      data: p.data || null,
    }});
  } catch (err) { res.status(502).json({ error: err?.message }); }
});

app.post("/api/payout", core.requireSession, express.json(), async (req, res) => {
  const { amount, source_id, destination_id } = req.body || {};
  if (!amount || !destination_id) return res.status(400).json({ error: "amount and destination required" });
  try {
    const r = await submitPayout(req.session.accessToken, { amount, source_id, destination_id, kind: "manual" });
    if (r?.state === "ok" || r?.result?.id) return res.json({ ok: true, request: r.result });
    res.status(422).json({ error: typeof r?.result === "string" ? r.result : "Payout request failed" });
  } catch (err) { res.status(502).json({ error: err?.message }); }
});

app.post("/api/quick-payout", core.requireSession, express.json(), async (req, res) => {
  const { amount, source_id, destination_id, currency } = req.body || {};
  if (!amount || !destination_id) return res.status(400).json({ error: "amount and destination required" });
  const t = req.session.accessToken, mid = req.session.merchantId;
  try {
    const verdict = await assessEligibility(t, amount, currency);
    const fee = round2(amount * QUICK_FEE_PCT);
    if (!verdict.eligible) {
      await db.run(`INSERT INTO quick_payout_log (merchant_id, amount, fee, eligible, risk_score, reasons) VALUES ($1,$2,$3,false,$4,$5)`, [mid, amount, fee, verdict.risk_score, (verdict.reasons || []).join("; ")]).catch(() => {});
      return res.json({ eligible: false, risk_score: verdict.risk_score, reasons: verdict.reasons, source: verdict.source });
    }
    // Eligible → submit an EARLY (next-day) payout request to the internal flow,
    // with the fee + pre-screen verdict recorded for internal review / fraud monitoring.
    const r = await submitPayout(t, { amount, source_id, destination_id, kind: "early", data: { quick: true, fee, eligibility: verdict, fraud_monitor: true } });
    const ref = r?.result?.reference_id || null;
    await db.run(`INSERT INTO quick_payout_log (merchant_id, amount, fee, eligible, risk_score, reasons, reference_id) VALUES ($1,$2,$3,true,$4,$5,$6)`, [mid, amount, fee, verdict.risk_score, (verdict.reasons || []).join("; "), ref]).catch(() => {});
    if (r?.state === "ok" || r?.result?.id) return res.json({ eligible: true, fee, risk_score: verdict.risk_score, source: verdict.source, request: r.result });
    res.status(422).json({ error: typeof r?.result === "string" ? r.result : "Quick payout request failed", eligible: true });
  } catch (err) { res.status(502).json({ error: err?.message }); }
});

// Scheduled / recurring payout requests (fired by the in-container scheduler via bg token).
app.get("/api/schedules", core.requireSession, async (req, res) => {
  const rows = await db.q(`SELECT id, amount, source_id, destination_id, kind, cadence, next_run, active, last_run, last_result FROM scheduled_payouts WHERE merchant_id=$1 ORDER BY id DESC`, [req.session.merchantId]);
  res.json({ schedules: rows.map((s) => ({ ...s, amount: round2(s.amount) })) });
});
app.post("/api/schedules", core.requireSession, express.json(), async (req, res) => {
  const { amount, source_id, destination_id, kind, cadence, next_run } = req.body || {};
  if (!amount || !destination_id || !next_run) return res.status(400).json({ error: "amount, destination, next_run required" });
  const [row] = await db.q(
    `INSERT INTO scheduled_payouts (merchant_id, amount, source_id, destination_id, kind, cadence, next_run) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [req.session.merchantId, amount, source_id || null, destination_id, kind || "manual", cadence || "once", new Date(next_run)]);
  res.json({ ok: true, id: row?.id });
});
app.delete("/api/schedules/:id", core.requireSession, async (req, res) => {
  await db.run(`UPDATE scheduled_payouts SET active=false WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  res.json({ ok: true });
});

// Scheduler: submit due scheduled payouts in the background.
async function runScheduler() {
  try {
    const due = await db.q(`SELECT * FROM scheduled_payouts WHERE active=true AND next_run <= now() LIMIT 50`);
    for (const s of due) {
      let token; try { token = await tokens.accessTokenFor(s.merchant_id); } catch { continue; }
      let result = "ok";
      try {
        const r = await submitPayout(token, { amount: Number(s.amount), source_id: s.source_id, destination_id: s.destination_id, kind: s.kind, data: { scheduled: true } });
        result = (r?.state === "ok" || r?.result?.id) ? "submitted" : `error:${typeof r?.result === "string" ? r.result : "failed"}`;
      } catch (e) { result = `error:${e?.message || "exception"}`; }
      const next = nextRun(s.cadence, s.next_run);
      if (next) await db.run(`UPDATE scheduled_payouts SET last_run=now(), last_result=$1, next_run=$2 WHERE id=$3`, [result, next, s.id]);
      else await db.run(`UPDATE scheduled_payouts SET last_run=now(), last_result=$1, active=false WHERE id=$2`, [result, s.id]);
    }
  } catch (e) { console.error("[payouts] scheduler:", e?.message); }
}
function nextRun(cadence, from) {
  const d = new Date(from);
  if (cadence === "weekly") return new Date(d.getTime() + 7 * 86400000);
  if (cadence === "monthly") { const n = new Date(d); n.setMonth(n.getMonth() + 1); return n; }
  return null; // once
}
setInterval(runScheduler, 30 * 60 * 1000); setTimeout(runScheduler, 40000);

core.mountSpaFallback();
app.listen(PORT, HOST, () => console.log(`[payouts] listening on ${HOST}:${PORT}`));
