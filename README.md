# PrintEasy

PrintEasy is an end-to-end MQTT bridge for sending custom receipt print jobs from a server/operator to a printer-connected device on your local network. The server renders tasks, markdown, QR codes, images, or raw ESC/POS into printer-ready bytes and publishes them to MQTT. Any client that subscribes to the print topic and forwards the binary payload to a compatible printer can be used.

The included clients now cover Linux/Raspberry Pi, ESP32, and starter microcontroller targets. ESP32 remains the Bluetooth Classic SPP reference for printers such as the Epson TM-P60II, but it is not the protocol limit.

## Overview

The system consists of two major components:

1. **Server (`./server`)** - A Node.js service that exposes HTTP and MCP interfaces for creating print jobs. It converts markdown or task lists into ESC/POS commands using [`receiptline`](https://github.com/receiptline/receiptline), rasterizes markdown/images with `sharp`, generates native ESC/POS QR codes, and publishes the resulting binary payload to an MQTT topic.
   The MCP endpoint supports `initialize`, `ping`, `tools/list`, and `tools/call` with tools for printing, previewing, publishing trusted raw ESC/POS, and checking status.

2. **Clients (`./clients`)** - Device bridges that subscribe to the MQTT print topic and forward raw ESC/POS bytes to a printer. The Linux/Raspberry Pi client supports serial, raw USB, and Bluetooth RFCOMM. The ESP32 Arduino client supports Bluetooth Classic SPP. ESP8266 and Pico W/Pico 2 W starter clients document serial-first microcontroller paths.

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
| [`clients/linux-python`](clients/linux-python/) | Working core | Raspberry Pi and Linux devices | Serial, raw USB, Bluetooth RFCOMM |
| [`clients/esp32-arduino`](clients/esp32-arduino/) | Working reference | Compact Bluetooth printer bridge | Bluetooth Classic SPP |
| [`clients/esp8266-arduino`](clients/esp8266-arduino/) | Starter | Low-cost Wi-Fi serial bridge | UART / SoftwareSerial |
| [`clients/pico-w`](clients/pico-w/) | Starter docs | Pico W / Pico 2 W serial bridge | UART serial |
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
│   ├── esp8266-arduino        – ESP8266 serial bridge starter
│   └── pico-w                 – Pico W / Pico 2 W serial bridge starter
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

1. Copy `./server/.env.example` to `./server/.env` and adjust the values to suit your environment.  At a minimum, set `API_TOKEN` to a strong secret.  If you run the broker on the default ports locally, the example values will work.

2. From the repository root, run:

```sh
docker compose build
docker compose up
```

If host port `3000` is already in use, publish the server on another local port:

```sh
HTTP_PORT=3002 docker compose up
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

## Why MQTT?

The original implementation used WebSockets and a custom protocol.  That works for a handful of clients, but it becomes fragile on resource‑constrained hardware.  The ESP32 can handle Wi‑Fi and Bluetooth simultaneously, but memory is limited and TLS handshakes are expensive.  Switching to MQTT removes the need for long‑running secure WebSocket sessions and polling.  Instead, the device maintains a single lightweight MQTT connection with keep‑alive; messages are delivered instantly and can be configured for at‑least‑once or exactly‑once semantics.  This pattern significantly improved reliability and reduced latency in real‑world tests.

## Licence

This project is provided as‑is under the MIT licence.  See each subdirectory for more details.
