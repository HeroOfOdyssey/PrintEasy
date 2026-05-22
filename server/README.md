# MQTT Printer Server

This Node.js service provides REST and MCP interfaces for turning lists of tasks, markdown, QR codes, images, and trusted raw ESC/POS into printer-ready MQTT messages. Clients under `../clients` listen on the same topic and forward the data to printers over transports such as serial, raw USB, and Bluetooth SPP/RFCOMM.

By default, markdown is rendered server-side into a fixed-width 1-bit raster image. For your 2-1/4 inch rolls, this is set to the TM-P60II’s 58 mm printable mode: **420 dots wide**. Epson’s TM-P60II guide lists 203 × 203 dpi density and 420-dot / 52.5 mm print width for 58 mm paper, while 60 mm mode is 432 dots / 54 mm.

## Features

* **POST `/print`** - Accepts plain text, markdown, or a JSON payload like `{ "tasks": ["Task 1", "Task 2"], "qr": "https://example.com", "image": "data:image/png;base64,..." }`. Converts the input into ESC/POS bytes and publishes to MQTT or schedules it for later. Requires an API token.
* **POST `/preview`** - Same input as `/print`, but returns a hex string of the generated ESC/POS bytes instead of publishing. Useful for debugging before sending a job to a printer.
* **GET `/queue`** - Returns pending scheduled print jobs and recent queue history.
* **DELETE `/queue/:id`** - Cancels a pending scheduled print job.
* **GET `/health`** - Returns server status, MQTT connection state, default topic, whether per-request topics are enabled, and renderer settings.
* **POST `/mcp`** - JSON-RPC MCP endpoint. Supports `initialize`, `ping`, `tools/list`, and `tools/call`. Requires the same API token as `/print`.
* **GET `/mcp/sse`** - Server-Sent Events stream for MCP tool-result notifications. EventSource clients can pass the token as `?token=<API_TOKEN>`; clients that support headers should prefer `Authorization: Bearer <API_TOKEN>`.

## MCP tools

The MCP endpoint exposes these tools:

| Tool | Purpose |
|---|---|
| `printReceipt` | Renders `tasks`, `text`, `markdown`, `qr`, and/or `image` into ESC/POS and publishes it to MQTT or schedules it for later. |
| `previewReceipt` | Renders the job without publishing and returns byte counts plus optional hex/base64 previews. |
| `publishEscPos` | Publishes trusted raw ESC/POS bytes supplied as base64 or hex, immediately or on a schedule. |
| `listPrintQueue` | Returns pending scheduled jobs and recent queue history. |
| `cancelQueuedPrint` | Cancels a pending scheduled job by id. |
| `getPrinterStatus` | Returns MQTT and renderer status/configuration. |

MCP tool definitions use `inputSchema` and tool calls return MCP-style `content`, `structuredContent`, and `isError` fields.

## Configuration

The service reads configuration values from environment variables.  Copy `.env.example` to `.env` and set the variables there, or provide them via the environment when running the container.

| Variable | Description |
|---|---|
| `API_TOKEN` | Secret token for authenticating API requests.  Clients must include `Authorization: Bearer <API_TOKEN>` or `X-API-Token: <API_TOKEN>` in the request. |
| `HOST` | Host address for the HTTP server to bind. Defaults to `0.0.0.0` for container use. Use `127.0.0.1` for local-only development. |
| `MQTT_URL` | Connection string for the MQTT broker (e.g. `mqtt://localhost:1883` or `mqtts://broker.example.com:8883`). |
| `MQTT_CA_CERT` | Optional CA certificate path used to verify a private/self-signed TLS broker. |
| `MQTT_USER` / `MQTT_PASS` | Credentials for the MQTT broker if authentication is required. |
| `MQTT_TOPIC` | Topic to which print jobs are published.  Clients should subscribe to this exact topic. |
| `ALLOW_TOPIC_OVERRIDE` | When `true`, MCP requests may publish to a `topic` argument instead of only `MQTT_TOPIC`. Defaults to `false`. |
| `PRINT_QUEUE_MAX_JOBS` | Maximum pending scheduled jobs kept in memory. Defaults to `100`. |
| `PRINT_QUEUE_RETRY_MS` | Retry interval for due queued jobs while MQTT is disconnected or publish fails. Defaults to `5000`. |
| `PRINT_QUEUE_HISTORY_LIMIT` | Number of published/cancelled queue entries to keep in memory for inspection. Defaults to `50`. |
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

   Ensure an MQTT broker is running and reachable at `MQTT_URL`, and that at least one bridge client is subscribed to `MQTT_TOPIC`.

3. Schedule a print request:

   ```sh
   curl -X POST http://localhost:3000/print \
     -H "Authorization: Bearer <API_TOKEN>" \
     -H "Content-Type: application/json" \
     --data-raw '{"tasks":["Start prep"],"scheduleAt":"2026-05-17T20:30:00Z"}'
   ```

   Relative scheduling is also supported:

   ```sh
   curl -X POST http://localhost:3000/print \
     -H "Authorization: Bearer <API_TOKEN>" \
     -H "Content-Type: application/json" \
     --data-raw '{"text":"Print this in 30 seconds","delayMs":30000}'
   ```

   Inspect and cancel queued jobs:

   ```sh
   curl -H "Authorization: Bearer <API_TOKEN>" http://localhost:3000/queue
   curl -X DELETE -H "Authorization: Bearer <API_TOKEN>" http://localhost:3000/queue/<JOB_ID>
   ```

   The queue is in memory. It is designed for operator timing and retry during short broker outages, not as durable storage across server restarts.

4. MCP example:

   ```sh
   curl -X POST http://localhost:3000/mcp \
     -H "Authorization: Bearer <API_TOKEN>" \
     -H "Content-Type: application/json" \
     --data-raw '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
   ```

   Preview a job without publishing:

   ```sh
   curl -X POST http://localhost:3000/mcp \
     -H "Authorization: Bearer <API_TOKEN>" \
     -H "Content-Type: application/json" \
     --data-raw '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"previewReceipt","arguments":{"markdown":"# Test\n\n- [ ] Print from MCP","includeHex":true,"maxBytes":64}}}'
   ```

   Schedule from MCP by adding `scheduleAt` or `delayMs` to `printReceipt` or `publishEscPos` arguments.

## Docker usage

The provided `Dockerfile` builds a lightweight container using `node:18-alpine`, fontconfig, and DejaVu fonts for predictable SVG-to-raster output. To run the server via Docker Compose alongside an MQTT broker, see the root-level [`docker-compose.yml`](../docker-compose.yml). Adjust the broker URL in `server/.env` to `mqtts://mqtt-broker:8883` to reference the TLS broker service defined in the compose file.

Compose publishes the container's port `3000` to host port `3000` by default. If that host port is busy, run `HTTP_PORT=3002 docker compose up` from the repository root. The compose broker config requires MQTT credentials and exposes TLS on `8883`; set `MQTT_TLS_BIND` to choose the host bind address.

## Client compatibility

The server does not require ESP32 specifically. It publishes binary ESC/POS payloads over MQTT. A compatible client needs to:

* Subscribe to `MQTT_TOPIC`.
* Preserve the MQTT payload as raw bytes.
* Use a packet/buffer size large enough for raster bands.
* Write those bytes to a printer transport such as Bluetooth SPP, USB, serial, or TCP.
* Target a printer that understands the generated command set. The default command set is ESC/POS.

## Security

* **Authentication** - The REST print/preview endpoints and MCP endpoint require the API token. Set `API_TOKEN` to a strong random value and do not commit your `.env` file.
* **Raw ESC/POS** - `publishEscPos` is intentionally powerful. Only expose MCP to trusted operators.
* **TLS** - For production deployments, run the broker with TLS (e.g. `mqtts://broker.example.com:8883`) and use secure credentials. For embedded clients, prefer ECDSA P-256 certificates rather than RSA-4096 to avoid heap exhaustion during certificate parsing. Ensure the broker certificate includes the exact DNS name or IP address clients use. Consider placing this server behind a reverse proxy such as Caddy, nginx, or Traefik to terminate HTTPS for REST/MCP traffic.
