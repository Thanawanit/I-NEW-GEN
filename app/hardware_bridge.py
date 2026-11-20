"""Hardware bridge integrating Raspberry Pi GPIO pumps & Arduino RS485 soil parser from Back/."""

from __future__ import annotations

import atexit
import json
import re
import threading
import time
from typing import Any, Callable

try:
    from gpiozero import OutputDevice  # type: ignore
    GPIO_AVAILABLE = True
except ImportError:
    GPIO_AVAILABLE = False

    class OutputDevice:  # type: ignore[no-redef]
        """Safe software mock when running outside Raspberry Pi."""

        def __init__(self, pin: int, **kwargs: Any) -> None:
            self.pin = pin
            self.state = False

        def on(self) -> None:
            self.state = True

        def off(self) -> None:
            self.state = False


# Inherited GPIO pin mapping from Back/hardware/fertilizer_controller.py (Active-LOW)
PUMP_GPIO_PINS: dict[str, int] = {
    "n": 17,
    "p": 27,
    "k": 22,
    "water": 23,
}

MAX_PUMP_DURATION_S = 120.0

_pump_lock = threading.Lock()
_pumps: dict[str, OutputDevice] = {}
_stop_requested = False
_dispense_state: dict[str, Any] = {
    "is_running": False,
    "active_job_id": None,
    "current_step": "",
    "last_error": None,
    "gpio_available": GPIO_AVAILABLE,
}


def init_pumps() -> dict[str, OutputDevice]:
    """Lazily initialize the 4 Active-LOW relay pins on Raspberry Pi GPIO 17, 27, 22, 23."""
    with _pump_lock:
        if not _pumps:
            for key, pin in PUMP_GPIO_PINS.items():
                _pumps[key] = OutputDevice(pin, active_high=False, initial_value=False)
        return _pumps


def force_stop_all_pumps() -> None:
    """Emergency stop all 4 pumps immediately."""
    global _stop_requested
    _stop_requested = True
    _dispense_state["is_running"] = False
    _dispense_state["current_step"] = "stopped"
    for dev in _pumps.values():
        try:
            dev.off()
        except Exception:
            pass


atexit.register(force_stop_all_pumps)


def get_pump_hardware_status() -> dict[str, Any]:
    """Return thread-safe snapshot of Raspberry Pi GPIO dispensing state."""
    return dict(_dispense_state)


def _wait_precise(deadline: float) -> bool:
    """Wait until deadline using perf_counter with early abort check. Returns False if aborted."""
    while True:
        if _stop_requested:
            return False
        remaining = deadline - time.perf_counter()
        if remaining <= 0:
            return True
        if remaining > 0.03:
            time.sleep(min(0.02, remaining - 0.02))
        elif remaining > 0.002:
            time.sleep(remaining - 0.002)
        else:
            while time.perf_counter() < deadline:
                if _stop_requested:
                    return False
            return True


def _run_single_pump(dev: OutputDevice, label: str, duration_s: float) -> float:
    """Energize a single relay safely and return actual elapsed seconds."""
    if duration_s <= 0 or _stop_requested:
        return 0.0
    safe_dur = min(float(duration_s), MAX_PUMP_DURATION_S)
    for other in _pumps.values():
        other.off()
    time.sleep(0.1)

    start_ts = time.perf_counter()
    try:
        _dispense_state["current_step"] = label
        dev.on()
        start_ts = time.perf_counter()
        _wait_precise(start_ts + safe_dur)
    finally:
        dev.off()
        time.sleep(0.2)
    return time.perf_counter() - start_ts


def start_sequential_dispense(
    job_id: int,
    durations_s: dict[str, float],
    on_complete: Callable[[int, str], None] | None = None,
    sync_for_test: bool = False,
) -> bool:
    """Run N -> P -> K -> Water sequentially on Raspberry Pi GPIO 17, 27, 22, 23."""
    global _stop_requested
    if _dispense_state["is_running"]:
        return False

    init_pumps()
    _stop_requested = False
    _dispense_state["is_running"] = True
    _dispense_state["active_job_id"] = job_id
    _dispense_state["last_error"] = None

    def _worker() -> None:
        final_status = "mixing"
        try:
            sequence = [
                ("n", "Nitrogen (N) [GPIO 17]"),
                ("p", "Phosphorus (P) [GPIO 27]"),
                ("k", "Potassium (K) [GPIO 22]"),
                ("water", "Water [GPIO 23]"),
            ]
            for key, label in sequence:
                dur = float(durations_s.get(key, 0.0) or 0.0)
                if dur > 0 and not _stop_requested:
                    _run_single_pump(_pumps[key], label, dur)
                    if not _stop_requested:
                        time.sleep(0.2)
            if _stop_requested:
                final_status = "stopped"
        except Exception as exc:
            _dispense_state["last_error"] = str(exc)
            final_status = "stopped"
        finally:
            for dev in _pumps.values():
                try:
                    dev.off()
                except Exception:
                    pass
            _dispense_state["is_running"] = False
            _dispense_state["current_step"] = "idle" if not _stop_requested else "stopped"
            if on_complete is not None:
                on_complete(job_id, final_status)

    if sync_for_test:
        _worker()
    else:
        threading.Thread(target=_worker, daemon=True).start()
    return True


def parse_soil_packet(raw_text: str) -> dict[str, float]:
    """Parse Arduino RS485 / LoRa soil packets ('pH:6.5,N:20,P:15,K:30', JSON, or CSV)."""
    if not raw_text or not isinstance(raw_text, str):
        return {}
    text = raw_text.replace("\x00", "").replace("\r", "").replace("\n", "").strip()
    if not text:
        return {}

    parsed: dict[str, float] = {}
    if text.startswith("{") and text.endswith("}"):
        try:
            obj = json.loads(text)
            if isinstance(obj, dict):
                lower = {str(k).strip().lower(): v for k, v in obj.items()}
                aliases = {
                    "ph": ("ph",),
                    "n": ("n", "nitrogen"),
                    "p": ("p", "phosphorus"),
                    "k": ("k", "potassium"),
                    "moisture_pct": ("moisture", "moisture_pct"),
                    "ec_us_cm": ("ec", "ec_us_cm"),
                }
                for target_k, keys in aliases.items():
                    for alias in keys:
                        if alias in lower and lower[alias] is not None:
                            parsed[target_k] = float(lower[alias])
                            break
        except (ValueError, TypeError):
            parsed = {}

    if not parsed:
        patterns = {
            "ph": r'(?:["\']?\bph\b["\']?)\s*[:=]\s*(-?\d+(?:\.\d+)?)',
            "n": r'(?:["\']?\b(?:n|nitrogen)\b["\']?)\s*[:=]\s*(-?\d+(?:\.\d+)?)',
            "p": r'(?:["\']?\b(?:p|phosphorus)\b["\']?)\s*[:=]\s*(-?\d+(?:\.\d+)?)',
            "k": r'(?:["\']?\b(?:k|potassium)\b["\']?)\s*[:=]\s*(-?\d+(?:\.\d+)?)',
            "moisture_pct": r'(?:["\']?\b(?:moisture|moist)\b["\']?)\s*[:=]\s*(-?\d+(?:\.\d+)?)',
        }
        for key, pat in patterns.items():
            m = re.search(pat, text, re.IGNORECASE)
            if m:
                parsed[key] = float(m.group(1))

    if not parsed and re.fullmatch(r"\s*-?\d+(?:\.\d+)?(?:\s*[,;\s]\s*-?\d+(?:\.\d+)?){3,}\s*", text):
        nums = re.findall(r"-?\d+(?:\.\d+)?", text)
        if len(nums) >= 4:
            parsed = {"ph": float(nums[0]), "n": float(nums[1]), "p": float(nums[2]), "k": float(nums[3])}

    # Sanitize physical bounds
    sanitized: dict[str, float] = {}
    if "ph" in parsed and 0.0 <= parsed["ph"] <= 14.0:
        sanitized["ph"] = round(parsed["ph"], 2)
    for k in ("n", "p", "k"):
        if k in parsed and 0.0 <= parsed[k] <= 2000.0:
            sanitized[k] = round(parsed[k], 1)
    if "moisture_pct" in parsed and 0.0 <= parsed["moisture_pct"] <= 100.0:
        sanitized["moisture_pct"] = round(parsed["moisture_pct"], 1)
    if "ec_us_cm" in parsed and 0.0 <= parsed["ec_us_cm"] <= 20000.0:
        sanitized["ec_us_cm"] = round(parsed["ec_us_cm"], 1)
    return sanitized
