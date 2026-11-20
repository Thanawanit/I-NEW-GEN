"""Hardware bridge integrating Pi 5 GPIO pumps, LoRa RA-02 receiver & USB/RS485 soil parser."""

from __future__ import annotations

import atexit
import glob
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Callable

try:
    from gpiozero import DigitalInputDevice, DigitalOutputDevice, OutputDevice  # type: ignore
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

    class DigitalOutputDevice(OutputDevice):  # type: ignore[no-redef]
        pass

    class DigitalInputDevice:  # type: ignore[no-redef]
        def __init__(self, pin: int, **kwargs: Any) -> None:
            self.pin = pin

        @property
        def value(self) -> int:
            return 0


try:
    import spidev  # type: ignore
    SPIDEV_AVAILABLE = True
except ImportError:
    spidev = None
    SPIDEV_AVAILABLE = False

try:
    import serial  # type: ignore
    import serial.tools.list_ports  # type: ignore
    SERIAL_AVAILABLE = True
except ImportError:
    serial = None
    SERIAL_AVAILABLE = False


# Inherited GPIO pin mapping from Back/hardware/fertilizer_controller.py (Active-LOW)
PUMP_GPIO_PINS: dict[str, int] = {
    "n": 17,
    "p": 27,
    "k": 22,
    "water": 23,
}

# Inherited LoRa RA-02 (SX1278, 433 MHz) SPI0 wiring from Back/pi_lora_receiver.py
LORA_RST_PIN = 25
LORA_DIO0_PIN = 24
LORA_SPI_BUS = 0
LORA_SPI_DEVICE = 0
LORA_FREQ_HZ = 433_000_000

_REG_FIFO = 0x00
_REG_OP_MODE = 0x01
_REG_FRF_MSB = 0x06
_REG_FRF_MID = 0x07
_REG_FRF_LSB = 0x08
_REG_FIFO_ADDR_PTR = 0x0D
_REG_FIFO_TX_BASE_ADDR = 0x0E
_REG_FIFO_RX_BASE_ADDR = 0x0F
_REG_FIFO_RX_CURRENT_ADDR = 0x10
_REG_IRQ_FLAGS = 0x12
_REG_RX_NB_BYTES = 0x13
_REG_MODEM_CONFIG_1 = 0x1D
_REG_MODEM_CONFIG_2 = 0x1E
_REG_PREAMBLE_MSB = 0x20
_REG_PREAMBLE_LSB = 0x21
_REG_MODEM_CONFIG_3 = 0x26
_REG_INVERT_IQ = 0x33
_REG_SYNC_WORD = 0x39
_REG_INVERT_IQ2 = 0x3B
_REG_DIO_MAPPING_1 = 0x40
_MODE_LONG_RANGE = 0x80
_MODE_SLEEP = 0x00
_MODE_STDBY = 0x01
_MODE_RX_CONTINUOUS = 0x05
_IRQ_RX_DONE_MASK = 0x40
_IRQ_CRC_ERROR_MASK = 0x20

MAX_PUMP_DURATION_S = 360.0

_pump_lock = threading.Lock()
_pumps: dict[str, OutputDevice] = {}
_stop_requested = False
_dispense_state: dict[str, Any] = {
    "is_running": False,
    "active_job_id": None,
    "current_step": "",
    "active_channel": None,
    "completed_ml": 0.0,
    "channel_target_ml": 0.0,
    "channel_target_s": 0.0,
    "channel_started_at": None,
    "target_total_ml": 0.0,
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
    """Return thread-safe snapshot of Raspberry Pi GPIO dispensing state with live ml/pct."""
    snap = dict(_dispense_state)
    target_total = float(snap.get("target_total_ml") or 0.0)
    completed = float(snap.get("completed_ml") or 0.0)
    ch_started = snap.get("channel_started_at")
    ch_dur = float(snap.get("channel_target_s") or 0.0)
    ch_ml = float(snap.get("channel_target_ml") or 0.0)
    in_flight_ml = 0.0
    if snap.get("is_running") and ch_started is not None and ch_dur > 0 and ch_ml > 0:
        frac = min(1.0, max(0.0, (time.perf_counter() - float(ch_started)) / ch_dur))
        in_flight_ml = ch_ml * frac
    dispensed = completed + in_flight_ml
    if target_total > 0:
        dispensed = min(target_total, dispensed)
        pct = min(100.0, (dispensed / target_total) * 100.0)
    else:
        pct = 0.0
    snap["dispensed_ml"] = round(dispensed, 1)
    snap["target_total_ml"] = round(target_total, 1)
    snap["progress_pct"] = round(pct, 1)
    snap.pop("channel_started_at", None)
    return snap


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


def _http_json(
    url: str,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
    timeout_s: float = 5.0,
) -> dict[str, Any]:
    """Perform a minimal JSON HTTP call against an untouched Pi 5 server."""
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Content-Type": "application/json"} if body is not None else {}
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        return dict(json.loads(resp.read().decode("utf-8")))


def fetch_remote_pi5_soil(pi5_base_url: str) -> dict[str, Any]:
    """Fetch live LoRa/USB soil reading and 15-point table from an untouched Pi 5 (:10000)."""
    base = str(pi5_base_url or "").strip().rstrip("/")
    if not base:
        raise ValueError("ยังไม่ได้ตั้งค่า URL ของ Raspberry Pi 5")

    soil_data = _http_json(f"{base}/api/soil", method="GET", timeout_s=3.5)
    points_data: dict[str, Any] = {}
    try:
        points_data = _http_json(f"{base}/api/points", method="GET", timeout_s=3.5)
    except Exception:
        points_data = {}

    return {
        "soil": {
            "ph": float(soil_data["pH"]) if soil_data.get("pH") is not None else None,
            "n": float(soil_data["N"]) if soil_data.get("N") is not None else None,
            "p": float(soil_data["P"]) if soil_data.get("P") is not None else None,
            "k": float(soil_data["K"]) if soil_data.get("K") is not None else None,
        },
        "source": str(soil_data.get("source") or "pi5_remote"),
        "lora_connected": bool(soil_data.get("lora_connected")),
        "lora_rssi": soil_data.get("lora_rssi"),
        "packet_count": int(soil_data.get("packet_count") or 0),
        "recorded_points": points_data.get("recorded_points") or [],
    }


def start_sequential_dispense(
    job_id: int,
    durations_s: dict[str, float],
    on_complete: Callable[[int, str], None] | None = None,
    sync_for_test: bool = False,
    pi5_base_url: str = "",
    volumes_ml: dict[str, float] | None = None,
) -> bool:
    """Run N -> P -> K -> Water sequentially on local Pi GPIO or remote untouched Pi 5 (:10000)."""
    global _stop_requested
    if _dispense_state["is_running"]:
        return False

    remote_base = str(pi5_base_url or "").strip().rstrip("/")
    if not remote_base:
        init_pumps()

    vols = volumes_ml or {}
    total_target_ml = sum(float(vols.get(k, 0.0) or 0.0) for k in ("n", "p", "k", "water"))
    _stop_requested = False
    _dispense_state["is_running"] = True
    _dispense_state["active_job_id"] = job_id
    _dispense_state["active_channel"] = None
    _dispense_state["completed_ml"] = 0.0
    _dispense_state["channel_target_ml"] = 0.0
    _dispense_state["channel_target_s"] = 0.0
    _dispense_state["channel_started_at"] = None
    _dispense_state["target_total_ml"] = total_target_ml
    _dispense_state["last_error"] = None

    def _worker() -> None:
        final_status = "mixing"
        try:
            sequence = [
                ("n", "N", "กำลังจ่ายปุ๋ย N (ไนโตรเจน)"),
                ("p", "P", "กำลังจ่ายปุ๋ย P (ฟอสฟอรัส)"),
                ("k", "K", "กำลังจ่ายปุ๋ย K (โพแทสเซียม)"),
                ("water", "W", "กำลังจ่ายน้ำเปล่าเจือจาง"),
            ]
            for key, remote_key, label in sequence:
                dur = float(durations_s.get(key, 0.0) or 0.0)
                if dur <= 0 or _stop_requested:
                    continue
                ch_vol = float(vols.get(key, 0.0) or 0.0)
                _dispense_state["active_channel"] = key
                _dispense_state["channel_target_ml"] = ch_vol
                _dispense_state["channel_target_s"] = dur
                _dispense_state["channel_started_at"] = time.perf_counter()

                if remote_base:
                    _dispense_state["current_step"] = f"{label} (Pi 5)"
                    safe_dur = round(min(dur, 120.0), 3)
                    _http_json(
                        f"{remote_base}/api/pump_test",
                        method="POST",
                        payload={"pump": remote_key, "duration_s": safe_dur},
                        timeout_s=safe_dur + 10.0,
                    )
                else:
                    _run_single_pump(_pumps[key], label, dur)

                if not _stop_requested:
                    _dispense_state["completed_ml"] = float(_dispense_state["completed_ml"]) + ch_vol
                    _dispense_state["channel_started_at"] = None
                    _dispense_state["channel_target_ml"] = 0.0
                    time.sleep(0.2)
            if _stop_requested:
                final_status = "stopped"
        except Exception as exc:
            _dispense_state["last_error"] = str(exc)
            final_status = "stopped"
        finally:
            if not remote_base:
                for dev in _pumps.values():
                    try:
                        dev.off()
                    except Exception:
                        pass
            _dispense_state["is_running"] = False
            _dispense_state["active_channel"] = None
            _dispense_state["channel_started_at"] = None
            _dispense_state["channel_target_ml"] = 0.0
            _dispense_state["current_step"] = "จ่ายครบถ้วนแล้ว" if not _stop_requested else "หยุดฉุกเฉินแล้ว"
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
            "ec_us_cm": r'(?:["\']?\b(?:ec|ec_us_cm|cond)\b["\']?)\s*[:=]\s*(-?\d+(?:\.\d+)?)',
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


class RA02:
    """SX1278 433 MHz LoRa transceiver on Raspberry Pi SPI0 (RST=GPIO25, DIO0=GPIO24)."""

    def __init__(
        self,
        bus: int = LORA_SPI_BUS,
        device: int = LORA_SPI_DEVICE,
        rst_pin: int = LORA_RST_PIN,
        dio0_pin: int = LORA_DIO0_PIN,
    ) -> None:
        if spidev is None:
            raise RuntimeError("spidev library is not available")

        self.spi: Any = None
        self.rst: DigitalOutputDevice | None = None
        self.dio0: DigitalInputDevice | None = None
        try:
            self.spi = spidev.SpiDev()
            self.spi.open(bus, device)
            self.spi.max_speed_hz = 500_000
            self.spi.mode = 0b00
            self.spi.no_cs = False

            self.rst = DigitalOutputDevice(rst_pin, active_high=True, initial_value=True)
            self.dio0 = DigitalInputDevice(dio0_pin, pull_up=False)

            self._reset()
            self._init_registers(LORA_FREQ_HZ)
            version = self._read_reg(0x42)
            if version != 0x12:
                raise RuntimeError(f"SX1278 RegVersion mismatch: 0x{version:02X} (expected 0x12)")
        except Exception:
            self.close()
            raise

    def _write_reg(self, addr: int, value: int) -> None:
        self.spi.xfer2([(addr & 0x7F) | 0x80, value & 0xFF])

    def _read_reg(self, addr: int) -> int:
        res = self.spi.xfer2([addr & 0x7F, 0x00])
        return int(res[1])

    def _reset(self) -> None:
        assert self.rst is not None
        self.rst.off()
        time.sleep(0.05)
        self.rst.on()
        time.sleep(0.05)

    def _init_registers(self, freq_hz: int) -> None:
        self._write_reg(_REG_OP_MODE, _MODE_LONG_RANGE | _MODE_SLEEP)
        time.sleep(0.02)

        frf = int((freq_hz * (1 << 19)) / 32_000_000)
        self._write_reg(_REG_FRF_MSB, (frf >> 16) & 0xFF)
        self._write_reg(_REG_FRF_MID, (frf >> 8) & 0xFF)
        self._write_reg(_REG_FRF_LSB, frf & 0xFF)

        self._write_reg(_REG_FIFO_TX_BASE_ADDR, 0x80)
        self._write_reg(_REG_FIFO_RX_BASE_ADDR, 0x00)
        self._write_reg(_REG_MODEM_CONFIG_1, 0x72)  # BW 125 kHz, CR 4/5
        self._write_reg(_REG_MODEM_CONFIG_2, 0x74)  # SF7, CRC ON
        self._write_reg(_REG_MODEM_CONFIG_3, 0x04)
        self._write_reg(_REG_PREAMBLE_MSB, 0x00)
        self._write_reg(_REG_PREAMBLE_LSB, 0x08)
        self._write_reg(_REG_SYNC_WORD, 0x12)
        self._write_reg(_REG_INVERT_IQ, 0x27)
        self._write_reg(_REG_INVERT_IQ2, 0x1D)
        self._write_reg(_REG_DIO_MAPPING_1, 0x00)
        self._write_reg(_REG_IRQ_FLAGS, 0xFF)
        self._write_reg(_REG_OP_MODE, _MODE_LONG_RANGE | _MODE_STDBY)
        time.sleep(0.02)

    def start_receive(self) -> None:
        self._write_reg(_REG_IRQ_FLAGS, 0xFF)
        rx_base = self._read_reg(_REG_FIFO_RX_BASE_ADDR)
        self._write_reg(_REG_FIFO_ADDR_PTR, rx_base)
        self._write_reg(_REG_OP_MODE, _MODE_LONG_RANGE | _MODE_RX_CONTINUOUS)
        time.sleep(0.01)

    def read_packet(self) -> bytes | None:
        irq_flags = self._read_reg(_REG_IRQ_FLAGS)
        if not (irq_flags & _IRQ_RX_DONE_MASK):
            return None
        if irq_flags & _IRQ_CRC_ERROR_MASK:
            self._write_reg(_REG_IRQ_FLAGS, _IRQ_CRC_ERROR_MASK | _IRQ_RX_DONE_MASK)
            return None

        nb_bytes = self._read_reg(_REG_RX_NB_BYTES)
        if nb_bytes <= 0:
            self._write_reg(_REG_IRQ_FLAGS, _IRQ_RX_DONE_MASK)
            return None

        current_addr = self._read_reg(_REG_FIFO_RX_CURRENT_ADDR)
        self._write_reg(_REG_FIFO_ADDR_PTR, current_addr)
        payload = bytearray(self._read_reg(_REG_FIFO) for _ in range(nb_bytes))
        self._write_reg(_REG_IRQ_FLAGS, _IRQ_RX_DONE_MASK)
        return bytes(payload)

    def get_packet_rssi(self) -> int | None:
        try:
            return -164 + int(self._read_reg(0x1A))
        except Exception:
            return None

    def get_packet_snr(self) -> float | None:
        try:
            raw = int(self._read_reg(0x19))
            if raw > 127:
                raw -= 256
            return round(raw / 4.0, 1)
        except Exception:
            return None

    def close(self) -> None:
        for dev in (self.rst, self.dio0, self.spi):
            if dev is not None:
                try:
                    dev.close()
                except Exception:
                    pass


_receiver_lock = threading.Lock()
_receiver_stop = threading.Event()
_receiver_threads: list[threading.Thread] = []
_soil_callback: Callable[[dict[str, float], str, str], None] | None = None
_receiver_state: dict[str, Any] = {
    "lora_available": SPIDEV_AVAILABLE and GPIO_AVAILABLE,
    "lora_connected": False,
    "lora_rssi": None,
    "lora_snr": None,
    "lora_error": None if (SPIDEV_AVAILABLE and GPIO_AVAILABLE) else "spidev/gpiozero unavailable",
    "usb_available": SERIAL_AVAILABLE,
    "usb_connected": False,
    "usb_port": None,
    "usb_baudrate": None,
    "usb_error": None if SERIAL_AVAILABLE else "pyserial unavailable",
    "last_source": None,
    "last_packet_at": None,
    "last_raw": "",
    "packet_count": 0,
    "last_parsed": {},
}


def get_soil_receiver_status() -> dict[str, Any]:
    """Return thread-safe snapshot of LoRa RA-02 and USB Serial soil receivers."""
    with _receiver_lock:
        out = dict(_receiver_state)
        out["last_parsed"] = dict(_receiver_state["last_parsed"])
        return out


def process_incoming_soil_text(
    raw_text: str,
    source: str,
    rssi: int | None = None,
    snr: float | None = None,
    on_soil_packet: Callable[[dict[str, float], str, str], None] | None = None,
) -> dict[str, float]:
    """Parse raw text from LoRa/USB, update diagnostics, and invoke persistence callback."""
    clean_text = raw_text.replace("\x00", "").replace("\r", "").replace("\n", "").strip()
    if not clean_text:
        return {}
    parsed = parse_soil_packet(clean_text)
    if not parsed:
        return {}

    with _receiver_lock:
        _receiver_state["last_source"] = source
        _receiver_state["last_packet_at"] = time.time()
        _receiver_state["last_raw"] = clean_text[:160]
        _receiver_state["packet_count"] = int(_receiver_state["packet_count"]) + 1
        _receiver_state["last_parsed"] = dict(parsed)
        if rssi is not None:
            _receiver_state["lora_rssi"] = rssi
        if snr is not None:
            _receiver_state["lora_snr"] = snr

    cb = on_soil_packet or _soil_callback
    if cb is not None:
        cb(parsed, source, clean_text)
    return parsed


def _list_usb_serial_ports() -> list[str]:
    if serial is None:
        return []
    candidates: list[str] = []
    seen: set[str] = set()
    try:
        for port_info in serial.tools.list_ports.comports():
            dev = port_info.device
            if not dev or dev in seen:
                continue
            if dev.startswith("/dev/ttyAMA") or dev.startswith("/dev/ttyS"):
                continue
            desc = (port_info.description or "").upper()
            if any(tag in dev.upper() or tag in desc for tag in ("USB", "ACM", "ARDUINO", "CH340", "CP210", "FTDI")):
                seen.add(dev)
                candidates.append(dev)
    except Exception:
        pass
    for pattern in ("/dev/ttyUSB*", "/dev/ttyACM*"):
        for dev in sorted(glob.glob(pattern)):
            if dev not in seen:
                seen.add(dev)
                candidates.append(dev)
    return candidates


def _lora_worker() -> None:
    if spidev is None or not GPIO_AVAILABLE:
        return

    while not _receiver_stop.is_set():
        lora: RA02 | None = None
        try:
            lora = RA02()
            lora.start_receive()
            with _receiver_lock:
                _receiver_state["lora_connected"] = True
                _receiver_state["lora_error"] = None

            while not _receiver_stop.is_set():
                irq = lora._read_reg(_REG_IRQ_FLAGS)
                if irq == 0xFF:
                    raise RuntimeError("SPI read 0xFF (LoRa RA-02 disconnected)")
                if irq & _IRQ_RX_DONE_MASK:
                    payload = lora.read_packet()
                    if payload:
                        text = payload.decode("utf-8", errors="ignore")
                        process_incoming_soil_text(
                            text,
                            source="lora_ra02",
                            rssi=lora.get_packet_rssi(),
                            snr=lora.get_packet_snr(),
                        )
                    lora.start_receive()
                _receiver_stop.wait(0.02)
        except Exception as exc:
            with _receiver_lock:
                _receiver_state["lora_connected"] = False
                _receiver_state["lora_error"] = str(exc)
            _receiver_stop.wait(3.0)
        finally:
            if lora is not None:
                lora.close()
            with _receiver_lock:
                _receiver_state["lora_connected"] = False


def _usb_serial_worker() -> None:
    if serial is None:
        return

    baud_candidates = [9600, 115200, 4800, 19200]
    baud_idx = 0
    while not _receiver_stop.is_set():
        ports = _list_usb_serial_ports()
        if not ports:
            with _receiver_lock:
                _receiver_state["usb_connected"] = False
                _receiver_state["usb_port"] = None
                _receiver_state["usb_baudrate"] = None
            _receiver_stop.wait(2.0)
            continue

        target_port = ports[0]
        baud = baud_candidates[baud_idx % len(baud_candidates)]
        ser = None
        try:
            ser = serial.Serial(port=target_port, baudrate=baud, timeout=1.0)
            with _receiver_lock:
                _receiver_state["usb_connected"] = True
                _receiver_state["usb_port"] = target_port
                _receiver_state["usb_baudrate"] = baud
                _receiver_state["usb_error"] = None

            opened_at = time.time()
            last_valid_at: float | None = None
            raw_bytes = 0
            while not _receiver_stop.is_set():
                if target_port.startswith("/dev/") and not os.path.exists(target_port):
                    raise RuntimeError(f"Port {target_port} unplugged")
                line = ser.readline()
                if line:
                    raw_bytes += len(line)
                    text = line.decode("utf-8", errors="ignore")
                    if process_incoming_soil_text(text, source="usb_serial"):
                        last_valid_at = time.time()
                elif last_valid_at is None and raw_bytes > 20 and (time.time() - opened_at) > 8.0:
                    baud_idx = (baud_idx + 1) % len(baud_candidates)
                    break
        except Exception as exc:
            with _receiver_lock:
                _receiver_state["usb_connected"] = False
                _receiver_state["usb_error"] = str(exc)
            _receiver_stop.wait(2.0)
        finally:
            if ser is not None:
                try:
                    ser.close()
                except Exception:
                    pass
            with _receiver_lock:
                _receiver_state["usb_connected"] = False


def start_soil_receivers(
    on_soil_packet: Callable[[dict[str, float], str, str], None],
    enable_lora: bool = True,
    enable_usb: bool = True,
) -> None:
    """Start background LoRa RA-02 and USB Serial soil listener threads once."""
    global _soil_callback
    with _receiver_lock:
        _soil_callback = on_soil_packet
        if any(t.is_alive() for t in _receiver_threads):
            return
        _receiver_stop.clear()
        _receiver_threads.clear()

        if enable_lora and spidev is not None and GPIO_AVAILABLE:
            t_lora = threading.Thread(target=_lora_worker, daemon=True, name="soil-lora-ra02")
            t_lora.start()
            _receiver_threads.append(t_lora)
        if enable_usb and serial is not None:
            t_usb = threading.Thread(target=_usb_serial_worker, daemon=True, name="soil-usb-serial")
            t_usb.start()
            _receiver_threads.append(t_usb)


def stop_soil_receivers() -> None:
    """Signal LoRa RA-02 and USB Serial receiver threads to stop cleanly."""
    _receiver_stop.set()


atexit.register(stop_soil_receivers)
