import "./index.css";
import {
  initBv, makeToast, bvApi, type BvToastFn,
  mountShell, statRow, dataTable, card, emptyState, pill, flash, h, skeleton, openModal,
} from "./bv-init";

interface Bal { currency: string; available: number; pending: number; reserved: number; total: number; revenue: number; }
interface Wallet { id: number; name: string; type: string; currency?: string; available?: number | null; pending?: number | null; reserved?: number | null; total?: number | null; }
interface Acct { id: number; name: string; type: string; currency?: string; }
interface PayoutInfo { payout_period: number | string | null; last_payable_transaction_date: string | null; next_payout_estimate: string | null; early_payout_percentage_limit: number | null; early_payout_value_limit: number | null; }
interface Payout { id: number; total: number; fee: number; status: string; currency?: string; due_at?: string; created_at?: string; speed: string; }
interface PayoutDetail extends Payout { kind?: string; source_id?: number; destination_id?: number; processed_at?: string | null; reference_id?: string | null; data?: any; }
interface Overview { balances: Bal[]; wallets: Wallet[]; destinations: Acct[]; payouts: Payout[]; quick_fee_pct: number; payout_info: PayoutInfo; }
interface Sched { id: number; amount: number; source_id?: number; destination_id?: number; kind: string; cadence: string; next_run: string; active: boolean; last_result?: string; }

const root = document.getElementById("root")!;
let toast: BvToastFn;
let currency = "JMD";
let ov: Overview | null = null;
let shell: ReturnType<typeof mountShell>;

const STATUS_TONE: Record<string, string> = {
  paid: "ok", processing: "accent", pending: "warning", rejected: "bad", failed: "bad",
};
const STATUS_ICON: Record<string, string> = {
  paid: "check", processing: "send", pending: "clock", rejected: "x", failed: "alert",
};

(async () => {
  let session;
  if (import.meta.env.DEV && !new URLSearchParams(location.search).has("inkress_session")) {
    const m = await import("./dev-mock"); m.installMockFetch(); session = m.mockSession();
  } else {
    try { session = await initBv(); }
    catch (err: any) { root.innerHTML = ""; root.append(fatal(err?.message)); return; }
  }
  toast = makeToast(session.inkress);
  currency = session.merchant.currency_code || "JMD";
  shell = mountShell({
    brandIcon: "cash", brandLogo: "/logo.svg",
    title: "Payouts",
    subtitle: `${session.merchant.name || "Merchant"} · request, schedule & fast-track payouts`,
    poweredBy: "Marketplace",
    tabs: [
      { id: "overview", label: "Overview", icon: "wallet", render: renderOverview },
      { id: "request", label: "Request", icon: "send", render: renderRequest },
      { id: "scheduled", label: "Scheduled", icon: "calendar", render: renderScheduled },
    ],
  });
})();

const money = (n?: number | null, c?: string) => {
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency: c || currency, maximumFractionDigits: 0 }).format(n || 0); }
  catch { return `${c || currency} ${Math.round(n || 0)}`; }
};
const moneyExact = (n?: number | null, c?: string) => {
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency: c || currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0); }
  catch { return `${c || currency} ${(n || 0).toFixed(2)}`; }
};
const date = (s?: string | null) => s ? new Date(s).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—";
const reldate = (s?: string | null) => {
  if (!s) return "—";
  const diff = Date.now() - new Date(s).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return date(s);
};

/* ------------------------------------------------------------------ skeleton helpers */
function skeletonStatRow(count = 3): HTMLElement {
  const tiles = Array.from({ length: count }, () =>
    h("div", { class: "bv-stat py-skeleton-stat" },
      h("div", { class: "bv-skeleton", style: { width: "55%", height: "10px", marginBottom: "10px" } }),
      h("div", { class: "bv-skeleton", style: { width: "75%", height: "26px", marginBottom: "8px" } }),
      h("div", { class: "bv-skeleton", style: { width: "85%", height: "10px" } }),
    )
  );
  return h("div", { class: "bv-stats" }, ...tiles);
}

function skeletonTable(rows = 4, cols = 5): HTMLElement {
  const headCells = Array.from({ length: cols }, () => h("th", null, skeleton("60%", 10)));
  const bodyRows = Array.from({ length: rows }, () =>
    h("tr", null, ...Array.from({ length: cols }, (_, i) =>
      h("td", null, skeleton(i === 0 ? "80%" : i === cols - 1 ? "40%" : "60%", 11))
    ))
  );
  return h("div", { class: "bv-table-wrap" },
    h("table", { class: "bv-table py-skeleton-table" },
      h("thead", null, h("tr", null, ...headCells)),
      h("tbody", null, ...bodyRows)
    )
  );
}

/* ------------------------------------------------------------------ overview loading */
async function loadOverview(host: HTMLElement): Promise<Overview | null> {
  // Tasteful skeleton while loading — never bare "Loading…"
  host.append(
    skeletonStatRow(3),
    h("div", { style: { marginTop: "16px" } }, skeletonStatRow(2)),
    h("div", { style: { marginTop: "16px" } },
      h("div", { class: "bv-card" },
        h("div", { class: "bv-card-head" },
          h("div", { class: "bv-skeleton", style: { width: "120px", height: "14px" } }),
        ),
        skeletonTable(4, 5),
      )
    ),
  );
  ov = await bvApi<Overview>("/api/overview").catch(() => null);
  host.innerHTML = "";
  return ov;
}

/* ================================================================== Overview */
async function renderOverview(host: HTMLElement) {
  const o = await loadOverview(host);
  if (!o) {
    host.append(h("div", { class: "py-error-block" },
      h("div", { class: "py-error-icon" }, "⚠"),
      h("div", null,
        h("div", { class: "py-error-title" }, "Couldn't load your payouts"),
        h("div", { class: "py-error-sub" }, "There was a problem reaching Inkress. Your data is safe."),
      ),
      h("button", { class: "primary sm", onClick: () => { host.innerHTML = ""; renderOverview(host); } }, "Retry"),
    ));
    return;
  }

  // ── Hero: spendable balance(s) leading stat
  const heroStats = o.balances.length
    ? o.balances.map((b, i) => ({
        k: `${b.currency} Available`,
        v: money(b.available, b.currency),
        d: `${money(b.pending, b.currency)} pending · ${money(b.reserved, b.currency)} reserved`,
        icon: "wallet",
        tone: (i === 0 ? "accent" : undefined) as ("accent" | undefined),
      }))
    : [{ k: "Available Balance", v: "—", d: "No wallet balance yet", icon: "wallet" }];

  host.append(statRow(heroStats));

  // ── Payout schedule
  const pi = o.payout_info || ({} as PayoutInfo);
  const schedStats: Array<{ k: string; v: string; d?: string; icon?: string; tone?: "ok" | "accent" | "bad" }> = [];
  if (pi.next_payout_estimate) schedStats.push({ k: "Next Payout (est.)", v: date(pi.next_payout_estimate), d: "Based on your schedule", icon: "calendar", tone: "ok" });
  if (pi.payout_period != null) schedStats.push({ k: "Payout Period", v: typeof pi.payout_period === "number" ? `${pi.payout_period} days` : String(pi.payout_period), d: "Standard settlement", icon: "cash" });
  if (pi.last_payable_transaction_date) schedStats.push({ k: "Last Payable Txn", v: date(pi.last_payable_transaction_date), icon: "check", tone: "ok" });

  if (schedStats.length) {
    const earlyBits: string[] = [];
    if (pi.early_payout_percentage_limit != null) earlyBits.push(`up to ${pi.early_payout_percentage_limit}% of balance`);
    if (pi.early_payout_value_limit != null) earlyBits.push(`max ${money(pi.early_payout_value_limit)}`);
    const feeLabel = `${Math.round(o.quick_fee_pct * 1000) / 10}%`;
    host.append(card({
      title: "Payout schedule",
      body: [
        statRow(schedStats),
        h("div", { class: "py-info-strip" },
          h("span", { class: "py-info-badge" }, `Quick ${feeLabel} fee`),
          h("span", null, `Next-day payouts available at a ${feeLabel} fee${earlyBits.length ? " · " + earlyBits.join(" · ") : ""}. Standard payouts settle on your schedule at no fee.`),
        ),
      ],
    }));
  }

  // ── Recent payouts table
  const tableEl = o.payouts.length
    ? dataTable<Payout>({
        columns: [
          {
            head: "Amount", num: true,
            cell: (p) => h("span", { class: "py-amount" }, money(p.total, p.currency)),
          },
          {
            head: "Speed",
            cell: (p) => p.speed === "quick"
              ? pill("Quick", "accent", "send")
              : h("span", { class: "bv-faint" }, "Standard"),
          },
          {
            head: "Fee", num: true,
            cell: (p) => p.fee ? h("span", { class: "py-fee" }, moneyExact(p.fee, p.currency)) : h("span", { class: "bv-faint" }, "—"),
          },
          {
            head: "Status",
            cell: (p) => pill(capitalize(p.status), STATUS_TONE[p.status] || "", STATUS_ICON[p.status]),
          },
          {
            head: "Requested",
            cell: (p) => h("span", { title: date(p.created_at) }, reldate(p.created_at)),
          },
        ],
        rows: o.payouts,
        rowActions: (p) => h("button", { class: "ghost sm", onClick: (e: Event) => { e.stopPropagation(); openPayoutDetail(p.id); } }, "View"),
        onRowClick: (p) => openPayoutDetail(p.id),
        empty: emptyState({
          icon: "cash",
          title: "No payouts yet",
          text: "Your payout history will appear here once you make your first request.",
          action: h("button", { class: "primary sm", onClick: () => shell.select("request") }, "Request a payout"),
        }),
      })
    : emptyState({
        icon: "cash",
        title: "No payouts yet",
        text: "Your payout history will appear here once you make your first request.",
        action: h("button", { class: "primary sm", onClick: () => shell.select("request") }, "Request a payout"),
      });

  host.append(card({ title: "Recent payouts", body: tableEl }));
}

/* ============================================================ Payout detail */
function openPayoutDetail(id: number) {
  const bodyWrap = h("div", { class: "py-detail-body" });

  // Loading skeleton inside the modal
  bodyWrap.append(
    h("div", { class: "py-detail-skeleton" },
      skeleton("50%", 14), h("div", { style: { height: "8px" } }),
      skeleton("30%", 10), h("div", { style: { height: "16px" } }),
      ...Array.from({ length: 6 }, () => h("div", { class: "py-detail-skel-row" },
        skeleton("30%", 11), skeleton("40%", 11)
      )),
    )
  );

  const modal = openModal({
    title: `Payout #${id}`,
    body: bodyWrap,
    actions: [{ label: "Close" }],
  });

  bvApi<{ payout: PayoutDetail }>(`/api/payout/${id}`)
    .then(({ payout: p }) => {
      bodyWrap.innerHTML = "";
      const dest = ov?.destinations.find((d) => d.id === p.destination_id);
      const src = ov?.wallets.find((w) => w.id === p.source_id);
      const tone = STATUS_TONE[p.status] || "";
      const ico = STATUS_ICON[p.status];

      // Status hero
      bodyWrap.append(
        h("div", { class: "py-detail-status" },
          pill(capitalize(p.status), tone, ico),
          p.speed === "quick"
            ? h("div", { class: "py-speed-badge" }, pill("Quick · Next-day", "accent", "send"))
            : h("div", { class: "py-speed-badge" }, h("span", { class: "bv-faint" }, "Standard settlement")),
        ),
      );

      // Quick payout risk meter (if eligible data present)
      if (p.data?.eligibility?.risk_score != null) {
        const score = Math.round(p.data.eligibility.risk_score * 100);
        const riskTone = score < 30 ? "ok" : score < 65 ? "warn" : "bad";
        bodyWrap.append(
          h("div", { class: "py-risk-meter" },
            h("div", { class: "py-risk-label" },
              h("span", null, "Risk score"),
              h("span", { class: `py-risk-val is-${riskTone}` }, `${score}/100`),
            ),
            h("div", { class: "py-risk-track" },
              h("div", { class: `py-risk-fill is-${riskTone}`, style: { width: `${score}%` } }),
            ),
          ),
        );
        if (p.data.eligibility.reasons?.length) {
          bodyWrap.append(
            h("ul", { class: "py-reasons-list" },
              ...(p.data.eligibility.reasons as string[]).map((r) =>
                h("li", null, h("span", { class: "py-reason-dot" }), r)
              ),
            ),
          );
        }
      }

      // Detail rows
      const rows: Array<[string, string | Node]> = [
        ["Amount",    h("span", { class: "py-amount py-amount-lg" }, money(p.total, p.currency))],
        ["Fee",       p.fee ? moneyExact(p.fee, p.currency) : h("span", { class: "bv-faint" }, "No fee")],
        ["From",      src ? `${src.name}${src.currency ? " · " + src.currency : ""}` : (p.source_id ? `Wallet #${p.source_id}` : "—")],
        ["To",        dest ? `${dest.name}${dest.currency ? " · " + dest.currency : ""}` : (p.destination_id ? `Account #${p.destination_id}` : "—")],
        ["Requested", date(p.created_at)],
        ["Processed", date(p.processed_at)],
        ["Reference", p.reference_id ? h("code", { class: "bv-mono" }, p.reference_id) : "—"],
      ];

      bodyWrap.append(
        h("dl", { class: "py-detail-dl" },
          ...rows.map(([k, v]) =>
            h("div", { class: "py-detail-row" },
              h("dt", null, k),
              h("dd", null, typeof v === "string" ? v : v),
            )
          )
        ),
        h("p", { class: "py-review-note" }, "Payouts are reviewed and processed by Inkress. Processing times vary by destination."),
      );
    })
    .catch((e: any) => {
      bodyWrap.innerHTML = "";
      bodyWrap.append(
        h("div", { class: "py-error-block" },
          h("div", { class: "py-error-icon" }, "⚠"),
          h("div", null,
            h("div", { class: "py-error-title" }, "Couldn't load payout"),
            h("div", { class: "py-error-sub" }, e?.message || "Please try again."),
          ),
          h("button", { class: "primary sm", onClick: () => { modal.close(); openPayoutDetail(id); } }, "Retry"),
        ),
      );
    });
}

/* =================================================================== Request */
async function renderRequest(host: HTMLElement) {
  // Skeleton while loading
  host.append(
    h("div", { class: "bv-card" },
      h("div", { class: "bv-card-head" }, h("div", { class: "bv-skeleton", style: { width: "140px", height: "14px" } })),
      ...Array.from({ length: 4 }, () =>
        h("div", { style: { marginBottom: "14px" } },
          h("div", { class: "bv-skeleton", style: { width: "60px", height: "10px", marginBottom: "6px" } }),
          h("div", { class: "bv-skeleton", style: { width: "100%", height: "38px" } }),
        )
      ),
    )
  );

  const o = ov || (await bvApi<Overview>("/api/overview").catch(() => null));
  host.innerHTML = "";

  if (!o) {
    host.append(h("div", { class: "py-error-block" },
      h("div", { class: "py-error-icon" }, "⚠"),
      h("div", null,
        h("div", { class: "py-error-title" }, "Couldn't load accounts"),
        h("div", { class: "py-error-sub" }, "Unable to reach Inkress. Please try again."),
      ),
      h("button", { class: "primary sm", onClick: () => { host.innerHTML = ""; renderRequest(host); } }, "Retry"),
    ));
    return;
  }
  if (!o.destinations.length) {
    host.append(emptyState({
      icon: "alert",
      title: "No payout destination",
      text: "Add a bank account or payout destination in your Inkress dashboard, then come back to request a payout.",
    }));
    return;
  }

  const amount = h("input", { type: "number", min: "1", step: "100", placeholder: "0" }) as HTMLInputElement;
  const dest = h("select", null, ...o.destinations.map((d) => h("option", { value: String(d.id) }, `${d.name}${d.currency ? " · " + d.currency : ""}`))) as HTMLSelectElement;
  const walletOpts: Wallet[] = o.wallets.length ? o.wallets : [{ id: 0, name: "Default wallet", type: "wallet" }];
  const src = h("select", null, ...walletOpts.map((w) => h("option", { value: String(w.id) }, walletLabel(w)))) as HTMLSelectElement;

  const availBadge = h("div", { class: "py-avail-badge" });
  const showAvail = () => {
    const w = walletOpts.find((x) => x.id === Number(src.value));
    availBadge.innerHTML = "";
    if (w && w.available != null) {
      availBadge.append(
        h("span", { class: "py-avail-label" }, "Available:"),
        h("span", { class: "py-avail-amount" }, money(w.available, w.currency)),
      );
    }
  };
  src.addEventListener("change", showAvail); showAvail();

  const verdict = h("div", { class: "py-verdict" });

  // ── Fee callout (live)
  const feeCallout = h("div", { class: "py-fee-callout" });
  const feePct = Math.round(o.quick_fee_pct * 1000) / 10;
  const updateFeeCallout = () => {
    const amt = Number(amount.value) || 0;
    feeCallout.innerHTML = "";
    if (amt > 0) {
      const fee = Math.round(amt * o.quick_fee_pct);
      feeCallout.append(
        h("div", { class: "py-fee-row" },
          h("span", null, "Standard payout"),
          h("span", { class: "py-fee-free" }, "No fee"),
        ),
        h("div", { class: "py-fee-row" },
          h("span", null, `Quick payout (next-day · ${feePct}%)`),
          h("span", { class: "py-fee-cost" }, `−${money(fee)}`),
        ),
      );
    }
  };
  amount.addEventListener("input", updateFeeCallout);

  const std = h("button", { class: "primary", style: { flex: "1", minWidth: "160px" } }, "Request payout") as HTMLButtonElement;
  const quick = h("button", { class: "py-quick-btn", style: { flex: "1", minWidth: "160px" } }, `Quick · ${feePct}% fee`) as HTMLButtonElement;

  const vals = () => ({
    amount: Number(amount.value) || 0,
    destination_id: Number(dest.value),
    source_id: Number(src.value) || undefined,
    currency: o.destinations.find((d) => d.id === Number(dest.value))?.currency,
  });
  const guard = () => {
    const v = vals();
    if (v.amount <= 0) { flash("Please enter an amount greater than zero.", "warning"); amount.focus(); return null; }
    return v;
  };

  std.addEventListener("click", async () => {
    const v = guard(); if (!v) return;
    std.disabled = true; quick.disabled = true;
    std.innerHTML = `<span class="py-spinner"></span> Submitting…`;
    const r = await bvApi<{ ok?: boolean; error?: string }>(
      "/api/payout", { method: "POST", body: JSON.stringify(v) }
    ).catch((e: any): { ok?: boolean; error?: string } => ({ error: e?.message }));
    std.disabled = false; quick.disabled = false; std.textContent = "Request payout";
    if (r?.ok) { ov = null; flash("Payout request submitted for review by Inkress.", "success"); shell.select("overview"); }
    else flash(r?.error || "Request failed. Please try again.", "error");
  });

  quick.addEventListener("click", async () => {
    const v = guard(); if (!v) return;
    std.disabled = true; quick.disabled = true;
    quick.innerHTML = `<span class="py-spinner"></span> Checking eligibility…`;
    verdict.innerHTML = "";
    const r = await bvApi<{
      eligible?: boolean; fee?: number; risk_score?: number; reasons?: string[]; error?: string;
    }>("/api/quick-payout", { method: "POST", body: JSON.stringify(v) })
      .catch((e: any): { eligible?: boolean; fee?: number; risk_score?: number; reasons?: string[]; error?: string } => ({ error: e?.message }));
    std.disabled = false; quick.disabled = false;
    quick.textContent = `Quick · ${feePct}% fee`;

    if (r?.error && r.eligible == null) { flash(r.error, "error"); return; }

    if (r?.eligible) {
      ov = null;
      verdict.append(
        h("div", { class: "py-verdict-ok" },
          pill("Eligible for Quick payout", "ok", "check"),
          h("div", { class: "py-verdict-detail" },
            h("span", null, `Fee: ${money(r.fee)}`),
            h("span", { class: "py-verdict-dot" }),
            h("span", { class: "bv-faint" }, `Risk score: ${Math.round((r.risk_score || 0) * 100)}/100`),
          ),
          h("p", { class: "py-review-note" }, "Submitted for next-day processing. Inkress reviews all payouts before release."),
        ),
      );
      flash(`Approved for next-day · fee ${money(r.fee)} — submitted for processing.`, "success");
      setTimeout(() => shell.select("overview"), 1400);
    } else {
      verdict.append(
        h("div", { class: "py-verdict-no" },
          pill("Not eligible for Quick payout", "bad", "alert"),
          (r?.reasons?.length
            ? h("ul", { class: "py-reasons-list" },
                ...(r.reasons).map((x) => h("li", null, h("span", { class: "py-reason-dot" }), x))
              )
            : null
          ),
          h("p", { class: "py-review-note" }, "You can still request a Standard payout at no fee."),
        ),
      );
    }
  });

  host.append(
    card({
      title: "Request a payout",
      body: [
        field("Amount", h("div", { class: "py-amount-wrap" },
          h("div", { class: "py-currency-prefix" }, currency),
          amount,
        ), "Enter the payout amount"),
        field("To", dest, "Your payout destination account"),
        field("From", src, "Source wallet"),
        availBadge,
        feeCallout,
        h("div", { class: "py-actions" }, std, quick),
        h("p", { class: "py-review-note" }, "Payouts are reviewed by Inkress before release. Standard payouts settle on your schedule at no fee. Quick payouts are pre-screened for eligibility and settle next-day for a small fee."),
        verdict,
      ],
    }),
  );
}

/* ================================================================= Scheduled */
async function renderScheduled(host: HTMLElement) {
  // Skeleton
  host.append(
    h("div", { class: "bv-card", style: { marginBottom: "16px" } },
      h("div", { class: "bv-card-head" }, h("div", { class: "bv-skeleton", style: { width: "160px", height: "14px" } })),
      ...Array.from({ length: 5 }, () =>
        h("div", { style: { marginBottom: "14px" } },
          h("div", { class: "bv-skeleton", style: { width: "70px", height: "10px", marginBottom: "6px" } }),
          h("div", { class: "bv-skeleton", style: { width: "100%", height: "38px" } }),
        )
      ),
    ),
    h("div", { class: "bv-card" },
      h("div", { class: "bv-card-head" }, h("div", { class: "bv-skeleton", style: { width: "140px", height: "14px" } })),
      skeletonTable(3, 5),
    ),
  );

  const [o, r] = await Promise.all([
    ov || bvApi<Overview>("/api/overview").catch(() => null),
    bvApi<{ schedules: Sched[] }>("/api/schedules").catch(() => ({ schedules: [] })),
  ]);
  host.innerHTML = "";

  const dests = o?.destinations || [];
  if (dests.length) {
    const walletOpts: Wallet[] = (o?.wallets?.length ? o.wallets : [{ id: 0, name: "Default wallet", type: "wallet" }]);
    const amount = h("input", { type: "number", min: "1", step: "100", placeholder: "0" }) as HTMLInputElement;
    const dest = h("select", null, ...dests.map((d) => h("option", { value: String(d.id) }, `${d.name}${d.currency ? " · " + d.currency : ""}`))) as HTMLSelectElement;
    const src = h("select", null, ...walletOpts.map((w) => h("option", { value: String(w.id) }, walletLabel(w)))) as HTMLSelectElement;
    const speed = h("select", null,
      h("option", { value: "manual" }, "Standard · no fee"),
      h("option", { value: "early" }, `Quick (next-day) · ${Math.round((o?.quick_fee_pct || 0) * 1000) / 10}% fee`),
    ) as HTMLSelectElement;
    const cadence = h("select", null,
      h("option", { value: "once" }, "One-time"),
      h("option", { value: "weekly" }, "Weekly"),
      h("option", { value: "monthly" }, "Monthly"),
    ) as HTMLSelectElement;
    const when = h("input", { type: "date" }) as HTMLInputElement;

    const priceCallout = h("div", { class: "py-fee-callout" });
    const updatePrice = () => {
      const a = Number(amount.value) || 0;
      priceCallout.innerHTML = "";
      if (a > 0) {
        if (speed.value === "early") {
          const fee = Math.round(a * (o?.quick_fee_pct || 0));
          priceCallout.append(
            h("div", { class: "py-fee-row" },
              h("span", null, "Each run"),
              h("span", null,
                h("span", { class: "py-amount" }, money(a)),
                h("span", { class: "py-fee-cost" }, ` − ${money(fee)} fee`),
              ),
            ),
            h("div", { class: "py-fee-note" }, "Pre-screened at each run & reviewed by Inkress."),
          );
        } else {
          priceCallout.append(
            h("div", { class: "py-fee-row" },
              h("span", null, "Each run"),
              h("span", null,
                h("span", { class: "py-amount" }, money(a)),
                h("span", { class: "py-fee-free" }, " · no fee"),
              ),
            ),
          );
        }
      }
    };
    amount.addEventListener("input", updatePrice); speed.addEventListener("change", updatePrice);

    const add = h("button", { class: "primary" }, "Schedule payout") as HTMLButtonElement;
    add.addEventListener("click", async () => {
      const a = Number(amount.value) || 0;
      if (a <= 0 || !when.value) { flash("Amount and start date are required.", "warning"); return; }
      add.disabled = true; add.innerHTML = `<span class="py-spinner"></span> Scheduling…`;
      const res = await bvApi<{ ok?: boolean; error?: string }>(
        "/api/schedules",
        { method: "POST", body: JSON.stringify({ amount: a, destination_id: Number(dest.value), source_id: Number(src.value) || undefined, kind: speed.value, cadence: cadence.value, next_run: new Date(when.value).toISOString() }) }
      ).catch((e: any): { ok?: boolean; error?: string } => ({ error: e?.message }));
      add.disabled = false; add.textContent = "Schedule payout";
      if (res?.ok) { flash("Payout scheduled successfully.", "success"); shell.select("scheduled"); }
      else flash(res?.error || "Couldn't schedule. Please try again.", "error");
    });

    host.append(card({
      title: "Schedule a payout",
      body: [
        field("Amount", h("div", { class: "py-amount-wrap" },
          h("div", { class: "py-currency-prefix" }, currency),
          amount,
        ), "Enter the recurring amount"),
        field("To", dest, "Payout destination"),
        field("From", src, "Source wallet"),
        field("Speed", speed, "Standard settles on your schedule; Quick settles next-day with a fee"),
        field("Repeat", cadence, "How often to run"),
        field("Starting", when, "First run date"),
        priceCallout,
        h("div", { class: "py-actions" }, add),
      ],
    }));
  } else {
    host.append(emptyState({
      icon: "alert",
      title: "No payout destination",
      text: "Add a bank account in your Inkress dashboard to set up scheduled payouts.",
    }));
  }

  // ── Schedules table
  const cancelBtn = (s: Sched) =>
    h("button", {
      class: "ghost sm",
      onClick: async (e: Event) => {
        e.stopPropagation();
        const btn = e.target as HTMLButtonElement;
        btn.disabled = true; btn.textContent = "Canceling…";
        await bvApi(`/api/schedules/${s.id}`, { method: "DELETE" }).catch(() => {});
        flash("Schedule canceled.", "info");
        shell.select("scheduled");
      },
    }, "Cancel");

  host.append(card({
    title: "Scheduled payouts",
    body: dataTable<Sched>({
      columns: [
        { head: "Amount", num: true, cell: (s) => h("span", { class: "py-amount" }, money(s.amount)) },
        { head: "Speed", cell: (s) => s.kind === "early" ? pill("Quick", "accent", "send") : h("span", { class: "bv-faint" }, "Standard") },
        { head: "Repeat", cell: (s) => h("span", null, capitalize(s.cadence)) },
        { head: "Next run", cell: (s) => date(s.next_run) },
        { head: "Status", cell: (s) => s.active ? pill("Active", "ok", "check") : pill("Done", "") },
      ],
      rows: r.schedules || [],
      rowActions: (s) => s.active ? cancelBtn(s) : null,
      empty: emptyState({
        icon: "calendar",
        title: "No scheduled payouts",
        text: "Set up automatic one-time or recurring payouts using the form above.",
      }),
    }),
  }));
}

/* --------------------------------------------------------------------- util */
function walletLabel(w: Wallet): string {
  const cur = w.currency ? ` · ${w.currency}` : "";
  const bal = w.available != null ? ` — ${money(w.available, w.currency)} avail` : "";
  return `${w.name}${cur}${bal}`;
}

function field(label: string, input: Node, hint?: string): HTMLElement {
  return h("div", { class: "py-field" },
    h("label", { class: "bv-label" }, label),
    input,
    hint ? h("span", { class: "py-hint" }, hint) : null,
  );
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function fatal(msg?: string): HTMLElement {
  return h("div", { class: "py-fatal" },
    h("div", { class: "py-fatal-icon" }, "⚠"),
    h("h2", null, "Couldn't start"),
    h("p", { class: "bv-muted" }, msg || "Unable to initialize the app."),
    h("p", { class: "py-hint" }, "Try refreshing the page or contact support if this persists."),
  );
}
