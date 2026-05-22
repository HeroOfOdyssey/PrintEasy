# Pico W / Pico 2 W Client

This is a Raspberry Pi Pico SDK firmware target for PrintEasy. It subscribes to the MQTT print topic over Wi-Fi and writes each binary ESC/POS payload unchanged to one printer transport.

Supported build-time transports:

| Transport | Build value | Use for |
|---|---|---|
| Bluetooth Classic SPP | `-DPRINTER_TRANSPORT=bluetooth` | Mobile ESC/POS printers that expose Serial Port Profile. |
| UART serial | `-DPRINTER_TRANSPORT=serial` | TTL/serial ESC/POS modules and adapters. |
| USB CDC serial | `-DPRINTER_TRANSPORT=usb` | USB serial output to a host or adapter. This is USB device-mode, not USB host mode for raw USB printers. |

Bluetooth Classic SPP is the primary Pico path in this directory. The firmware connects as an SPP client to a configured printer address, queries SDP for the printer's RFCOMM channel when needed, buffers MQTT payload chunks, and sends them over RFCOMM as the link allows.

## Requirements

* Raspberry Pi Pico W or Pico 2 W.
* Raspberry Pi Pico SDK with submodules initialized.
* CMake and an ARM embedded toolchain.
* An MQTT broker reachable from the Pico's Wi-Fi network.
* An ESC/POS printer reachable through the selected transport.

## Build: Bluetooth Classic SPP

Get the printer MAC address from a phone, desktop Bluetooth settings, Linux `bluetoothctl devices`, or the Linux helper in `../linux-python/pair-bluetooth.sh`. Then build:

```sh
export PICO_SDK_PATH=/path/to/pico-sdk

cmake -S . -B build \
  -DWIFI_SSID="YOUR_WIFI" \
  -DWIFI_PASSWORD="YOUR_WIFI_PASSWORD" \
  -DMQTT_SERVER="192.168.1.10" \
  -DMQTT_PORT=8883 \
  -DMQTT_TLS=ON \
  -DMQTT_CA_CERT_FILE=/path/to/ca.crt \
  -DMQTT_USERNAME="printeasy" \
  -DMQTT_PASSWORD="YOUR_MQTT_TOKEN" \
  -DMQTT_TOPIC="receipt/print" \
  -DPRINTER_TRANSPORT=bluetooth \
  -DPRINTER_BT_ADDR="AA:BB:CC:DD:EE:FF" \
  -DPRINTER_BT_PIN="0000"

cmake --build build
```

The resulting UF2 is `build/printeasy_pico.uf2`.

The default board is `pico_w`. For Pico 2 W, add the board setting supported by your installed Pico SDK, for example `-DPICO_BOARD=pico2_w`.

By default, the firmware queries SDP for the printer's Serial Port Profile RFCOMM channel. If your printer requires a fixed channel, add:

```text
-DPRINTER_BT_CHANNEL=1
```

## Build: UART serial

```sh
cmake -S . -B build-serial \
  -DWIFI_SSID="YOUR_WIFI" \
  -DWIFI_PASSWORD="YOUR_WIFI_PASSWORD" \
  -DMQTT_SERVER="192.168.1.10" \
  -DPRINTER_TRANSPORT=serial \
  -DPRINTER_UART_ID=0 \
  -DPRINTER_UART_TX_PIN=0 \
  -DPRINTER_UART_RX_PIN=1 \
  -DPRINTER_BAUD=9600

cmake --build build-serial
```

Wiring:

* Pico UART TX -> printer RX.
* Pico UART RX -> printer TX if the printer exposes it; otherwise it can remain unused.
* Common ground between Pico and printer.
* Use a level shifter or interface board if the printer serial input is not 3.3 V safe.

## Build: USB CDC serial

```sh
cmake -S . -B build-usb \
  -DWIFI_SSID="YOUR_WIFI" \
  -DWIFI_PASSWORD="YOUR_WIFI_PASSWORD" \
  -DMQTT_SERVER="192.168.1.10" \
  -DPRINTER_TRANSPORT=usb

cmake --build build-usb
```

USB CDC mode emits raw ESC/POS bytes over the Pico's USB serial device. Use it when another host or adapter is consuming that byte stream. Pico W is not acting as a USB host, so this mode does not drive `/dev/usb/lp0`-style raw USB printers directly.

## Configuration

| CMake setting | Description |
|---|---|
| `WIFI_SSID`, `WIFI_PASSWORD` | Wi-Fi credentials compiled into the firmware. |
| `MQTT_SERVER`, `MQTT_PORT` | MQTT broker hostname/IP and port. Use `8883` when TLS is enabled. |
| `MQTT_TLS` | Enables MQTT over TLS when set to `ON`. |
| `MQTT_CA_CERT_FILE` | PEM CA certificate used to verify the broker when `MQTT_TLS=ON`. |
| `MQTT_TOPIC` | PrintEasy topic, default `receipt/print`. |
| `MQTT_USERNAME`, `MQTT_PASSWORD` | MQTT broker credentials. Treat `MQTT_PASSWORD` as the device access token. |
| `PRINTER_TRANSPORT` | `bluetooth`, `serial`, or `usb`. |
| `PRINTER_BT_ADDR` | Bluetooth printer MAC address for SPP mode. |
| `PRINTER_BT_PIN` | Pairing PIN, usually `0000` or `1234`. |
| `PRINTER_BT_CHANNEL` | RFCOMM channel. Use `0` to query SDP automatically. |
| `PRINTER_UART_ID` | `0` or `1` for UART serial mode. |
| `PRINTER_UART_TX_PIN`, `PRINTER_UART_RX_PIN` | GPIO pins for UART serial mode. |
| `PRINTER_BAUD` | Serial baud rate. |
| `PRINTEASY_BUFFER_SIZE` | Bytes buffered while Bluetooth/USB output catches up. Default `32768`. |

## Runtime notes

* Print jobs are binary MQTT payloads, not JSON.
* TLS verifies the broker certificate against `MQTT_CA_CERT_FILE`; the certificate must include the hostname or IP used in `MQTT_SERVER`.
* Large raster jobs can exceed microcontroller buffers. If image jobs drop or truncate, lower `RASTER_BAND_HEIGHT` on the server.
* Bluetooth SPP printers vary in pairing behavior. If pairing fails with `0000`, rebuild with `-DPRINTER_BT_PIN=1234`.
* USB CDC output shares the USB serial stream. Avoid using USB serial logging as a printer transport during production jobs.

## Validation

The firmware project is intended to compile with the Pico SDK. Hardware behavior still needs to be tested with the target printer because Bluetooth pairing, RFCOMM channel selection, UART voltage level, and printer buffer size differ by model.
