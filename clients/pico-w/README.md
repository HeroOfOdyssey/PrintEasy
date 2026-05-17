# Pico W / Pico 2 W Client Starter

This directory documents the first supported PrintEasy path for Raspberry Pi Pico W and Pico 2 W:

```text
Wi-Fi MQTT -> UART serial -> ESC/POS printer
```

Pico W and Pico 2 W have Wi-Fi-capable hardware, and current Pico-family documentation lists wireless models with Wi-Fi and Bluetooth. For PrintEasy, the practical first implementation is MQTT over Wi-Fi plus UART serial output. Bluetooth Classic SPP printer support is marked experimental/deferred because it requires deeper C SDK / BTstack work than the serial bridge path.

## Recommended implementation path

Use the Raspberry Pi Pico C/C++ SDK rather than MicroPython for the first robust version:

* Configure Wi-Fi credentials and MQTT broker settings at build time.
* Subscribe to `MQTT_TOPIC`.
* Treat MQTT payloads as binary bytes.
* Write payload chunks to UART using `uart_write_blocking`.
* Tune server `RASTER_BAND_HEIGHT` if memory is tight.

## Wiring notes

* Pico UART TX -> printer RX.
* Common ground between Pico and printer.
* Use a level shifter or interface board if the printer serial input is not 3.3 V safe.
* Confirm printer baud rate before testing large jobs.

## Configuration template

Use these values in the eventual C SDK project or MicroPython prototype:

```text
WIFI_SSID=YOUR_WIFI_SSID
WIFI_PASSWORD=YOUR_WIFI_PASSWORD
MQTT_SERVER=192.168.1.10
MQTT_PORT=1883
MQTT_TOPIC=receipt/print
UART_ID=uart0
UART_TX_PIN=0
UART_RX_PIN=1
PRINTER_BAUD=9600
WRITE_CHUNK_SIZE=1024
```

## Status

Starter documentation/scaffold only. The supported target behavior is clear, but this repo does not yet include a compiled Pico firmware project.

Bluetooth printer output on Pico-family boards is experimental/deferred. Use ESP32 for microcontroller Bluetooth SPP, or Linux/Raspberry Pi with RFCOMM, when Bluetooth printer support is required today.
