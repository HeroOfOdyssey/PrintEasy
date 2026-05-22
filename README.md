# PrintEasy

PrintEasy is an end-to-end MQTT bridge for sending custom receipt print jobs from an operator server to printer-connected devices on your local network. The server renders tasks, markdown, QR codes, images, or raw ESC/POS into printer-ready bytes and publishes them to MQTT. Any client that subscribes to the print topic and forwards the binary payload to a compatible printer can be used.

The included clients cover Linux/Raspberry Pi, ESP32, and serial-first microcontroller targets. ESP32 is a practical fit for Bluetooth Classic SPP printers such as the Epson TM-P60II, but the protocol is not tied to ESP32.

## Overview

The system consists of two major components:

1. **Server (`./server`)** - A Node.js service that exposes HTTP and MCP interfaces for creating print jobs. It converts markdown or task lists into ESC/POS commands using [`receiptline`](https://github.com/receiptline/receiptline), rasterizes markdown/images with `sharp`, generates native ESC/POS QR codes, and publishes the resulting binary payload to an MQTT topic.
   The MCP endpoint uses stateless Streamable HTTP and supports `initialize`, `ping`, `tools/list`, and `tools/call` with tools for printing, previewing, publishing trusted raw ESC/POS, and checking status.

2. **Clients (`./clients`)** - Device bridges that subscribe to the MQTT print topic and forward raw ESC/POS bytes to a printer. The Linux/Raspberry Pi client supports serial, raw USB, and Bluetooth RFCOMM. The ESP32 Arduino client supports Bluetooth Classic SPP. ESP8266 and Pico W/Pico 2 W clients provide serial-first microcontroller paths.

MQTT's lightweight publish/subscribe model keeps the device side simple: subscribe to a topic, receive binary ESC/POS payloads, write them to the printer transport.

## Compatibility

Current server output is ESC/POS-oriented. It should work with printers that accept ESC/POS commands, including many Epson-compatible thermal printers. The default raster width is tuned for Epson TM-P60II 58 mm paper at 420 dots, but this is configurable with `PRINTER_DOTS` and related raster settings.

The architecture supports multiple platforms because the wire protocol is only MQTT carrying binary ESC/POS bytes:

```text
operator / app / MCP client
        -> PrintEasy server
        -> MQTT topic, default receipt/print
        -> any bridge client
        -> printer transport, such as Bluetooth SPP, USB, serial, TCP
        -> ESC/POS printer
```

For non-ESP32 clients, the important requirements are binary-safe MQTT payload handling, enough MQTT packet buffer for raster jobs, and a way to write raw bytes to the printer.

## Clients

| Client | Status | Best for | Printer transports |
|---|---|---|---|
| [`clients/linux-python`](clients/linux-python/) | Supported | Raspberry Pi and Linux devices | Serial, raw USB, Bluetooth RFCOMM |
| [`clients/esp32-arduino`](clients/esp32-arduino/) | Supported | Compact Bluetooth printer bridge | Bluetooth Classic SPP |
| [`clients/esp8266-arduino`](clients/esp8266-arduino/) | Hardware-adaptable | Low-cost Wi-Fi serial bridge | UART / SoftwareSerial |
| [`clients/pico-w`](clients/pico-w/) | Firmware target | Pico W / Pico 2 W bridge | Bluetooth SPP, UART serial, USB CDC serial |
| [`clients/protocol`](clients/protocol/) | Shared contract | All clients | MQTT binary ESC/POS |

For Raspberry Pi, use `clients/linux-python/`. Raspberry Pi is treated as a Linux target because Raspberry Pi OS exposes serial devices, raw USB printer devices, and Bluetooth RFCOMM through standard Linux interfaces.

## Project structure

```text
mqtt_printer_bridge
├── client
│   └── README.md              – Compatibility pointer to clients/
├── clients
│   ├── README.md              – Client target overview
│   ├── protocol               – Shared MQTT binary payload contract
│   ├── linux-python           – Raspberry Pi / Linux Python bridge
│   ├── esp32-arduino          – ESP32 Bluetooth SPP bridge
│   ├── esp8266-arduino        – ESP8266 serial bridge
│   └── pico-w                 – Pico W / Pico 2 W firmware target
├── mosquitto
│   └── mosquitto.conf         – Local broker config for Docker Compose
├── server
│   ├── Dockerfile             – Container build for the Node.js server
│   ├── README.md              – Usage and configuration for the server
│   ├── app.js                 – Express/MQTT/MCP service
│   ├── package.json           – Node.js dependencies and scripts
│   └── .env.example           – Example environment configuration
└── docker-compose.yml         – Compose file to run the server and MQTT broker
```

## Running with Docker Compose

To try the system locally, you can use Docker Compose.  This spins up an MQTT broker (eclipse‑mosquitto) and the Node.js server in separate containers.  Follow these steps:

1. Copy `./server/.env.example` to `./server/.env` and adjust the values to suit your environment.  At a minimum, set `API_TOKEN` and `MQTT_PASS` to strong secrets.  The compose setup uses MQTT username/password authentication and publishes a TLS listener on port `8883`; distribute `./mosquitto/certs/ca.crt` to clients that verify the broker certificate.

2. From the repository root, run:

```sh
docker compose build
docker compose up
```

If host port `3000` is already in use, publish the HTTP API on another local port:

```sh
HTTP_PORT=3002 docker compose up
```

To control the public MQTT TLS bind address, set `MQTT_TLS_BIND`, for example:

```sh
MQTT_TLS_BIND=0.0.0.0:8883 docker compose up
```

3. Once the containers are running, you can send a print job via HTTP:

```sh
curl -X POST http://localhost:3000/print \
  -H "Authorization: Bearer <API_TOKEN>" \
  -H "Content-Type: application/json" \
  --data-raw '{"tasks": ["Buy milk", "Check email", "Walk the dog"]}'
```

   The server will convert your task list into ESC/POS commands and publish them to the MQTT topic. Any compatible client subscribed to that topic can forward the payload to a printer.

4. The `/health` endpoint returns the server's status, MQTT connection state, default topic, and renderer settings.

   Printer clients should connect to MQTT with `MQTT_SERVER=<host-or-ip>`, `MQTT_PORT=8883`, `MQTT_USER`, `MQTT_PASS`, and the CA certificate from `mosquitto/certs/ca.crt`.

### Embedded TLS notes

For ESP32, ESP8266, and Pico W clients, use compact TLS certificates. Prefer an ECDSA P-256 CA and broker certificate; large RSA certificates, especially RSA-4096, can exhaust heap during X.509 parsing. The broker certificate must include the exact DNS name or IP address used by the client in its subject alternative names. If a client has trouble verifying an IP-address certificate, use a direct DNS name that resolves to the broker, such as a `nip.io` name, and include that DNS name in the broker certificate.

Microcontroller clients have limited RAM. TLS, Bluetooth Classic, and large raster MQTT payloads compete for heap. If TLS fails, reduce the client MQTT buffer. If small jobs print but larger raster/image jobs never arrive, lower server `MQTT_PUBLISH_CHUNK_BYTES` so each MQTT message fits the client buffer, or use the Linux/Raspberry Pi client for larger jobs.

## Why MQTT?

MQTT keeps printer clients small and portable. A device maintains one lightweight connection with keep-alive, subscribes to a topic, and receives binary payloads as jobs arrive. That model works well on Linux systems and resource-constrained microcontrollers because it avoids polling and keeps rendering logic on the server.

## Licence

This project is provided as‑is under the MIT licence.  See each subdirectory for more details.
