# ESP32 MQTT Printer Client

This Arduino sketch turns an ESP32 module into a wireless bridge between an MQTT broker and an Epson TM‑P60II thermal printer (or any ESC/POS printer that speaks Bluetooth Classic Serial Port Profile).  It subscribes to a topic containing raw ESC/POS data and forwards it to the printer.  The firmware automatically reconnects to Wi‑Fi, MQTT and Bluetooth if any link is lost and periodically wakes the printer to prevent it from sleeping.

## Prerequisites

* **Hardware**: An ESP32 development board (e.g. ESP32‑WROOM‑32 or WROOM‑32U) and a compatible thermal printer.  This sketch assumes the printer exposes a Bluetooth SPP interface (common for mobile Epson printers).
* **Software**: Arduino IDE or PlatformIO with the ESP32 board support installed.  You need the `PubSubClient` library installed (via Library Manager).  The built‑in `BluetoothSerial` library handles Bluetooth.

## Configuration

Open `esp32_mqtt_printer.ino` and edit the following constants at the top of the file:

| Constant | Description |
|---|---|
| `WIFI_SSID`, `WIFI_PASSWORD` | Your Wi‑Fi network credentials. |
| `MQTT_SERVER`, `MQTT_PORT` | Address and port of your MQTT broker.  When using the included docker‑compose setup, set this to `mqtt-broker` and `1883`. |
| `MQTT_USER`, `MQTT_PASS` | Broker credentials if required; leave as `nullptr` for anonymous access. |
| `MQTT_TOPIC` | Topic to subscribe to for print jobs (must match the server’s setting). |
| `PRINTER_BT_NAME` | The Bluetooth device name of your printer (as seen when pairing).  Alternatively, hard‑code the MAC address in the sketch and call `SerialBT.connect(uint8_t[6])`. |
| `BT_WAKE_INTERVAL` | Milliseconds between sending a newline to the printer.  Prevents the printer from going into power‑save mode. |

If your printer prompts for a pairing PIN, set `SerialBT.setPin("0000")` accordingly in `setup()`.

## Building and flashing

1. Install the ESP32 platform into your Arduino IDE via the Boards Manager (see Espressif’s documentation).
2. Install the `PubSubClient` library via the Arduino Library Manager.
3. Connect your ESP32 board, select the correct board and port in the IDE, open `esp32_mqtt_printer.ino` and click “Upload”.
4. Open the Serial Monitor at 115200 baud to see logs.  You should see messages about connecting to Wi‑Fi, the MQTT broker and the printer.

## MQTT topic format

The firmware expects the MQTT payload to contain raw ESC/POS bytes.  The server component (`../server/app.js`) automatically generates such payloads from markdown or task lists using `receiptline`.  You can also publish arbitrary ESC/POS commands (e.g. images, QR codes) directly to the topic to test printing.

## Handling disconnections

* The sketch reconnects to Wi‑Fi if the connection is lost.
* It retries connecting to the MQTT broker every few seconds until successful and resubscribes to the topic.
* It attempts to reconnect to the Bluetooth printer if the link drops.  You may need to power cycle the printer if it refuses reconnection.

## Extending functionality

Because MQTT decouples the server and client, you can subscribe multiple printers to the same topic or use different topics per printer.  You can also implement acknowledgements by having the firmware publish a confirmation message to a separate topic when printing finishes.
