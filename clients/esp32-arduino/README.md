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
| `PRINTER_BT_NAME` | The Bluetooth device name of your printer (as seen when pairing).  Alternatively, hard‑code the MAC address in the sketch and call `SerialBT.connect(uint8_t[6])`. |
| `MQTT_BUFFER_SIZE` | MQTT receive buffer size. It must be larger than the largest ESC/POS packet sent by the server. The default sketch uses `16384`, which fits the default raster band size. |
| `BT_WAKE_INTERVAL` | Milliseconds between sending a newline to the printer.  Prevents the printer from going into power‑save mode. |

If your printer prompts for a pairing PIN, set `SerialBT.setPin("0000")` accordingly in `setup()`.

TLS builds synchronize time from `NTP_SERVER` before connecting so certificate validation can succeed. Make sure the broker certificate includes the hostname or IP address used in `MQTT_SERVER`.

## Building and flashing

1. Install the ESP32 platform into your Arduino IDE via the Boards Manager (see Espressif’s documentation).
2. Install the `PubSubClient` library via the Arduino Library Manager.
3. Connect your ESP32 board, select the correct board and port in the IDE, open `esp32_mqtt_printer.ino` and click “Upload”.
4. Open the Serial Monitor at 115200 baud to see logs.  You should see messages about connecting to Wi‑Fi, the MQTT broker and the printer.

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
