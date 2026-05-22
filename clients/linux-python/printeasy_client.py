#!/usr/bin/env python3
"""PrintEasy Linux/Raspberry Pi MQTT printer bridge.

Subscribes to a PrintEasy MQTT topic and writes each binary ESC/POS payload
unchanged to one configured printer transport.
"""

from __future__ import annotations

import argparse
import os
import socket
import ssl
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO
from urllib.parse import urlparse


DEFAULT_CONFIG = "/etc/printeasy/client.env"


def parse_bool(value: str | bool | None, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return value.strip().lower() in {"1", "true", "yes", "on"}


def parse_env_file(path: str | None) -> dict[str, str]:
    if not path:
        return {}
    config_path = Path(path)
    if not config_path.exists():
        return {}
    values: dict[str, str] = {}
    for raw_line in config_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


@dataclass(frozen=True)
class Config:
    mqtt_url: str
    mqtt_topic: str
    mqtt_user: str | None
    mqtt_pass: str | None
    mqtt_ca_cert: str | None
    mqtt_tls_insecure: bool
    transport: str
    device: str
    serial_baud: int
    serial_timeout: float
    write_chunk_size: int
    reconnect_interval: float
    dry_run: bool

    @classmethod
    def load(cls, config_file: str | None = DEFAULT_CONFIG) -> "Config":
        file_values = parse_env_file(config_file)
        values = {**file_values, **os.environ}
        transport = values.get("TRANSPORT", "serial").strip().lower()
        if transport not in {"serial", "usb", "bluetooth", "file"}:
            raise ValueError("TRANSPORT must be one of: serial, usb, bluetooth, file")
        device = values.get("DEVICE", "").strip()
        if not device:
            raise ValueError("DEVICE is required")
        return cls(
            mqtt_url=values.get("MQTT_URL", "mqtt://localhost:1883"),
            mqtt_topic=values.get("MQTT_TOPIC", "receipt/print"),
            mqtt_user=values.get("MQTT_USER") or None,
            mqtt_pass=values.get("MQTT_PASS") or None,
            mqtt_ca_cert=values.get("MQTT_CA_CERT") or None,
            mqtt_tls_insecure=parse_bool(values.get("MQTT_TLS_INSECURE"), False),
            transport=transport,
            device=device,
            serial_baud=int(values.get("SERIAL_BAUD", "9600")),
            serial_timeout=float(values.get("SERIAL_TIMEOUT", "5")),
            write_chunk_size=max(1, int(values.get("WRITE_CHUNK_SIZE", "4096"))),
            reconnect_interval=max(1.0, float(values.get("RECONNECT_INTERVAL", "5"))),
            dry_run=parse_bool(values.get("DRY_RUN"), False),
        )


class PrinterWriter:
    def __init__(self, config: Config):
        self.config = config
        self._stream: BinaryIO | None = None
        self._serial: serial.Serial | None = None

    def close(self) -> None:
        if self._serial is not None:
            self._serial.close()
            self._serial = None
        if self._stream is not None:
            self._stream.close()
            self._stream = None

    def open(self) -> None:
        self.close()
        if self.config.transport == "serial":
            import serial

            self._serial = serial.Serial(
                self.config.device,
                baudrate=self.config.serial_baud,
                timeout=self.config.serial_timeout,
                write_timeout=self.config.serial_timeout,
            )
            return
        mode = "ab" if self.config.transport == "file" or self.config.dry_run else "wb"
        self._stream = open(self.config.device, mode, buffering=0)

    def write(self, payload: bytes) -> None:
        if self._serial is None and self._stream is None:
            self.open()
        for offset in range(0, len(payload), self.config.write_chunk_size):
            chunk = payload[offset : offset + self.config.write_chunk_size]
            if self._serial is not None:
                self._serial.write(chunk)
                self._serial.flush()
            elif self._stream is not None:
                self._stream.write(chunk)
                self._stream.flush()


def parse_mqtt_url(url: str) -> tuple[str, int, bool]:
    parsed = urlparse(url)
    scheme = parsed.scheme or "mqtt"
    if scheme not in {"mqtt", "mqtts"}:
        raise ValueError("MQTT_URL must start with mqtt:// or mqtts://")
    host = parsed.hostname or "localhost"
    port = parsed.port or (8883 if scheme == "mqtts" else 1883)
    return host, port, scheme == "mqtts"


def build_client(config: Config, writer: PrinterWriter) -> mqtt.Client:
    import paho.mqtt.client as mqtt

    host, port, use_tls = parse_mqtt_url(config.mqtt_url)
    client = mqtt.Client(client_id=f"printeasy-linux-{socket.gethostname()}", clean_session=True)
    if config.mqtt_user:
        client.username_pw_set(config.mqtt_user, config.mqtt_pass)
    if use_tls:
        client.tls_set(ca_certs=config.mqtt_ca_cert, cert_reqs=ssl.CERT_NONE if config.mqtt_tls_insecure else ssl.CERT_REQUIRED)
        client.tls_insecure_set(config.mqtt_tls_insecure)

    def on_connect(client_obj: mqtt.Client, _userdata, _flags, rc: int) -> None:
        if rc == 0:
            print(f"[MQTT] connected to {host}:{port}; subscribing to {config.mqtt_topic}", flush=True)
            client_obj.subscribe(config.mqtt_topic, qos=1)
        else:
            print(f"[MQTT] connection failed rc={rc}", flush=True)

    def on_disconnect(_client_obj: mqtt.Client, _userdata, rc: int) -> None:
        print(f"[MQTT] disconnected rc={rc}", flush=True)

    def on_message(_client_obj: mqtt.Client, _userdata, message: mqtt.MQTTMessage) -> None:
        payload = bytes(message.payload)
        print(f"[PRINT] topic={message.topic} bytes={len(payload)}", flush=True)
        try:
            writer.write(payload)
        except Exception as exc:  # noqa: BLE001 - daemon should keep running
            writer.close()
            print(f"[PRINT] write failed: {exc}", file=sys.stderr, flush=True)

    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message
    client.connect_async(host, port, keepalive=60)
    return client


def run(config: Config) -> int:
    writer = PrinterWriter(config)
    client = build_client(config, writer)
    client.loop_start()
    try:
        while True:
            time.sleep(config.reconnect_interval)
    except KeyboardInterrupt:
        print("Stopping PrintEasy client", flush=True)
    finally:
        client.loop_stop()
        client.disconnect()
        writer.close()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="PrintEasy Linux MQTT printer bridge")
    parser.add_argument("--config", default=DEFAULT_CONFIG, help="Path to environment-style config file")
    parser.add_argument("--print-config", action="store_true", help="Parse config and print the resolved settings")
    parser.add_argument("--write-sample", help="Write a sample ESC/POS payload to this output path and exit")
    args = parser.parse_args()

    config = Config.load(args.config)
    if args.print_config:
        safe = {**config.__dict__, "mqtt_pass": "***" if config.mqtt_pass else None}
        print(safe)
        return 0
    if args.write_sample:
        sample = b"\x1b@PrintEasy dry-run test\n\n\x1dV\x00"
        dry_config = Config(
            **{
                **config.__dict__,
                "transport": "file",
                "device": args.write_sample,
                "dry_run": True,
            }
        )
        writer = PrinterWriter(dry_config)
        writer.write(sample)
        writer.close()
        print(f"Wrote {len(sample)} sample bytes to {args.write_sample}")
        return 0
    return run(config)


if __name__ == "__main__":
    raise SystemExit(main())
