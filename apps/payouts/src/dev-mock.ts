/** DEV-ONLY preview harness — tree-shaken from prod. */
import type { BvSession } from "./bv-init";

export function installMockFetch() {
  window.fetch = async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const u = new URL(url, location.origin);
    const json = (d: any) => new Response(JSON.stringify(d), { status: 200, headers: { "Content-Type": "application/json" } });
    await new Promise((r) => setTimeout(r, 80));

    if (u.pathname === "/api/overview") return json({
      quick_fee_pct: 0.015,
      balances: [{ currency: "JMD", available: 184500, pending: 18500 }, { currency: "USD", available: 920, pending: 0 }],
      wallets: [{ id: 4335, name: "JMD Wallet", type: "inkress_wallet", currency: "JMD" }],
      destinations: [{ id: 51, name: "NCB •••• 4421", type: "bank_account", currency: "JMD" }, { id: 52, name: "Scotiabank •••• 7780", type: "bank_account", currency: "JMD" }],
      payouts: [
        { id: 901, total: 50000, fee: 0, status: "paid", currency: "JMD", created_at: new Date(Date.now() - 9 * 86400000).toISOString(), speed: "standard" },
        { id: 902, total: 30000, fee: 450, status: "processing", currency: "JMD", created_at: new Date(Date.now() - 1 * 86400000).toISOString(), speed: "quick" },
        { id: 903, total: 12000, fee: 0, status: "pending", currency: "JMD", created_at: new Date().toISOString(), speed: "standard" },
      ],
    });
    if (u.pathname === "/api/payout") return json({ ok: true, request: { id: 904 } });
    if (u.pathname === "/api/quick-payout") {
      const body = JSON.parse(init.body || "{}");
      if ((body.amount || 0) > 100000) return json({ eligible: false, risk_score: 0.82, reasons: ["Requested amount is unusually large vs your payout history.", "Recent refund rate is elevated."], source: "llm" });
      return json({ eligible: true, fee: Math.round((body.amount || 0) * 0.015), risk_score: 0.18, source: "llm", request: { id: 905, reference_id: "fr-mock" } });
    }
    if (u.pathname === "/api/schedules" && (init.method || "GET").toUpperCase() === "GET") return json({
      schedules: [{ id: 1, amount: 25000, kind: "manual", cadence: "weekly", next_run: new Date(Date.now() + 3 * 86400000).toISOString(), active: true, last_result: "submitted" }],
    });
    if (u.pathname === "/api/schedules") return json({ ok: true, id: 2 });
    if (u.pathname.startsWith("/api/schedules/")) return json({ ok: true });
    return new Response("{}", { status: 404 });
  };
}

export function mockSession(): BvSession {
  return {
    inkress: { notify: ({ message }: any) => console.log("[toast]", message) } as any,
    merchant: { id: 183, username: "bookerva-jackjack", name: "Jack Jack Barbershop", currency_code: "JMD", email: "jack@example.com", logo: null },
    user: { id: 90, name: "Front Desk", email: "desk@jackjack.com" },
    scopes: ["payouts:read", "payouts:create", "wallet:read", "financial_accounts:read", "orders:read", "offline_access"],
  };
}
