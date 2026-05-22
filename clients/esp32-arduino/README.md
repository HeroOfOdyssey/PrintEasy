# ESP32 Arduino Bluetooth Client

This Arduino sketch turns an ESP32 module into a wireless bridge between an MQTT broker and an Epson TM-P60II thermal printer, or another ESC/POS printer that speaks Bluetooth Classic Serial Port Profile. It subscribes to a topic containing raw ESC/POS bytes and forwards the payload to the printer.

The system itself is not limited to ESP32: any bridge that can subscribe to the MQTT topic, preserve binary payloads, and write raw bytes to a printer transport can be compatible.

## Prerequisites

* **Hardware**: An ESP32 development board (e.g. ESP32-WROOM-32 or WROOM-32U) and a compatible ESC/POS thermal printer. This sketch assumes the printer exposes a Bluetooth Classic SPP interface, which is common for mobile Epson printers.
* **Software**: Arduino IDE or PlatformIO with ESP32 board support installed. Install the `PubSubClient` library via Library Manager. The built-in ESP32 `BluetoothSerial` library handles Bluetooth.

## Configuration

Open `esp32_mqtt_printer.ino` and edit the following constants at the top of the file:

| Constant | Description |
|---|---|
| `WIFI_SSID`, `WIFI_PASSWORD` | Your Wi‑Fi network credentials. |
| `MQTT_SERVER`, `MQTT_PORT` | Address and port of your MQTT broker. Use `8883` when `MQTT_TLS` is enabled. |
| `MQTT_TLS` | Set `1` for MQTT over TLS or `0` for plaintext MQTT. |
| `MQTT_USER`, `MQTT_PASS` | Broker credentials. Treat `MQTT_PASS` as the device access token. |
| `MQTT_CA_CERT` | PEM CA certificate that signed the broker certificate. Required when `MQTT_TLS` is `1`. |
| `MQTT_TOPIC` | Topic to subscribe to for print jobs (must match the server’s setting). |
| `PRINTER_BT_USE_MAC` | Set `true` to connect by Bluetooth MAC address, or `false` to connect by printer name. |
| `PRINTER_BT_MAC` | Printer Bluetooth MAC address as six hex bytes, for example `0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF`. Used when `PRINTER_BT_USE_MAC` is `true`. |
| `PRINTER_BT_NAME` | Bluetooth device name. This is ignored when `PRINTER_BT_USE_MAC` is `true`; it is only used when `PRINTER_BT_USE_MAC` is `false`. |
| `MQTT_BUFFER_SIZE` | MQTT receive buffer size. It must be larger than the server's `MQTT_PUBLISH_CHUNK_BYTES` plus MQTT topic/packet overhead. The default sketch uses `2048` to leave heap for TLS and Bluetooth Classic on ESP32-WROOM boards. |
| `PRINTER_WRITE_CHUNK_SIZE`, `PRINTER_WRITE_DELAY_MS` | Bluetooth printer pacing. The default writes MQTT payloads to the printer in `256` byte chunks with a `10` ms delay so mobile printers do not miss large SPP bursts. |

If your printer prompts for a pairing PIN, set `SerialBT.setPin("0000")` accordingly in `setup()`.

TLS builds synchronize time from `NTP_SERVER` before connecting so certificate validation can succeed. Make sure the broker certificate includes the hostname or IP address used in `MQTT_SERVER`.

For embedded TLS, prefer an ECDSA P-256 CA and broker certificate. Large RSA certificates, especially RSA-4096, can fail on ESP32 with errors such as `X509 - Allocation of memory failed`. Some ESP32 core versions verify DNS subject alternative names more reliably than raw IP subject alternative names; if IP verification fails, use a direct DNS name that resolves to the broker and include that DNS name in the broker certificate.

## Building and flashing

1. Install the ESP32 platform into your Arduino IDE via the Boards Manager (see Espressif’s documentation).
2. Install the `PubSubClient` library via the Arduino Library Manager.
3. Connect your ESP32 board, select the correct board and port in the IDE, open `esp32_mqtt_printer.ino` and click “Upload”. TLS plus Bluetooth Classic can exceed the default app partition on common ESP32 boards; select a large app partition such as `Huge APP (3MB No OTA/1MB SPIFFS)` when `MQTT_TLS` is enabled.
4. Open the Serial Monitor at 115200 baud to see logs.  You should see messages about connecting to Wi‑Fi, the MQTT broker and the printer.

Recommended Arduino settings for ESP32-WROOM-32/32U-style boards:

| Setting | Value |
|---|---|
| Board | `ESP32 Dev Module` |
| Partition Scheme | `Huge APP (3MB No OTA/1MB SPIFFS)` |
| Flash Mode | `QIO` |
| Flash Frequency | `80MHz` |
| PSRAM | `Disabled`, unless your board reports real PSRAM |

If TLS and Bluetooth Classic run out of heap on ESP32 Arduino core 3.x, try core `2.0.17`. The sketch handles the pairing PIN API difference between 2.x and 3.x. On ESP32-WROOM-32/32U boards, a `2048` MQTT buffer has been more reliable than larger buffers when TLS certificate verification and Bluetooth Classic are both enabled.

The sketch starts the Bluetooth stack early but connects MQTT before connecting to the printer. This leaves a larger contiguous heap block for the TLS handshake; connecting the printer first can make `SSL - Memory allocation failed` more likely even when total free heap still looks reasonable.

If an MQTT message is larger than `MQTT_BUFFER_SIZE`, PubSubClient may not deliver the callback for that message. Keep the server-side `MQTT_PUBLISH_CHUNK_BYTES` at `1800` or lower for the default `2048` ESP32 buffer. `RASTER_BAND_HEIGHT` changes the ESC/POS raster command bands sent inside the job, but MQTT chunking is what makes large jobs fit this small receive buffer.

The sketch does not send periodic newline keepalives to the printer. Newlines advance receipt paper, so printer wake behavior should be handled by the printer or by real print jobs, not by idle keepalive bytes.

## Troubleshooting

* `MQTT failed, state=-2` means the network/TLS socket did not connect; check TLS errors printed after it.
* `X509 - Allocation of memory failed` usually means the certificate chain is too large; use ECDSA P-256 certificates.
* `SSL - Memory allocation failed` usually means TLS and Bluetooth Classic are competing for heap; use a smaller `MQTT_BUFFER_SIZE`, connect MQTT before connecting the printer, or use ESP32 core `2.0.17`.
* Small jobs print but larger jobs never arrive usually means the MQTT message is bigger than `MQTT_BUFFER_SIZE`; lower server `MQTT_PUBLISH_CHUNK_BYTES`.
* MQTT messages arrive but nothing prints usually means the Bluetooth printer is not accepting the write burst; lower `PRINTER_WRITE_CHUNK_SIZE` to `128` or raise `PRINTER_WRITE_DELAY_MS` to `20`.
* `MQTT_TLS_INSECURE=1` still encrypts traffic but disables broker identity verification. Use it only as a diagnostic to separate certificate verification problems from connectivity problems.

## MQTT topic format

The firmware expects the MQTT payload to contain raw ESC/POS bytes. The server component (`../../server/app.js`) automatically generates such payloads from markdown, task lists, QR codes, and images. You can also publish trusted arbitrary ESC/POS commands directly to the topic to test printing.

The payload is binary, not JSON. Any replacement client must avoid treating the message as a null-terminated string and must write exactly the received bytes to the printer transport.

## Handling disconnections

* The sketch reconnects to Wi‑Fi if the connection is lost.
* It retries connecting to the MQTT broker every few seconds until successful and resubscribes to the topic.
* It attempts to reconnect to the Bluetooth printer if the link drops.  You may need to power cycle the printer if it refuses reconnection.

## Extending functionality

Because MQTT decouples the server and client, you can subscribe multiple printers to the same topic or use different topics per printer. You can also implement acknowledgements by having the firmware publish a confirmation message to a separate topic when printing finishes.

## Porting beyond ESP32

To build another client, keep the same contract:

* Subscribe to the configured print topic.
* Receive MQTT payloads as bytes.
* Use a large enough MQTT packet buffer for raster jobs.
* Forward the bytes unchanged to an ESC/POS printer over Bluetooth SPP, USB, serial, TCP, or another transport.

For example, the Linux/Raspberry Pi client in `../linux-python/` can replace this sketch by subscribing with Python and writing the payload to `/dev/usb/lp0`, `/dev/ttyUSB0`, or `/dev/rfcomm0`.
