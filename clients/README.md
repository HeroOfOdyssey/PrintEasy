# PrintEasy Clients

Clients subscribe to the PrintEasy MQTT topic and forward binary ESC/POS payloads to a printer. The shared protocol is documented in [`protocol/`](protocol/).

## Targets

| Client | Status | Best for | Printer transports |
|---|---|---|---|
| [`linux-python/`](linux-python/) | Working core | Raspberry Pi, mini PCs, Linux servers | Serial, raw USB, Bluetooth RFCOMM |
| [`esp32-arduino/`](esp32-arduino/) | Working reference | Microcontroller Bluetooth bridge | Bluetooth Classic SPP |
| [`esp8266-arduino/`](esp8266-arduino/) | Starter | Low-cost Wi-Fi serial bridge | UART / SoftwareSerial |
| [`pico-w/`](pico-w/) | Starter docs | Pico W / Pico 2 W Wi-Fi serial bridge | UART serial |

## Choosing a client

Use `linux-python/` for the easiest Raspberry Pi setup and for printers connected through USB, serial adapters, or Bluetooth RFCOMM. Use `esp32-arduino/` for a compact Bluetooth SPP printer bridge. Use `esp8266-arduino/` or `pico-w/` when you specifically want a Wi-Fi microcontroller connected to a serial printer.

For Bluetooth printers today, prefer ESP32 or Linux/Raspberry Pi. Pico-family Bluetooth printer support is intentionally not promised yet.
