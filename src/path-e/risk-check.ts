/**
 * Stage 3 Runbook-Discovery — risk-check evaluator.
 *
 * Pure functions that take a Path E shortlist + an operator-supplied
 * thresholds object and emit an annotated shortlist where each candidate
 * carries explicit PASS / WARN / FAIL flags per threshold + an aggregate
 * verdict. The CLI surface (`selection-agent risk-check`) is a thin shell
 * over these functions.
 *
 * Status semantics:
 *   PASS — threshold met
 *   WARN — partial / borderline (only the supported_markets check uses this)
 *   FAIL — threshold violated
 *   INFO — informational only; does NOT contribute to aggregate verdict
 *          (used when a check is disabled by configuration, e.g.
 *           subscription_iap when requireSubscriptionIap=false)
 *
 * Aggregate verdict:
 *   FAIL  if any check is FAIL
 *   WARN  if no FAILs and at least one WARN
 *   PASS  otherwise (INFO entries are ignored)
 */

import type { RiskThresholds } from "./risk-thresholds.ts";

export type CheckStatus = "PASS" | "WARN" | "FAIL" | "INFO";
export type Verdict = "PASS" | "WARN" | "FAIL";

export type CheckName =
  | "markets_spread"
  | "tenure"
  | "subscription_iap"
  | "supported_markets"
  | "clonable_dna";

export interface RiskCheck {
  name: CheckName;
  status: CheckStatus;
  details: string;
}

export interface RiskCheckResult {
  overall: Verdict;
  checks: RiskCheck[];
}

/**
 * Minimal candidate shape required by the evaluator. Mirrors the relevant
 * fields from the shortlist pipeline's `Candidate` type without coupling to
 * the full type — keeps the evaluator usable on any shortlist-shaped JSON.
 */
export interface RiskCheckCandidate {
  app_id: string;
  store: string;
  markets_active: string[];
  tenure_days_max: number;
  has_subscription_iap: boolean;
  dna_class: string | null;
  // Anything else passes through unchanged when annotating.
  [key: string]: unknown;
}

export interface AnnotatedCandidate extends RiskCheckCandidate {
  risk_check: RiskCheckResult;
}

export interface AnnotatedShortlist {
  summary: { total: number; pass: number; warn: number; fail: number };
  candidates: AnnotatedCandidate[];
}

function checkMarketsSpread(
  c: RiskCheckCandidate,
  t: RiskThresholds,
): RiskCheck {
  const n = c.markets_active.length;
  if (n >= t.maxConcurrentMarkets) {
    return {
      name: "markets_spread",
      status: "PASS",
      details: `${n} markets >= ${t.maxConcurrentMarkets} required`,
    };
  }
  return {
    name: "markets_spread",
    status: "FAIL",
    details: `${n} markets < ${t.maxConcurrentMarkets} required`,
  };
}

function checkTenure(c: RiskCheckCandidate, t: RiskThresholds): RiskCheck {
  if (c.tenure_days_max >= t.minTenureDays) {
    return {
      name: "tenure",
      status: "PASS",
      details: `${c.tenure_days_max}d >= ${t.minTenureDays}d`,
    };
  }
  return {
    name: "tenure",
    status: "FAIL",
    details: `${c.tenure_days_max}d < ${t.minTenureDays}d`,
  };
}

function checkSubscriptionIap(
  c: RiskCheckCandidate,
  t: RiskThresholds,
): RiskCheck {
  if (!t.requireSubscriptionIap) {
    return {
      name: "subscription_iap",
      status: "INFO",
      details: "subscription IAP not required",
    };
  }
  if (c.has_subscription_iap) {
    return {
      name: "subscription_iap",
      status: "PASS",
      details: "subscription IAP present",
    };
  }
  return {
    name: "subscription_iap",
    status: "FAIL",
    details: "subscription IAP required but absent",
  };
}

function checkSupportedMarkets(
  c: RiskCheckCandidate,
  t: RiskThresholds,
): RiskCheck {
  const supported = new Set(t.supportedMarkets.map((m) => m.toLowerCase()));
  const active = c.markets_active.map((m) => m.toLowerCase());
  if (active.length === 0) {
    return {
      name: "supported_markets",
      status: "FAIL",
      details: "candidate has no active markets",
    };
  }
  const inside = active.filter((m) => supported.has(m));
  const outside = active.filter((m) => !supported.has(m));
  if (outside.length === 0) {
    return {
      name: "supported_markets",
      status: "PASS",
      details: `all ${active.length} markets in supported set`,
    };
  }
  if (inside.length === 0) {
    return {
      name: "supported_markets",
      status: "FAIL",
      details: `none of ${active.length} markets in supported set (outside: ${outside.join(", ")})`,
    };
  }
  return {
    name: "supported_markets",
    status: "WARN",
    details: `${inside.length}/${active.length} markets in supported set (outside: ${outside.join(", ")})`,
  };
}

function checkClonableDna(
  c: RiskCheckCandidate,
  t: RiskThresholds,
): RiskCheck {
  const allowed = new Set(t.clonableDnaClasses);
  if (c.dna_class && allowed.has(c.dna_class)) {
    return {
      name: "clonable_dna",
      status: "PASS",
      details: `${c.dna_class} in clonable set`,
    };
  }
  if (!c.dna_class) {
    return {
      name: "clonable_dna",
      status: "FAIL",
      details: "dna_class is null",
    };
  }
  return {
    name: "clonable_dna",
    status: "FAIL",
    details: `${c.dna_class} not in clonable set`,
  };
}

function aggregateVerdict(checks: RiskCheck[]): Verdict {
  let hasWarn = false;
  for (const c of checks) {
    if (c.status === "FAIL") return "FAIL";
    if (c.status === "WARN") hasWarn = true;
  }
  return hasWarn ? "WARN" : "PASS";
}

/**
 * Evaluate a single shortlist candidate against the risk thresholds.
 */
export function evaluateCandidate(
  candidate: RiskCheckCandidate,
  thresholds: RiskThresholds,
): RiskCheckResult {
  const checks: RiskCheck[] = [
    checkMarketsSpread(candidate, thresholds),
    checkTenure(candidate, thresholds),
    checkSubscriptionIap(candidate, thresholds),
    checkSupportedMarkets(candidate, thresholds),
    checkClonableDna(candidate, thresholds),
  ];
  return { overall: aggregateVerdict(checks), checks };
}

/**
 * Evaluate every candidate and produce an annotated shortlist + summary.
 */
export function evaluateShortlist(
  candidates: RiskCheckCandidate[],
  thresholds: RiskThresholds,
): AnnotatedShortlist {
  const annotated: AnnotatedCandidate[] = candidates.map((c) => ({
    ...c,
    risk_check: evaluateCandidate(c, thresholds),
  }));
  const summary = { total: annotated.length, pass: 0, warn: 0, fail: 0 };
  for (const c of annotated) {
    if (c.risk_check.overall === "PASS") summary.pass += 1;
    else if (c.risk_check.overall === "WARN") summary.warn += 1;
    else summary.fail += 1;
  }
  return { summary, candidates: annotated };
}
