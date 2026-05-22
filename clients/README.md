# PrintEasy Clients

Clients subscribe to the PrintEasy MQTT topic and forward binary ESC/POS payloads to a printer. The shared protocol is documented in [`protocol/`](protocol/).

## Targets

| Client | Status | Best for | Printer transports |
|---|---|---|---|
| [`linux-python/`](linux-python/) | Supported | Raspberry Pi, mini PCs, Linux servers | Serial, raw USB, Bluetooth RFCOMM |
| [`esp32-arduino/`](esp32-arduino/) | Supported | Microcontroller Bluetooth bridge | Bluetooth Classic SPP |
| [`esp8266-arduino/`](esp8266-arduino/) | Hardware-adaptable | Low-cost Wi-Fi serial bridge | UART / SoftwareSerial |
| [`pico-w/`](pico-w/) | Firmware target | Pico W / Pico 2 W Wi-Fi bridge | Bluetooth SPP, UART serial, USB CDC serial |

All clients support MQTT username/password credentials. Linux, ESP32, ESP8266, and Pico W clients also support MQTT over TLS with a broker CA certificate; see each client README for the target-specific setup switches.

## Choosing a client

Use `linux-python/` for the easiest Raspberry Pi setup and for printers connected through USB, serial adapters, or Bluetooth RFCOMM. Use `esp32-arduino/` for a compact Bluetooth SPP printer bridge. Use `esp8266-arduino/` for a low-cost Wi-Fi microcontroller connected to a serial printer. Use `pico-w/` when you want Pico SDK firmware with Bluetooth SPP, UART serial, or USB CDC serial output.

For Bluetooth printers, ESP32 and Pico W both target Bluetooth Classic SPP. Linux/Raspberry Pi uses RFCOMM devices exposed by BlueZ.
