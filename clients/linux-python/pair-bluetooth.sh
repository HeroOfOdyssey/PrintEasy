#!/usr/bin/env bash
set -euo pipefail

DEVICE="/dev/rfcomm0"
CHANNEL="1"
SCAN_SECONDS="20"
NAME_FILTER=""
ADDRESS=""
NO_BIND="0"

usage() {
  cat <<'USAGE'
Usage: sudo ./pair-bluetooth.sh [options]

Options:
  --name TEXT          Prefer devices whose Bluetooth name contains TEXT.
  --address MAC        Pair/bind a known Bluetooth MAC address.
  --device PATH        RFCOMM device to bind. Default: /dev/rfcomm0.
  --channel NUMBER     RFCOMM channel. Default: 1.
  --scan-seconds N     Bluetooth scan duration. Default: 20.
  --no-bind            Pair and trust only; do not create an RFCOMM binding.
  -h, --help           Show this help.

Examples:
  sudo ./pair-bluetooth.sh --name Epson
  sudo ./pair-bluetooth.sh --device /dev/rfcomm1
  sudo ./pair-bluetooth.sh --address AA:BB:CC:DD:EE:FF
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --name)
      NAME_FILTER="${2:-}"
      shift 2
      ;;
    --address)
      ADDRESS="${2:-}"
      shift 2
      ;;
    --device)
      DEVICE="${2:-}"
      shift 2
      ;;
    --channel)
      CHANNEL="${2:-}"
      shift 2
      ;;
    --scan-seconds)
      SCAN_SECONDS="${2:-}"
      shift 2
      ;;
    --no-bind)
      NO_BIND="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo ./pair-bluetooth.sh" >&2
  exit 1
fi

for command_name in bluetoothctl timeout; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Missing required command: ${command_name}" >&2
    exit 1
  fi
done

if [ "${NO_BIND}" != "1" ] && ! command -v rfcomm >/dev/null 2>&1; then
  echo "Missing required command: rfcomm" >&2
  exit 1
fi

run_bluetoothctl() {
  bluetoothctl "$@"
}

select_device() {
  local devices
  echo "[PrintEasy] Scanning for Bluetooth devices for ${SCAN_SECONDS}s..." >&2
  run_bluetoothctl power on >/dev/null
  timeout "${SCAN_SECONDS}" bluetoothctl scan on >/dev/null 2>&1 || true
  run_bluetoothctl scan off >/dev/null 2>&1 || true

  devices="$(run_bluetoothctl devices)"
  if [ -n "${NAME_FILTER}" ]; then
    devices="$(printf '%s\n' "${devices}" | grep -i -- "${NAME_FILTER}" || true)"
  fi

  mapfile -t candidates < <(printf '%s\n' "${devices}" | awk '/^Device [0-9A-Fa-f:]{17} / {print}')

  if [ "${#candidates[@]}" -eq 0 ]; then
    echo "No Bluetooth devices found. Make sure the printer is powered on and discoverable." >&2
    if [ -n "${NAME_FILTER}" ]; then
      echo "No devices matched --name '${NAME_FILTER}'." >&2
    fi
    exit 1
  fi

  if [ "${#candidates[@]}" -eq 1 ]; then
    printf '%s\n' "${candidates[0]}" | awk '{print $2}'
    return
  fi

  if [ ! -t 0 ]; then
    echo "Multiple devices found. Re-run with --name or --address in non-interactive shells." >&2
    printf '%s\n' "${candidates[@]}" >&2
    exit 1
  fi

  echo >&2
  echo "Select the printer:" >&2
  local i
  for i in "${!candidates[@]}"; do
    printf '  %d. %s\n' "$((i + 1))" "${candidates[$i]}" >&2
  done

  local choice
  printf 'Device number: ' >&2
  read -r choice
  if ! [[ "${choice}" =~ ^[0-9]+$ ]] || [ "${choice}" -lt 1 ] || [ "${choice}" -gt "${#candidates[@]}" ]; then
    echo "Invalid selection." >&2
    exit 1
  fi

  printf '%s\n' "${candidates[$((choice - 1))]}" | awk '{print $2}'
}

if [ -z "${ADDRESS}" ]; then
  ADDRESS="$(select_device)"
fi

echo "[PrintEasy] Pairing ${ADDRESS}"
run_bluetoothctl power on >/dev/null
run_bluetoothctl agent on >/dev/null || true
run_bluetoothctl default-agent >/dev/null || true

if ! run_bluetoothctl pair "${ADDRESS}"; then
  echo
  echo "Pairing failed. If the printer requires a PIN, try pairing manually with bluetoothctl." >&2
  echo "Common ESC/POS printer PINs are 0000 and 1234." >&2
  echo "The discovered address is ${ADDRESS}." >&2
  exit 1
fi

run_bluetoothctl trust "${ADDRESS}" >/dev/null
echo "[PrintEasy] Trusted ${ADDRESS}"

if [ "${NO_BIND}" = "1" ]; then
  exit 0
fi

echo "[PrintEasy] Binding ${DEVICE} to ${ADDRESS} channel ${CHANNEL}"
rfcomm release "${DEVICE}" >/dev/null 2>&1 || true
rfcomm bind "${DEVICE}" "${ADDRESS}" "${CHANNEL}"

echo
echo "Bluetooth printer is available at ${DEVICE}."
echo "Set TRANSPORT=bluetooth and DEVICE=${DEVICE} in /etc/printeasy/client.env."
