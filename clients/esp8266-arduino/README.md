# ESP8266 Arduino Serial Client

This is a starter PrintEasy client for ESP8266 boards. It subscribes to the MQTT print topic over Wi-Fi and writes the binary ESC/POS payload to a serial printer connection.

ESP8266 does not have native Bluetooth. Use this client for UART/serial printers or for printers connected through an external serial adapter. For Bluetooth Classic SPP printers, ESP32 or Linux/Raspberry Pi is usually a better fit.

## Hardware notes

* Use a level shifter if your printer serial input is not 3.3 V safe.
* Connect ESP8266 TX to printer RX and common ground.
* Many ESC/POS serial printers use `9600`, `19200`, or `115200` baud.
* Large raster jobs can exceed ESP8266 memory. If image jobs fail, reduce `RASTER_BAND_HEIGHT` on the server.

## Arduino dependencies

Install:

* ESP8266 board support for Arduino.
* `PubSubClient`.

The sketch uses `SoftwareSerial` for printer output. Hardware serial can be substituted if your board exposes a suitable UART.

## Configuration

Edit constants in `esp8266_mqtt_serial_printer.ino`:

| Constant | Description |
|---|---|
| `WIFI_SSID`, `WIFI_PASSWORD` | Wi-Fi credentials. |
| `MQTT_SERVER`, `MQTT_PORT` | MQTT broker host and port. |
| `MQTT_USER`, `MQTT_PASS` | Optional broker credentials. |
| `MQTT_TOPIC` | Print topic, default `receipt/print`. |
| `PRINTER_RX_PIN`, `PRINTER_TX_PIN` | SoftwareSerial pins. |
| `PRINTER_BAUD` | Printer serial baud rate. |
| `MQTT_BUFFER_SIZE` | MQTT receive buffer. Increase if memory allows; lower server raster band height if needed. |

## Status

Starter support. The protocol is straightforward, but this path should be hardware-tested with your printer and adjusted for voltage level, baud rate, and buffer size.
