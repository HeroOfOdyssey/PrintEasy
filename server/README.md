# MQTT Printer Server

This Node.js service provides a REST API for turning lists of tasks, markdown, QR codes, and images into ESC/POS commands and publishing them to an MQTT broker. It is designed to work with the ESP32 firmware in `../client`, which listens on the same MQTT topic and forwards the data to a thermal printer.

By default, markdown is rendered server-side into a fixed-width 1-bit raster image. For your 2-1/4 inch rolls, this is set to the TM-P60II’s 58 mm printable mode: **420 dots wide**. Epson’s TM-P60II guide lists 203 × 203 dpi density and 420-dot / 52.5 mm print width for 58 mm paper, while 60 mm mode is 432 dots / 54 mm.

## Features

* **POST `/print`** – Accepts plain text, markdown, or a JSON payload like `{ "tasks": ["Task 1", "Task 2"], "qr": "https://example.com", "image": "data:image/png;base64,…" }`.  Converts the input into ESC/POS bytes via [`receiptline`](https://github.com/receiptline/receiptline).  If a `qr` field is provided, the string is encoded into a QR Code using the printer’s native ESC/POS commands.  If an `image` field is provided, the base64‑encoded PNG/JPEG is resized and rasterised into a monochrome bitmap and wrapped in the `GS v 0` command.  The resulting byte sequence is published to the configured MQTT topic.  Requires an API token for authentication.
* **POST `/preview`** – Same as `/print`, but returns a hex string of the generated ESC/POS bytes instead of publishing.  Useful for debugging and verifying the output before sending it to a printer.
* **GET `/health`** – Returns `{ ok: true, mqtt: <boolean> }` indicating whether the server is connected to the MQTT broker.
* **POST `/mcp`** – Minimal [Model Context Protocol](https://modelcontextprotocol.com/) endpoint supporting JSON‑RPC 2.0.  Clients can call `tools/list` to discover available tools (currently just `printReceipt`) and `tools/call` to invoke the receipt printer.  The `printReceipt` tool accepts the same arguments as the REST API: you can provide `tasks`, `markdown`, `qr` and/or `image` fields and the server will assemble the ESC/POS bytes and publish them to MQTT.
* **GET `/mcp/sse`** – Server‑Sent Events (SSE) stream for asynchronous MCP results.  Clients can open an `EventSource` to this endpoint to receive tool definitions and real‑time notifications when `tools/call` invocations complete.  This is useful for assistants that need streaming tool discovery and callback events.

## Configuration

The service reads configuration values from environment variables.  Copy `.env.example` to `.env` and set the variables there, or provide them via the environment when running the container.

| Variable | Description |
|---|---|
| `API_TOKEN` | Secret token for authenticating API requests.  Clients must include `Authorization: Bearer <API_TOKEN>` or `X-API-Token: <API_TOKEN>` in the request. |
| `MQTT_URL` | Connection string for the MQTT broker (e.g. `mqtt://localhost:1883` or `mqtts://broker.example.com:8883`). |
| `MQTT_USER` / `MQTT_PASS` | Credentials for the MQTT broker if authentication is required. |
| `MQTT_TOPIC` | Topic to which print jobs are published.  Clients should subscribe to this exact topic. |
| `PRINTER_CPL` | Characters per line for receipt formatting.  Defaults to 42 for 58 mm paper. |
| `PRINTER_COMMAND` | Command set for receiptline to generate (default `escpos`). |
| `PRINTER_ENCODING` | Character encoding (default `multilingual`). |
| `PRINTER_DOTS` | Fixed raster canvas width. Use `420` for 2-1/4 inch / 58 mm TM-P60II rolls. |
| `RASTER_MARKDOWN` | When `true`, markdown is rendered as a fixed-width raster image instead of native text. |
| `RASTER_BAND_HEIGHT` | Height of each raster band sent to the printer. Smaller bands are safer over Bluetooth. |
| `RASTER_THRESHOLD` | Grayscale threshold for converting rendered output to black and white. |
| `RASTER_FONT_SIZE` | Font size used by the SVG-to-raster markdown renderer. |
| `RASTER_LINE_HEIGHT` | Line height used by the markdown renderer. |
| `RASTER_MARGIN_X` | Left/right horizontal margin in dots. Use `0` for maximum width. |
| `PORT` | Port on which the HTTP server listens (default 3000). |

## Rendered markdown format

The server supports a small internal markdown layer before rasterization:

````md
# Daily Tasks

- [ ] Wake up
- [x] Coffee
- [ ] Ship labels

---

| Item | Qty | Price |
|------|-----|-------|
| Tea  | 2   | $4    |

```qr
https://example.com
```

```image
data:image/png;base64,...
```
````

Normal markdown, headings, bullets, numbered lists, GitHub-style checkboxes, horizontal rules, and simple tables are rendered into fixed-width raster bands. QR fenced blocks are kept as native ESC/POS QR commands so they stay small and scan cleanly. Image fenced blocks are decoded and rasterized at the configured print width.

## Running locally

1. Install dependencies:

   ```sh
   cd server
   npm install
   cp .env.example .env  # then edit .env as needed
   npm start
   ```

2. Send a print request:

   ```sh
   curl -X POST http://localhost:3000/print \
     -H "Authorization: Bearer <API_TOKEN>" \
     -H "Content-Type: application/json" \
     --data-raw '{"tasks": ["Write unit tests", "Drink coffee"]}'
   ```

   Example with rendered markdown and native QR:

   ```sh
   curl -X POST http://localhost:3000/print \
     -H "Authorization: Bearer <API_TOKEN>" \
     -H "Content-Type: application/json" \
     --data-raw '{"markdown":"# Today\n\n- [ ] Pack printer\n- [x] Test QR\n\n```qr\nhttps://example.com\n```"}'
   ```

   Ensure an MQTT broker is running and reachable at `MQTT_URL`, and that your ESP32 firmware is subscribed to `MQTT_TOPIC`.

## Docker usage

The provided `Dockerfile` builds a lightweight container using `node:18-alpine`.  To run the server via Docker Compose alongside an MQTT broker, see the root‑level [`docker-compose.yml`](../docker-compose.yml).  Adjust the broker URL in `server/.env` to `mqtt://mqtt-broker:1883` to reference the broker service defined in the compose file.

## Security

* **Authentication** – The API requires a bearer token for all mutating endpoints.  Set `API_TOKEN` to a strong random value and do not commit your `.env` file to version control.
* **TLS** – For production deployments, run the broker with TLS (e.g. `mqtts://broker.example.com:8883`) and use secure credentials.  Consider placing this server behind a reverse proxy (nginx, Caddy) to terminate HTTPS for the REST API.
