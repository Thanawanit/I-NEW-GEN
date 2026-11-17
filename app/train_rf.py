"""Data curation + training pipeline for the Random Forest fertilizer-deficit model.

Run (locally or on Google Colab):  python train_rf.py
Outputs (app/data/): agronomic_rf_dataset.csv, rf_fertilizer_model.joblib, rf_evaluation_report.json
"""

from __future__ import annotations

import json
import time
import urllib.request
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.compose import TransformedTargetRegressor
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import GroupKFold, GroupShuffleSplit
from sklearn.preprocessing import StandardScaler

from ml_model import FEATURE_NAMES, _compute_agronomic_nonlinear_targets
from database import SEED_CROP_PROFILES

DATA_DIR = Path(__file__).resolve().parent / "data"
RAW_CSV = DATA_DIR / "Crop_recommendation.csv"
DATASET_CSV = DATA_DIR / "agronomic_rf_dataset.csv"
MODEL_PATH = DATA_DIR / "rf_fertilizer_model.joblib"
REPORT_PATH = DATA_DIR / "rf_evaluation_report.json"

# The HSE mirror lacks N/P/K and coffee, so use the original Kaggle-derived table.
RAW_URL = "https://raw.githubusercontent.com/Gladiator07/Harvestify/master/Data-processed/crop_recommendation.csv"

# Mean canopy ExG per growth stage (1..3) matching expected_exg in ml_model.
STAGE_EXG_MEAN = {1: 35.0, 2: 60.0, 3: 55.0}
BULK_DENSITIES = [1.25, 1.35, 1.45]
# kg/ha (dataset) -> mg/kg: a 15 cm layer weighs ~2e6 kg/ha, so 1 mg/kg ~ 2 kg/ha.
KG_HA_PER_MG_KG = 2.0
TARGETS = ["deficit_n_g_m2", "deficit_p2o5_g_m2", "deficit_k2o_g_m2"]
N_ESTIMATORS, MAX_DEPTH, MIN_LEAF, SEED = 120, 12, 2, 42


def load_raw() -> pd.DataFrame:
    if not RAW_CSV.exists():
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(RAW_URL, RAW_CSV)
    return pd.read_csv(RAW_CSV)


def build_dataset(raw: pd.DataFrame) -> pd.DataFrame:
    rng = np.random.default_rng(SEED)
    records: list[dict] = []
    for pid, prof in enumerate(SEED_CROP_PROFILES, start=1):
        _, _, _, root_depth, t_n, t_p2o5, t_k2o, ph_min, ph_max, _ = prof
        # Every real soil state is paired with every profile: crop-specific rows cover only a narrow
        # N/P/K band, so the RF would be blind outside it when fertilizing a different soil.
        for src_idx, row in raw.iterrows():
            for bd in [float(rng.choice(BULK_DENSITIES))]:
                exg = float(np.clip(rng.normal(STAGE_EXG_MEAN[(pid - 1) % 3 + 1], 12.0), 5.0, 90.0))
                s_n = row["N"] / KG_HA_PER_MG_KG
                s_p = row["P"] / KG_HA_PER_MG_KG
                s_k = row["K"] / KG_HA_PER_MG_KG
                ph = float(np.clip(row["ph"], 4.0, 8.0))
                moist = float(np.clip(row["humidity"], 10.0, 95.0))
                dn, dp, dk = _compute_agronomic_nonlinear_targets(
                    pid, root_depth, t_n, t_p2o5, t_k2o, ph_min, ph_max, bd,
                    s_n, s_p, s_k, ph, moist, exg,
                )
                records.append({
                    "source_row_id": int(src_idx), "source_label": row["label"],
                    "crop_profile_id": pid, "root_depth_m": root_depth, "bulk_density_g_cm3": bd,
                    "soil_n_mg_kg": round(s_n, 3), "soil_p_mg_kg": round(s_p, 3),
                    "soil_k_mg_kg": round(s_k, 3), "ph_value": round(ph, 3),
                    "moisture_pct": round(moist, 3), "exg_green_pct": round(exg, 3),
                    "deficit_n_g_m2": round(dn, 5), "deficit_p2o5_g_m2": round(dp, 5),
                    "deficit_k2o_g_m2": round(dk, 5),
                })
    return pd.DataFrame(records)


def _metrics(y_true: np.ndarray, y_pred: np.ndarray) -> dict:
    out = {}
    for i, name in enumerate(["N", "P2O5", "K2O"]):
        out[name] = {
            "r2": float(r2_score(y_true[:, i], y_pred[:, i])),
            "rmse": float(np.sqrt(mean_squared_error(y_true[:, i], y_pred[:, i]))),
            "mae": float(mean_absolute_error(y_true[:, i], y_pred[:, i])),
        }
    out["overall"] = {
        "r2": float(r2_score(y_true, y_pred)),
        "rmse": float(np.sqrt(mean_squared_error(y_true, y_pred))),
        "mae": float(mean_absolute_error(y_true, y_pred)),
    }
    return out


def _new_rf() -> TransformedTargetRegressor:
    # Targets differ ~10x in scale; without standardising, the multi-output MSE criterion ignores P2O5.
    rf = RandomForestRegressor(n_estimators=N_ESTIMATORS, max_depth=MAX_DEPTH,
                               min_samples_leaf=MIN_LEAF, random_state=SEED, n_jobs=-1)
    return TransformedTargetRegressor(regressor=rf, transformer=StandardScaler())


def train_and_save() -> dict:
    started = time.time()
    df = build_dataset(load_raw())
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    df.to_csv(DATASET_CSV, index=False)

    x, y, groups = df[FEATURE_NAMES].to_numpy(), df[TARGETS].to_numpy(), df["source_row_id"].to_numpy()
    # Group by source row so the 3 bulk-density copies of one open-data row never straddle train/test.
    tr, te = next(GroupShuffleSplit(n_splits=1, test_size=0.20, random_state=SEED).split(x, y, groups))
    rf = _new_rf().fit(x[tr], y[tr])
    holdout = _metrics(y[te], rf.predict(x[te]))

    folds = []
    for f_tr, f_te in GroupKFold(n_splits=5).split(x, y, groups):
        folds.append(_metrics(y[f_te], _new_rf().fit(x[f_tr], y[f_tr]).predict(x[f_te])))
    cv = {}
    for key in ["N", "P2O5", "K2O", "overall"]:
        cv[key] = {m: {"mean": float(np.mean([f[key][m] for f in folds])),
                       "std": float(np.std([f[key][m] for f in folds]))} for m in ["r2", "rmse", "mae"]}

    imp = {n: round(float(v) * 100.0, 2) for n, v in zip(FEATURE_NAMES, rf.regressor_.feature_importances_)}
    report = {
        "model": "RandomForestRegressor (scikit-learn)",
        "hyperparameters": {"n_estimators": N_ESTIMATORS, "max_depth": MAX_DEPTH,
                            "min_samples_leaf": MIN_LEAF, "random_state": SEED},
        "dataset": {"source_url": RAW_URL, "open_rows_used": int(df["source_row_id"].nunique()),
                    "total_samples": int(len(df)), "train_samples": int(len(tr)),
                    "test_samples": int(len(te)),
                    "pairing_note": "All 2,200 real soil states are paired with each of the 9 crop profiles; one random bulk density per pair.",
                    "targets_note": "Targets are computed by the agronomic non-linear formula, not field measurements."},
        "holdout_80_20": holdout,
        "cross_validation_5fold": cv,
        "feature_importance_pct": imp,
        "training_seconds": round(time.time() - started, 1),
    }
    REPORT_PATH.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    joblib.dump({"model": rf, "report": report}, MODEL_PATH)
    return report


if __name__ == "__main__":
    rep = train_and_save()
    print(json.dumps({k: rep[k] for k in ["holdout_80_20", "feature_importance_pct", "training_seconds"]}, indent=2))
