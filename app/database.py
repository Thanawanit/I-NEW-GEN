"""SQLite database initialization, migrations, and DOA/ARDA-aligned crop seed data."""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from config import DB_PATH

SEED_CROP_PROFILES: list[tuple[Any, ...]] = [
    # Targets are kg/rai x 0.625 -> g/m^2 (1 rai = 1,600 m^2). Sources and gaps: Info/03_*.md section 7.
    # ข้าว ไวต่อช่วงแสง ปักดำ (กรมการข้าว RKB & คู่มือการใส่ปุ๋ยตามค่าวิเคราะห์ดิน):
    # - 16-20-0 @ 22.5 kg/rai ปักดำ -> N 3.6 / P2O5 4.5 kg/rai (2.25 / 2.81 g/m^2)
    # - ยูเรีย 10 kg/rai ระยะกำเนิดช่อดอก -> N 4.6 kg/rai (2.88 g/m^2); ข้าวไวแสงไม่ใส่ช่วงแตกกอ
    # - Effective Root Zone 0.25 m (กรมการข้าว/กรมชลประทาน); Optimum pH 5.5-6.5 (คู่มือใส่ปุ๋ยตามค่าวิเคราะห์ดิน หน้า 2)
    ("ข้าว", "ไวต่อช่วงแสง (ปักดำ)", "1. ระยะปักดำ/ตั้งตัว (0–20 วัน)", 0.25, 2.25, 2.81, 0.00, 5.5, 6.5, 1000.0),
    ("ข้าว", "ไวต่อช่วงแสง (ปักดำ)", "2. ระยะแตกกอ (21–45 วัน)", 0.25, 0.00, 0.00, 0.00, 5.5, 6.5, 1000.0),
    ("ข้าว", "ไวต่อช่วงแสง (ปักดำ)", "3. ระยะกำเนิดช่อดอก (46+ วัน)", 0.25, 2.88, 0.00, 0.00, 5.5, 6.5, 1000.0),
    # ถั่วลิสง / ถั่วลายเสือ (กรมวิชาการเกษตร E-Book-8 พันธุ์กาฬสินธุ์ 2 หน้า 12 & คู่มือ GI ถั่วลายเสือแม่ฮ่องสอน หน้า 14):
    # - Default/Baseline: 12-24-12 @ 25 kg/rai -> N 3.0 / P2O5 6.0 / K2O 3.0 kg/rai (รวม 1.88 / 3.75 / 1.88 g/m^2)
    #   แบ่งครึ่งใส่ 2 ระยะแรก -> ระยะละ 0.94 / 1.88 / 0.94 g/m^2 (Conditional Rule: หาก P, K ต่ำมาก ใช้ LDD 3-9-6)
    # - ระยะที่ 3 (R2 แทงเข็มลงดิน 30-35 วัน): ใส่ยิปซัม 50-100 kg/rai เสริม Ca (N-P2O5-K2O = 0)
    # - เขตรากหาอาหารหลัก + Pod Zone 0.30 m; ช่วง pH 5.5-6.8
    ("ถั่วลิสง", "ทั่วไป", "1. ระยะต้นกล้า (0–20 วัน)", 0.30, 0.94, 1.88, 0.94, 5.5, 6.8, 700.0),
    ("ถั่วลิสง", "ทั่วไป", "2. ระยะเจริญเติบโต/ออกดอก (21–45 วัน)", 0.30, 0.94, 1.88, 0.94, 5.5, 6.8, 900.0),
    ("ถั่วลิสง", "ทั่วไป", "3. ระยะลงเข็ม–ติดฝัก R2 (46+ วัน)", 0.30, 0.00, 0.00, 0.00, 5.5, 6.8, 900.0),
    # ถั่วลายเสือ = ถั่วลิสงพันธุ์ กวก. กาฬสินธุ์ 2 (KAC 431, GI สช 64100153 แม่ฮ่องสอน)
    ("ถั่วลายเสือ", "กาฬสินธุ์ 2 (GI แม่ฮ่องสอน)", "1. ระยะต้นกล้า (0–20 วัน)", 0.30, 0.94, 1.88, 0.94, 5.5, 6.8, 700.0),
    ("ถั่วลายเสือ", "กาฬสินธุ์ 2 (GI แม่ฮ่องสอน)", "2. ระยะเจริญเติบโต/ออกดอก (21–45 วัน)", 0.30, 0.94, 1.88, 0.94, 5.5, 6.8, 900.0),
    ("ถั่วลายเสือ", "กาฬสินธุ์ 2 (GI แม่ฮ่องสอน)", "3. ระยะลงเข็ม–ติดฝัก R2 (46+ วัน)", 0.30, 0.00, 0.00, 0.00, 5.5, 6.8, 900.0),
    # ถั่วเหลือง (LDD กลุ่มชุดดินที่ 49): 3-9-6 kg/rai แบ่ง 2 ครั้ง -> 0.94 / 2.81 / 1.88 g/m^2. เขตรากหาอาหารหลัก 0.30 m, pH 5.5-6.5.
    ("ถั่วเหลือง", "ทั่วไป", "1. ระยะต้นกล้า (0–20 วัน)", 0.30, 0.94, 2.81, 1.88, 5.5, 6.5, 700.0),
    ("ถั่วเหลือง", "ทั่วไป", "2. ระยะเจริญเติบโต/ออกดอก (21–45 วัน)", 0.30, 0.94, 2.81, 1.88, 5.5, 6.5, 900.0),
    ("ถั่วเหลือง", "ทั่วไป", "3. ระยะติดฝัก–เมล็ด (46+ วัน)", 0.30, 0.00, 0.00, 0.00, 5.5, 6.5, 900.0),
]


@contextmanager
def get_connection(db_path: Path = DB_PATH) -> Iterator[sqlite3.Connection]:
    """Open a SQLite connection with dictionary-like Row access and auto-close."""
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    """Safely add a column to an existing table if upgrading from an older DB file."""
    cols = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def init_db(db_path: Path = DB_PATH) -> None:
    """Create schema tables if missing, migrate mode columns, and seed crop profiles."""
    with get_connection(db_path) as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS crop_profiles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                crop_name TEXT NOT NULL,
                variety TEXT NOT NULL,
                growth_stage TEXT NOT NULL,
                root_depth_m REAL NOT NULL,
                target_n_g_m2 REAL NOT NULL,
                target_p2o5_g_m2 REAL NOT NULL,
                target_k2o_g_m2 REAL NOT NULL,
                ph_min REAL NOT NULL,
                ph_max REAL NOT NULL,
                safe_ec_max_ppm REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS plots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                plot_name TEXT NOT NULL,
                polygon_geojson TEXT NOT NULL,
                calculated_area_m2 REAL NOT NULL,
                confirmed_area_m2 REAL NOT NULL,
                soil_type TEXT NOT NULL,
                bulk_density_g_cm3 REAL NOT NULL,
                crop_profile_id INTEGER NOT NULL,
                mode TEXT NOT NULL DEFAULT 'live',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (crop_profile_id) REFERENCES crop_profiles(id)
            );

            CREATE TABLE IF NOT EXISTS soil_readings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                plot_id INTEGER NOT NULL,
                nitrogen_mg_kg REAL,
                phosphorus_mg_kg REAL,
                potassium_mg_kg REAL,
                ph_value REAL,
                moisture_pct REAL,
                ec_us_cm REAL,
                source TEXT NOT NULL,
                mode TEXT NOT NULL DEFAULT 'live',
                recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS fermenter_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                temp_n_c REAL,
                temp_p_c REAL,
                temp_k_c REAL,
                temp_mixer_c REAL,
                mixer_tds_ppm REAL,
                is_ready INTEGER DEFAULT 0,
                source TEXT NOT NULL DEFAULT 'esp32_live',
                mode TEXT NOT NULL DEFAULT 'live',
                recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS mixing_jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                plot_id INTEGER NOT NULL,
                delta_n_g REAL NOT NULL,
                delta_p_g REAL NOT NULL,
                delta_k_g REAL NOT NULL,
                vol_n_ml REAL NOT NULL,
                vol_p_ml REAL NOT NULL,
                vol_k_ml REAL NOT NULL,
                vol_water_ml REAL NOT NULL,
                pump_n_sec REAL NOT NULL,
                pump_p_sec REAL NOT NULL,
                pump_k_sec REAL NOT NULL,
                pump_water_sec REAL NOT NULL,
                final_tds_ppm REAL,
                status TEXT NOT NULL,
                mode TEXT NOT NULL DEFAULT 'live',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            """
        )

        # Ensure strict mode isolation columns exist even on pre-existing DB files
        for table_name in ("plots", "soil_readings", "fermenter_logs", "mixing_jobs"):
            _ensure_column(conn, table_name, "mode", "TEXT NOT NULL DEFAULT 'live'")
        _ensure_column(conn, "fermenter_logs", "temp_mixer_c", "REAL")

        # Upsert by id so an existing DB file picks up the current crop table without breaking plot FKs.
        conn.executemany(
            """
            INSERT OR REPLACE INTO crop_profiles (
                id, crop_name, variety, growth_stage, root_depth_m,
                target_n_g_m2, target_p2o5_g_m2, target_k2o_g_m2,
                ph_min, ph_max, safe_ec_max_ppm
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [(idx, *prof) for idx, prof in enumerate(SEED_CROP_PROFILES, start=1)],
        )
        conn.commit()
