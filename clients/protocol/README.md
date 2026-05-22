# PrintEasy Client Protocol

PrintEasy clients all implement the same small contract:

```text
MQTT broker -> subscribed client -> raw byte write -> ESC/POS printer
```

The server publishes printer-ready ESC/POS bytes. Clients do not parse JSON, render markdown, or reinterpret text. They receive the MQTT payload as bytes and write those bytes unchanged to the configured printer transport.

## MQTT contract

| Setting | Default | Notes |
|---|---|---|
| Topic | `receipt/print` | Must match `MQTT_TOPIC` on the server. |
| QoS | `1` | The server publishes with QoS 1. Clients should subscribe with QoS 1 when supported. |
| Payload | Binary ESC/POS bytes | Not UTF-8 text and not JSON. Preserve null bytes and control bytes. |
| Reconnect | Required | Clients should reconnect to Wi-Fi/network, MQTT, and printer transport after failures. |

## Printer transport contract

Supported transport families:

* Bluetooth Classic SPP / RFCOMM, usually exposed as a serial-like stream.
* UART or USB serial adapters, for printers or printer modules with TTL/RS-232 serial input.
* Raw USB printer devices such as `/dev/usb/lp0`.
* TCP sockets for network printers, if a client implementation adds that transport.

The client should write the payload in order and flush when the platform supports flushing. For low-memory devices or flaky links, chunked writes are safer than one very large write.

## Buffer sizing

Raster jobs are much larger than plain text jobs. A client buffer that works for text can silently fail for images or rasterized markdown.

Recommended minimums:

| Client type | Recommended receive/write buffer |
|---|---:|
| Linux/Raspberry Pi | Streamed payload handling; optional write chunk size `4096` or larger. |
| ESP32 Arduino | Start around `8192` for TLS + Bluetooth Classic heap headroom; increase only if payloads are too large and memory allows. |
| ESP8266 Arduino | `8192` to `16384` if memory allows; lower `RASTER_BAND_HEIGHT` on the server if needed. |
| Pico W / Pico 2 W | Default firmware buffer `32768`; tune server raster band height if memory is tight. |

If a device drops large image jobs, reduce `RASTER_BAND_HEIGHT` on the server and retest with `/preview` or the MCP `previewReceipt` tool.

When using MQTT over TLS on microcontrollers, certificate size matters. Prefer ECDSA P-256 CA/broker certificates and avoid RSA-4096 chains, which can exhaust heap during X.509 parsing. The broker certificate must include the exact DNS name or IP address used by the client.

## Compatibility matrix

| Target | Status | Printer transports | Notes |
|---|---|---|---|
| Linux / Raspberry Pi | Supported | Serial, raw USB, Bluetooth RFCOMM | Recommended non-microcontroller bridge. |
| ESP32 Arduino | Supported | Bluetooth Classic SPP | Best microcontroller choice for Bluetooth SPP printers. |
| ESP8266 Arduino | Hardware-adaptable | UART / SoftwareSerial | No native Bluetooth; use serial printers or external serial adapters. |
| Pico W / Pico 2 W | Firmware target | Bluetooth SPP, UART serial, USB CDC serial | USB mode is CDC device output, not USB host printer output. |

## Client checklist

1. Subscribe to `MQTT_TOPIC`.
2. Treat payloads as bytes, not strings.
3. Use buffers large enough for raster jobs.
4. Reconnect after network, MQTT, and printer failures.
5. Write exactly the received bytes to the printer.
6. Log byte counts and failures so printer-side issues are diagnosable.
