# MQTT Printer Bridge

This repository provides an end‑to‑end solution for turning a thermal receipt printer into a cloud‑connected device.  It uses **MQTT** to deliver print jobs from your server to a microcontroller that is paired with the printer (via Bluetooth or serial).  The design is inspired by the lessons learned when building cloud‑connected thermal printers: HTTP polling and WebSockets can work, but MQTT is far more efficient and reliable on constrained devices.

## Overview

The system consists of two major components:

1. **Server (`./server`)** – A Node.js service that exposes a simple HTTP API for creating print jobs.  It converts markdown or task lists into Epson ESC/POS commands using [`receiptline`](https://github.com/receiptline/receiptline) and publishes them to an MQTT topic.  The server also supports printing QR codes and images: clients can include a `qr` field to encode a string into an ESC/POS QR symbol using the printer’s built‑in commands, and an `image` field containing a base64‑encoded PNG/JPEG that will be rasterised into a 1‑bit bitmap and appended to the job.  The server can run standalone or inside Docker and is easy to deploy alongside an MQTT broker.
   The server also implements a minimal [Model Context Protocol](https://modelcontextprotocol.com/) interface: clients can discover available tools via a JSON‑RPC call to `/mcp` and invoke the `printReceipt` tool to print text, QR codes or images.  A corresponding `/mcp/sse` endpoint streams tool definitions and invocation results via server‑sent events for asynchronous integrations.

2. **Client (`./client`)** – An Arduino sketch for ESP32 (or similar) microcontrollers.  It connects to your Wi‑Fi network, subscribes to the print topic on the MQTT broker, then forwards the raw ESC/POS data to the printer via Bluetooth Classic (SPP).  The firmware automatically reconnects to Wi‑Fi, MQTT and the Bluetooth printer if any connection drops, and sends periodic wake‑up commands to keep the printer from sleeping.

MQTT’s lightweight publish/subscribe model eliminates heavy SSL handshakes and polling, greatly reducing memory usage on the microcontroller and improving reliability.  In practice this change reduced latency and stopped the device from crashing under load.

## Project structure

```text
mqtt_printer_bridge
├── client
│   ├── README.md           – Instructions for flashing the ESP32 firmware
│   └── esp32_mqtt_printer.ino – Arduino sketch for the microcontroller
├── server
│   ├── Dockerfile          – Container build for the Node.js server
│   ├── README.md           – Usage and configuration for the server
│   ├── app.js              – Express/MQTT service that publishes print jobs
│   ├── package.json        – Node.js dependencies and scripts
│   └── .env.example        – Example environment configuration
└── docker-compose.yml      – Compose file to run the server and an MQTT broker
```

## Running with Docker Compose

To try the system locally, you can use Docker Compose.  This spins up an MQTT broker (eclipse‑mosquitto) and the Node.js server in separate containers.  Follow these steps:

1. Copy `./server/.env.example` to `./server/.env` and adjust the values to suit your environment.  At a minimum, set `API_TOKEN` to a strong secret.  If you run the broker on the default ports locally, the example values will work.

2. From the repository root, run:

```sh
docker compose build
docker compose up
```

3. Once the containers are running, you can send a print job via HTTP:

```sh
curl -X POST http://localhost:3000/print \
  -H "Authorization: Bearer <API_TOKEN>" \
  -H "Content-Type: application/json" \
  --data-raw '{"tasks": ["Buy milk", "Check email", "Walk the dog"]}'
```

   The server will convert your task list into ESC/POS commands and publish them to the MQTT topic.  Any connected ESP32 client subscribed to that topic will print the receipt.

4. The `/health` endpoint returns the server’s status and whether it is connected to the MQTT broker.

## Why MQTT?

The original implementation used WebSockets and a custom protocol.  That works for a handful of clients, but it becomes fragile on resource‑constrained hardware.  The ESP32 can handle Wi‑Fi and Bluetooth simultaneously, but memory is limited and TLS handshakes are expensive.  Switching to MQTT removes the need for long‑running secure WebSocket sessions and polling.  Instead, the device maintains a single lightweight MQTT connection with keep‑alive; messages are delivered instantly and can be configured for at‑least‑once or exactly‑once semantics.  This pattern significantly improved reliability and reduced latency in real‑world tests.

## Licence

This project is provided as‑is under the MIT licence.  See each subdirectory for more details.
