"""Central configuration and teammate calibration constants."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

APP_DIR = Path(__file__).resolve().parent
OVERRIDE_PATH = APP_DIR / "calibration_overrides.json"
DB_PATH = APP_DIR / "smart_biofert.db"
UPLOAD_DIR = APP_DIR / "static" / "uploads"


@dataclass
class AppConfig:
    """Holds hardware calibration constants and demo scaling parameters."""

    # Calibrated pump flow rates (ml/s) inherited from Back/data/system_state.json (GPIO 17, 27, 22, 23)
    q_pump_n: float = 3.03
    q_pump_p: float = 2.00
    q_pump_k: float = 6.40
    q_pump_water: float = 22.08

    # Bio-liquid nutrient concentrations (mg/ml) - equal placeholder (2.0) until Teammate #4 measures real values
    c_bio_n: float = 2.0
    c_bio_p2o5: float = 2.0
    c_bio_k2o: float = 2.0

    # Tabletop drone flight boundaries (cm) - 60x80 cm tray minus 10 cm safety margin per side
    table_width_cm: float = 40.0
    table_height_cm: float = 60.0
    min_move_cm: float = 20.0

    # Mixing batch & safety thresholds (aligned with Back/ 1,000 ml mixing batch & 2,000 ml tank limit)
    demo_batch_ml: float = 1000.0
    demo_bio_ml: float = 400.0
    mixing_tank_max_ml: float = 2000.0
    min_pump_runtime_s: float = 0.5
    water_tds_ppm: float = 150.0
    exg_green_threshold: int = 20
    fermenter_temp_min_c: float = 25.0
    fermenter_temp_max_c: float = 40.0

    # Seasonal soil nutrient availability factors (fraction of soil reserve available in 1 stage)
    n_avail_factor: float = 0.30
    p_avail_factor: float = 0.20
    k_avail_factor: float = 0.15

    # Untouched Pi 5 remote base URL (e.g. "http://192.168.1.50:10000"); empty = local GPIO mode
    pi5_base_url: str = ""

    # Reference soil bulk densities (g/cm^3)
    bulk_density_map: dict[str, float] = field(
        default_factory=lambda: {
            "sandy_loam": 1.45,
            "loam": 1.35,
            "clay_loam": 1.25,
        }
    )

    # LDD Soil Test Kit qualitative level -> baseline mg/kg mapping (supports both 3-level and 5-level LDD scales)
    ldd_level_to_mg_kg: dict[str, dict[str, float]] = field(
        default_factory=lambda: {
            "n": {"very_low": 2.5, "low": 5.0, "medium": 15.0, "high": 30.0, "very_high": 45.0},
            "p": {"very_low": 2.0, "low": 5.0, "medium": 15.0, "high": 30.0, "very_high": 50.0},
            "k": {"very_low": 20.0, "low": 30.0, "medium": 60.0, "high": 100.0, "very_high": 130.0},
        }
    )


def normalize_pi5_base_url(raw: str) -> str:
    """Normalize a Raspberry Pi 5 host/URL to 'http://<host>:<port>' (default port 10000)."""
    text = str(raw or "").strip().rstrip("/")
    if not text:
        return ""
    if not text.startswith(("http://", "https://")):
        text = f"http://{text}"
    scheme, rest = text.split("://", 1)
    if ":" not in rest and "/" not in rest:
        rest = f"{rest}:10000"
    return f"{scheme}://{rest}"


def get_config(override_path: Path = OVERRIDE_PATH) -> AppConfig:
    """Load default config merged with any persisted JSON overrides."""
    cfg = AppConfig()
    if override_path.exists():
        raw = json.loads(override_path.read_text(encoding="utf-8"))
        for key, value in raw.items():
            if not hasattr(cfg, key):
                continue
            if key == "pi5_base_url" and isinstance(value, str):
                cfg.pi5_base_url = normalize_pi5_base_url(value)
            elif isinstance(value, (int, float)):
                setattr(cfg, key, float(value))
    return cfg


def update_config(
    updates: dict[str, Any], override_path: Path = OVERRIDE_PATH
) -> AppConfig:
    """Validate and persist numeric calibration overrides and Pi 5 URL."""
    editable_fields = {
        "q_pump_n",
        "q_pump_p",
        "q_pump_k",
        "q_pump_water",
        "c_bio_n",
        "c_bio_p2o5",
        "c_bio_k2o",
        "table_width_cm",
        "table_height_cm",
        "min_move_cm",
    }
    cfg = get_config(override_path)
    persisted: dict[str, Any] = {}
    if override_path.exists():
        persisted = json.loads(override_path.read_text(encoding="utf-8"))

    for key, value in updates.items():
        if value is None:
            continue
        if key == "pi5_base_url":
            normalized = normalize_pi5_base_url(str(value))
            cfg.pi5_base_url = normalized
            persisted["pi5_base_url"] = normalized
            continue
        if key not in editable_fields:
            continue
        num = float(value)
        if num <= 0:
            raise ValueError(f"Calibration value '{key}' must be greater than 0.")
        setattr(cfg, key, num)
        persisted[key] = num

    override_path.write_text(json.dumps(persisted, indent=2), encoding="utf-8")
    return cfg


def config_to_dict(cfg: AppConfig) -> dict[str, Any]:
    """Serialize AppConfig to a JSON-friendly dictionary."""
    return asdict(cfg)
