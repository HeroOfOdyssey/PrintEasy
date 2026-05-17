# Linux / Raspberry Pi Python Client

This is the recommended non-microcontroller PrintEasy bridge. It runs on Raspberry Pi OS or general Linux, subscribes to the PrintEasy MQTT topic, and writes each binary ESC/POS payload unchanged to a printer device.

Supported transports:

* `serial` - UART or USB serial adapter, such as `/dev/ttyUSB0` or `/dev/ttyAMA0`.
* `usb` - raw USB printer device, such as `/dev/usb/lp0`.
* `bluetooth` - Bluetooth Classic SPP exposed as an RFCOMM device, such as `/dev/rfcomm0`.
* `file` - dry-run output for testing without a printer.

## Quick setup on Raspberry Pi OS

```sh
cd clients/linux-python
sudo ./setup.sh
sudo nano /etc/printeasy/client.env
sudo systemctl start printeasy-client
sudo journalctl -u printeasy-client -f
```

The installer creates:

* `/opt/printeasy/clients/linux-python/` for the daemon and virtual environment.
* `/etc/printeasy/client.env` for local configuration.
* `printeasy-client.service` as a systemd service.
* A `printeasy` system user added to `dialout`, `lp`, and `bluetooth`.

## Manual setup

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
cp printeasy-client.env.example client.env
python printeasy_client.py --config ./client.env --print-config
```

Dry-run without a printer:

```sh
TRANSPORT=file DEVICE=/tmp/printeasy-output.bin \
  python printeasy_client.py --config ./client.env --write-sample /tmp/printeasy-output.bin
```

## Configuration

Edit `/etc/printeasy/client.env` after running the setup script.

| Setting | Description |
|---|---|
| `MQTT_URL` | Broker URL, e.g. `mqtt://192.168.1.10:1883` or `mqtts://broker.example.com:8883`. |
| `MQTT_TOPIC` | Print topic, default `receipt/print`. |
| `MQTT_USER`, `MQTT_PASS` | Optional broker credentials. |
| `TRANSPORT` | `serial`, `usb`, `bluetooth`, or `file`. |
| `DEVICE` | Device path to write to, such as `/dev/ttyUSB0`, `/dev/usb/lp0`, `/dev/rfcomm0`, or a test file. |
| `SERIAL_BAUD` | Baud rate for `serial` transport. Many serial ESC/POS printers use `9600`, `19200`, or `115200`. |
| `WRITE_CHUNK_SIZE` | Bytes per write call. Keep `4096` unless a printer needs smaller chunks. |
| `RECONNECT_INTERVAL` | Daemon sleep interval while running. |
| `DRY_RUN` | When true, treats output like a file target. |

## Bluetooth RFCOMM setup

Bluetooth pairing is host-specific, so the daemon expects a ready RFCOMM device and writes to it like a serial port.

Example flow:

```sh
sudo bluetoothctl
power on
agent on
default-agent
scan on
pair AA:BB:CC:DD:EE:FF
trust AA:BB:CC:DD:EE:FF
quit
sudo rfcomm bind /dev/rfcomm0 AA:BB:CC:DD:EE:FF 1
```

Then set:

```env
TRANSPORT=bluetooth
DEVICE=/dev/rfcomm0
```

Some printers require PIN `0000` or `1234`. If `/dev/rfcomm0` disappears after reboot, create a small systemd unit or udev rule to bind it before `printeasy-client.service`.

## Raw USB setup

For printers exposed as `/dev/usb/lp0`:

```env
TRANSPORT=usb
DEVICE=/dev/usb/lp0
```

The service user must have permission to write the device. The installer adds the service user to `lp`, but udev rules may still be needed depending on the printer and distro.

## Serial setup

For USB serial adapters or GPIO UART:

```env
TRANSPORT=serial
DEVICE=/dev/ttyUSB0
SERIAL_BAUD=9600
```

The service user must have permission to write serial devices. The installer adds the service user to `dialout`.

## Troubleshooting

* If small text jobs work but images fail, lower `RASTER_BAND_HEIGHT` on the server.
* If the daemon logs MQTT connects but no print jobs arrive, verify `MQTT_TOPIC` matches the server.
* If writes fail with permission denied, check group ownership of the device path.
* If Bluetooth printing stops after reboot, rebind the RFCOMM device before starting the service.
