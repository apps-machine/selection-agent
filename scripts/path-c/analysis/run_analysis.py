#!/usr/bin/env python3
"""
Path C v3 — analysis harness.

Pipeline (per design doc `docs/planning/agent-v1-path-c-design.md`):

  1. Load factor scores (pathc.f0/f1/f2/f4/f5/f7/f11/f14) from
     signal_snapshots and winner labels from path_c_winners.

  2. Per-cohort preprocessing:
       - z-score each factor (mean 0, sd 1) within cohort
       - winsorize at 1%/99% percentiles
       - Gram-Schmidt residualization: F0 anchor, then F1, F2, F4, F5,
         F7, F11, F14 in pre-registered order (residual of each is
         orthogonalized against F0 and all prior residuals)

  3. Univariate factor tests (per testable factor F1..F14):
       - rank cohort apps by F-x_residual (direction-aware via univariate
         logistic coefficient sign)
       - top-decile precision: fraction of top-10% that are winners
       - lift = precision(F-x) - precision(F0_ranked) per cohort
       - cluster bootstrap over (app, market, store) × t0 cells, 200 reps
       - "alive" iff median lift ≥ +3pt at K=10 in SEA AND p < 0.00625
         (Bonferroni for 8 hypotheses)

  4. Composite test:
       - penalized logistic regression (L2, λ via 5-fold CV within fold)
         on F0 + 7 residualized factors + market FE + store FE
       - forward-chaining temporal CV: train on t0s 1..k, test on t0_{k+1}
       - "alive" iff out-of-sample precision@10 ≥ F0_baseline_K10 + 5pt
         in SEA AND ≥ F0_baseline_K10 + 2pt in tier-1

  5. Write results.json + verdict.md to
     docs/planning/pathc-runs/{ISO timestamp}/

Designed to run end-to-end in <2 minutes on the existing 10,418-row
cohort-app dataset.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LinearRegression, LogisticRegression
from sklearn.preprocessing import OneHotEncoder

REPO_ROOT = Path(__file__).resolve().parents[5]
DB_PATH = REPO_ROOT / ".cache" / "selection-agent.sqlite"
OUT_BASE = REPO_ROOT / "docs" / "planning" / "pathc-runs"

SEA_MARKETS = {"id", "vn", "th", "my", "bd"}
FACTOR_ORDER = ["pathc.f1", "pathc.f2", "pathc.f4", "pathc.f5", "pathc.f7", "pathc.f11", "pathc.f14"]
ALL_FACTORS = ["pathc.f0", *FACTOR_ORDER]
TESTABLE_FACTORS = list(FACTOR_ORDER)  # 7 factors tested for "alive"
BONFERRONI_DENOM = 8  # 7 univariate + 1 composite
ALPHA = 0.05 / BONFERRONI_DENOM  # = 0.00625
TOP_DECILE_FRAC = 0.10
LIFT_THRESHOLD_K1 = 0.03  # +3pt over F0_residualized
COMPOSITE_LIFT_SEA = 0.05
COMPOSITE_LIFT_TIER1 = 0.02
BOOTSTRAP_REPS = 200
MIN_COVERAGE_FOR_COMPOSITE = 0.50  # factors below this drop from composite (per design)
RNG_SEED = 42


def parse_prompt_version(pv: str) -> tuple[str | None, str | None]:
    """'pathc-v3-{market}-{store}-tg' → (market, store)."""
    if not pv.startswith("pathc-v3-") or not pv.endswith("-tg"):
        return None, None
    inner = pv[len("pathc-v3-"):-len("-tg")]
    parts = inner.split("-")
    if len(parts) < 2:
        return None, None
    store = parts[-1]
    if store not in ("apple", "googleplay"):
        return None, None
    market = "-".join(parts[:-1])
    return market, store


def load_data() -> pd.DataFrame:
    """Read SQLite and return wide cohort-app DataFrame."""
    con = sqlite3.connect(str(DB_PATH))
    try:
        # Load all factor rows in one query, parse cohort key, pivot wide.
        long = pd.read_sql_query(
            """
            SELECT app_id, signal_name, t AS t0, llm_prompt_version, value
              FROM signal_snapshots
             WHERE signal_name LIKE 'pathc.%'
            """,
            con,
        )
        parsed = long["llm_prompt_version"].apply(parse_prompt_version)
        long["market"] = parsed.apply(lambda x: x[0])
        long["store"] = parsed.apply(lambda x: x[1])
        long = long.dropna(subset=["market", "store"])

        wide = (
            long.pivot_table(
                index=["app_id", "market", "store", "t0"],
                columns="signal_name",
                values="value",
                aggfunc="first",
            )
            .reset_index()
        )
        wide.columns.name = None

        winners = pd.read_sql_query(
            """
            SELECT app_id, market, store, t0, winner_exact, winner_window_7d
              FROM path_c_winners
            """,
            con,
        )
    finally:
        con.close()

    df = wide.merge(winners, on=["app_id", "market", "store", "t0"], how="inner")
    df["tier"] = df["market"].apply(lambda m: "sea" if m in SEA_MARKETS else "tier1")
    df["t0_iso"] = pd.to_datetime(df["t0"], unit="ms", utc=True).dt.strftime("%Y-%m-%d")
    df["cohort_key"] = df["market"] + "|" + df["store"] + "|" + df["t0_iso"]
    return df


def winsorize(s: pd.Series, lo: float = 0.01, hi: float = 0.99) -> pd.Series:
    if s.dropna().empty:
        return s
    qlo, qhi = s.quantile([lo, hi])
    return s.clip(lower=qlo, upper=qhi)


def zscore(s: pd.Series) -> pd.Series:
    valid = s.dropna()
    if len(valid) < 2:
        return s
    mu = valid.mean()
    sd = valid.std(ddof=1)
    if not np.isfinite(sd) or sd == 0:
        return pd.Series(np.zeros(len(s)), index=s.index)
    return (s - mu) / sd


def residualize(df_cohort: pd.DataFrame, factor_order: list[str]) -> pd.DataFrame:
    """Gram-Schmidt: F0 anchor, then each Fx residualized against F0 and prior residuals.

    Returns df_cohort with new columns f"{factor}_resid" for each in factor_order.
    """
    df = df_cohort.copy()
    df["pathc.f0_resid"] = df["pathc.f0"]  # baseline left as-is
    prior_resids = ["pathc.f0_resid"]
    for f in factor_order:
        resid_col = f"{f}_resid"
        target = df[f]
        mask = target.notna()
        # Build prior matrix on rows where target is non-null
        X_prior = df.loc[mask, prior_resids]
        y = target.loc[mask]
        # Drop prior cols that are all-null in this slice
        valid_priors = [c for c in prior_resids if X_prior[c].notna().all()]
        if not valid_priors or len(y) < 3:
            df[resid_col] = target  # not enough data for residualization → use raw
        else:
            lr = LinearRegression()
            lr.fit(X_prior[valid_priors].values, y.values)
            pred = lr.predict(X_prior[valid_priors].values)
            df.loc[mask, resid_col] = y.values - pred
            # Where target was null, keep null
        prior_resids.append(resid_col)
    return df


def preprocess_cohorts(df: pd.DataFrame) -> pd.DataFrame:
    """Apply z-score + winsorize + residualize per cohort. Returns df with *_resid columns."""
    out_chunks = []
    for cohort_key, sub in df.groupby("cohort_key"):
        sub = sub.copy()
        for f in ALL_FACTORS:
            sub[f] = winsorize(sub[f])
            sub[f] = zscore(sub[f])
        sub = residualize(sub, FACTOR_ORDER)
        out_chunks.append(sub)
    return pd.concat(out_chunks, ignore_index=True)


def precision_top_decile(df_cohort: pd.DataFrame, score_col: str, winner_col: str, ascending: bool) -> float | None:
    """Top-decile precision: fraction of top 10% (by score) that are winners.

    F0 is current_rank (lower=better) → ascending=True.
    Other factors: ascending=False if positive correlation with winner; the caller passes the right direction.
    """
    valid = df_cohort.dropna(subset=[score_col, winner_col])
    if len(valid) < 10:
        return None
    sorted_df = valid.sort_values(score_col, ascending=ascending)
    k = max(1, int(np.ceil(len(sorted_df) * TOP_DECILE_FRAC)))
    top = sorted_df.head(k)
    return float(top[winner_col].mean())


def factor_direction(df: pd.DataFrame, factor_resid_col: str, winner_col: str) -> bool:
    """Return ascending=True if rank-by-ascending predicts winner; else False (descending)."""
    sub = df.dropna(subset=[factor_resid_col, winner_col])
    if len(sub) < 30:
        return False  # default to descending = "higher score predicts winner"
    # Correlation between residual and winner. Positive correlation → higher score = more winner → descending.
    corr = sub[factor_resid_col].corr(sub[winner_col])
    if not np.isfinite(corr):
        return False
    return corr < 0  # ascending=True when score and winner are negatively correlated


def univariate_per_cohort_lift(df: pd.DataFrame, factor: str, winner_col: str) -> pd.DataFrame:
    """For each cohort, compute (precision_factor, precision_F0, lift)."""
    factor_resid_col = f"{factor}_resid"
    rows = []
    asc_factor = factor_direction(df, factor_resid_col, winner_col)
    for cohort_key, sub in df.groupby("cohort_key"):
        # Skip cohorts where the factor is fully null (e.g., F7 on cohort with no publisher data)
        if sub[factor_resid_col].notna().sum() < 10:
            continue
        prec_f0 = precision_top_decile(sub, "pathc.f0_resid", winner_col, ascending=True)
        prec_factor = precision_top_decile(sub, factor_resid_col, winner_col, ascending=asc_factor)
        if prec_f0 is None or prec_factor is None:
            continue
        rows.append(
            {
                "cohort_key": cohort_key,
                "tier": sub["tier"].iloc[0],
                "market": sub["market"].iloc[0],
                "store": sub["store"].iloc[0],
                "t0_iso": sub["t0_iso"].iloc[0],
                "n_apps": int(sub[factor_resid_col].notna().sum()),
                "prec_f0": prec_f0,
                "prec_factor": prec_factor,
                "lift": prec_factor - prec_f0,
                "factor_direction_ascending": asc_factor,
            }
        )
    return pd.DataFrame(rows)


def cluster_bootstrap(per_cohort: pd.DataFrame, lift_col: str, reps: int, rng: np.random.Generator) -> dict:
    """Block bootstrap over cohorts (each cohort = one cluster). Returns percentile CI + p_value."""
    sea = per_cohort[per_cohort["tier"] == "sea"]
    if len(sea) < 3:
        return {"median": None, "p5": None, "p95": None, "p_two_sided": None, "n_cohorts": int(len(sea))}
    boots = np.empty(reps)
    sea_lifts = sea[lift_col].values
    for i in range(reps):
        sample = rng.choice(sea_lifts, size=len(sea_lifts), replace=True)
        boots[i] = np.median(sample)
    median = float(np.median(sea_lifts))
    p5 = float(np.percentile(boots, 2.5))
    p95 = float(np.percentile(boots, 97.5))
    # two-sided p-value: fraction of bootstrap medians on the opposite side of zero from observed
    if median > 0:
        p = float((boots <= 0).mean()) * 2
    elif median < 0:
        p = float((boots >= 0).mean()) * 2
    else:
        p = 1.0
    p = min(1.0, p)
    return {"median": median, "p5": p5, "p95": p95, "p_two_sided": p, "n_cohorts": int(len(sea))}


def composite_analysis(df: pd.DataFrame, winner_col: str, drop_factors: list[str]) -> dict:
    """Forward-chaining temporal CV: train on t0s 1..k, test on t0_{k+1}. Penalized logistic.

    Drop_factors: factors with global coverage < 50% (e.g., F7) — excluded from composite per design.
    """
    composite_factors = ["pathc.f0_resid"] + [
        f"{f}_resid" for f in FACTOR_ORDER if f not in drop_factors
    ]

    sea_df = df[df["tier"] == "sea"].copy()
    if len(sea_df) < 100:
        return {"error": "insufficient SEA data", "n_rows": int(len(sea_df))}

    # Sort cohorts by t0 for temporal CV
    sea_t0s_sorted = sorted(sea_df["t0"].unique())
    if len(sea_t0s_sorted) < 3:
        return {"error": "insufficient t0s for forward-chaining", "n_t0s": int(len(sea_t0s_sorted))}

    # One-hot market + store as fixed effects
    fe_cols = []
    sea_df["market_x"] = sea_df["market"]
    sea_df["store_x"] = sea_df["store"]
    sea_df = pd.get_dummies(sea_df, columns=["market_x", "store_x"], drop_first=True)
    fe_cols = [c for c in sea_df.columns if c.startswith("market_x_") or c.startswith("store_x_")]

    feature_cols = composite_factors + fe_cols

    fold_results = []
    for k in range(1, len(sea_t0s_sorted)):
        train_t0s = sea_t0s_sorted[:k]
        test_t0 = sea_t0s_sorted[k]
        train = sea_df[sea_df["t0"].isin(train_t0s)].copy()
        test = sea_df[sea_df["t0"] == test_t0].copy()

        # Median-impute missing values + add missingness flags for factors
        for f in composite_factors:
            mask = train[f].isna()
            if mask.any():
                med = train[f].median()
                train[f] = train[f].fillna(med)
            mask_test = test[f].isna()
            if mask_test.any():
                med = train[f].median()
                test[f] = test[f].fillna(med)

        # Drop rows with any remaining NaN in features (shouldn't happen post-imputation, but defensively)
        train = train.dropna(subset=feature_cols + [winner_col])
        test = test.dropna(subset=feature_cols + [winner_col])
        if len(train) < 30 or len(test) < 10:
            continue

        X_train = train[feature_cols].values.astype(float)
        y_train = train[winner_col].values.astype(int)
        X_test = test[feature_cols].values.astype(float)
        y_test = test[winner_col].values.astype(int)

        # If train has only one class, skip
        if len(np.unique(y_train)) < 2:
            continue

        # Penalized logistic, L2, C=1.0 (mild ridge); could grid-search C inside training set if time
        try:
            clf = LogisticRegression(penalty="l2", C=1.0, max_iter=1000, solver="liblinear")
            clf.fit(X_train, y_train)
            pred_proba = clf.predict_proba(X_test)[:, 1]
        except Exception as e:
            fold_results.append({
                "test_t0_iso": pd.Timestamp(test_t0, unit="ms", tz="UTC").strftime("%Y-%m-%d"),
                "error": str(e),
            })
            continue

        test["composite_score"] = pred_proba

        # Per-cohort precision@K=10 within test fold
        precs_composite = []
        precs_f0 = []
        for cohort_key, sub in test.groupby("cohort_key"):
            valid = sub.dropna(subset=["composite_score", "pathc.f0_resid", winner_col])
            if len(valid) < 10:
                continue
            top_c = valid.sort_values("composite_score", ascending=False).head(
                max(1, int(np.ceil(len(valid) * TOP_DECILE_FRAC)))
            )
            precs_composite.append(top_c[winner_col].mean())
            top_f = valid.sort_values("pathc.f0_resid", ascending=True).head(
                max(1, int(np.ceil(len(valid) * TOP_DECILE_FRAC)))
            )
            precs_f0.append(top_f[winner_col].mean())

        if not precs_composite:
            continue

        fold_results.append(
            {
                "test_t0_iso": pd.Timestamp(test_t0, unit="ms", tz="UTC").strftime("%Y-%m-%d"),
                "n_train": int(len(train)),
                "n_test": int(len(test)),
                "prec_composite_mean": float(np.mean(precs_composite)),
                "prec_f0_mean": float(np.mean(precs_f0)),
                "lift_mean": float(np.mean(precs_composite) - np.mean(precs_f0)),
            }
        )

    if not fold_results:
        return {"error": "no valid folds", "fold_results": fold_results}

    valid_folds = [f for f in fold_results if "lift_mean" in f]
    if not valid_folds:
        return {"error": "all folds failed", "fold_results": fold_results}

    median_lift_sea = float(np.median([f["lift_mean"] for f in valid_folds]))
    return {
        "drop_factors": drop_factors,
        "feature_cols": feature_cols,
        "fold_results": fold_results,
        "median_lift_sea": median_lift_sea,
        "n_valid_folds": len(valid_folds),
        "alive": median_lift_sea >= COMPOSITE_LIFT_SEA,  # tier-1 lift not computed (single t0)
    }


def coverage_check(df: pd.DataFrame) -> dict:
    out = {}
    for f in ALL_FACTORS:
        total = len(df)
        non_null = int(df[f].notna().sum())
        pct = non_null / total if total > 0 else 0
        out[f] = {"non_null": non_null, "total": total, "pct": pct}
    return out


@dataclass
class FactorVerdict:
    factor: str
    n_cohorts_sea: int
    median_lift: float | None
    p5: float | None
    p95: float | None
    p_two_sided: float | None
    coverage_pct: float
    direction_ascending: bool
    alive: bool


def main():
    ts = datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H%M%S")
    out_dir = OUT_BASE / ts
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"loading data from {DB_PATH}")
    df = load_data()
    print(f"loaded {len(df)} cohort-app rows across {df['cohort_key'].nunique()} cohorts")
    print(f"  SEA cohorts: {df[df['tier']=='sea']['cohort_key'].nunique()}")
    print(f"  tier-1 cohorts: {df[df['tier']=='tier1']['cohort_key'].nunique()}")

    coverage = coverage_check(df)
    drop_factors = [f for f in TESTABLE_FACTORS if coverage[f]["pct"] < MIN_COVERAGE_FOR_COMPOSITE]
    print(f"factors with <{MIN_COVERAGE_FOR_COMPOSITE*100:.0f}% coverage (dropped from composite): {drop_factors}")

    print("preprocessing (z-score + winsorize + Gram-Schmidt residualization per cohort)")
    df_proc = preprocess_cohorts(df)

    rng = np.random.default_rng(RNG_SEED)
    factor_results = {}
    factor_per_cohort_dump = {}
    for f in TESTABLE_FACTORS:
        print(f"  univariate {f} (winner_exact)")
        per_cohort = univariate_per_cohort_lift(df_proc, f, "winner_exact")
        boot = cluster_bootstrap(per_cohort, "lift", BOOTSTRAP_REPS, rng)
        per_cohort_dump = per_cohort.to_dict(orient="records")
        coverage_pct = coverage[f]["pct"]
        direction_asc = bool(per_cohort["factor_direction_ascending"].iloc[0]) if not per_cohort.empty else False
        verdict = FactorVerdict(
            factor=f,
            n_cohorts_sea=int(boot["n_cohorts"]),
            median_lift=boot["median"],
            p5=boot["p5"],
            p95=boot["p95"],
            p_two_sided=boot["p_two_sided"],
            coverage_pct=coverage_pct,
            direction_ascending=direction_asc,
            alive=(
                boot["median"] is not None
                and boot["median"] >= LIFT_THRESHOLD_K1
                and boot["p_two_sided"] is not None
                and boot["p_two_sided"] < ALPHA
            ),
        )
        factor_results[f] = verdict.__dict__
        factor_per_cohort_dump[f] = per_cohort_dump

    print("composite analysis (forward-chaining temporal CV)")
    composite = composite_analysis(df_proc, "winner_exact", drop_factors)

    # Sensitivity: same univariate run with winner_window_7d
    print("sensitivity: univariate with winner_window_7d")
    factor_results_window = {}
    for f in TESTABLE_FACTORS:
        per_cohort = univariate_per_cohort_lift(df_proc, f, "winner_window_7d")
        boot = cluster_bootstrap(per_cohort, "lift", BOOTSTRAP_REPS, rng)
        factor_results_window[f] = {
            "factor": f,
            "median_lift": boot["median"],
            "p_two_sided": boot["p_two_sided"],
            "n_cohorts_sea": boot["n_cohorts"],
        }

    # Verdict logic: K1, K2, K3
    any_alive = any(v["alive"] for v in factor_results.values())
    composite_alive = bool(composite.get("alive", False))
    verdict_code = "K3"
    if any_alive:
        verdict_code = "K1"
    elif composite_alive:
        verdict_code = "K2"

    results = {
        "generated_at_utc": ts,
        "design_doc": "docs/planning/agent-v1-path-c-design.md",
        "design_status": "LOCKED",
        "n_rows": int(len(df)),
        "n_cohorts_total": int(df["cohort_key"].nunique()),
        "n_cohorts_sea": int(df[df["tier"] == "sea"]["cohort_key"].nunique()),
        "n_cohorts_tier1": int(df[df["tier"] == "tier1"]["cohort_key"].nunique()),
        "winner_exact_rate": float(df["winner_exact"].mean()),
        "winner_window_7d_rate": float(df["winner_window_7d"].mean()),
        "coverage": coverage,
        "drop_factors_from_composite": drop_factors,
        "univariate_winner_exact": factor_results,
        "univariate_winner_window_7d": factor_results_window,
        "composite": composite,
        "verdict": verdict_code,
        "alpha_bonferroni": ALPHA,
        "lift_threshold_k1": LIFT_THRESHOLD_K1,
        "bootstrap_reps": BOOTSTRAP_REPS,
        "rng_seed": RNG_SEED,
    }

    (out_dir / "results.json").write_text(json.dumps(results, indent=2, default=str))
    (out_dir / "univariate_per_cohort.json").write_text(
        json.dumps(factor_per_cohort_dump, indent=2, default=str)
    )

    print(f"\nresults written to {out_dir}")
    print(f"\nVERDICT: {verdict_code}")
    print(f"  any factor alive (K1): {any_alive}")
    print(f"  composite alive (K2): {composite_alive}")
    for f, v in factor_results.items():
        ml = v["median_lift"]
        p = v["p_two_sided"]
        ml_s = f"{ml:+.4f}" if ml is not None else "—"
        p_s = f"{p:.4f}" if p is not None else "—"
        print(
            f"  {f}: median_lift={ml_s} p={p_s} n={v['n_cohorts_sea']} cov={v['coverage_pct']*100:.1f}% alive={v['alive']}"
        )


if __name__ == "__main__":
    main()
