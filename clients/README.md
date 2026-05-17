# PrintEasy Clients

Clients subscribe to the PrintEasy MQTT topic and forward binary ESC/POS payloads to a printer. The shared protocol is documented in [`protocol/`](protocol/).

## Targets

| Client | Status | Best for | Printer transports |
|---|---|---|---|
| [`linux-python/`](linux-python/) | Supported | Raspberry Pi, mini PCs, Linux servers | Serial, raw USB, Bluetooth RFCOMM |
| [`esp32-arduino/`](esp32-arduino/) | Supported | Microcontroller Bluetooth bridge | Bluetooth Classic SPP |
| [`esp8266-arduino/`](esp8266-arduino/) | Hardware-adaptable | Low-cost Wi-Fi serial bridge | UART / SoftwareSerial |
| [`pico-w/`](pico-w/) | Design guide | Pico W / Pico 2 W Wi-Fi serial bridge | UART serial |

## Choosing a client

Use `linux-python/` for the easiest Raspberry Pi setup and for printers connected through USB, serial adapters, or Bluetooth RFCOMM. Use `esp32-arduino/` for a compact Bluetooth SPP printer bridge. Use `esp8266-arduino/` or `pico-w/` when you specifically want a Wi-Fi microcontroller connected to a serial printer.

For Bluetooth printers, use ESP32 for an embedded bridge or Linux/Raspberry Pi for RFCOMM. Pico-family Bluetooth printer output is documented as an advanced porting path, not as the default setup.
