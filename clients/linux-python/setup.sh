#!/usr/bin/env sh
set -eu

SERVICE_NAME="printeasy-client"
INSTALL_DIR="${INSTALL_DIR:-/opt/printeasy/clients/linux-python}"
CONFIG_DIR="${CONFIG_DIR:-/etc/printeasy}"
USER_NAME="${USER_NAME:-printeasy}"
SOURCE_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo ./setup.sh" >&2
  exit 1
fi

echo "[PrintEasy] Installing Linux client to ${INSTALL_DIR}"

if command -v apt-get >/dev/null 2>&1; then
  apt-get update
  apt-get install -y python3 python3-venv python3-pip bluez rfkill
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y python3 python3-pip bluez
elif command -v pacman >/dev/null 2>&1; then
  pacman -Sy --noconfirm python python-pip bluez
else
  echo "No supported package manager found. Install python3, venv/pip, and bluez manually." >&2
fi

if ! id "${USER_NAME}" >/dev/null 2>&1; then
  useradd --system --home /var/lib/printeasy --create-home --shell /usr/sbin/nologin "${USER_NAME}"
fi

mkdir -p "${INSTALL_DIR}" "${CONFIG_DIR}"
cp "${SOURCE_DIR}/printeasy_client.py" "${INSTALL_DIR}/"
cp "${SOURCE_DIR}/requirements.txt" "${INSTALL_DIR}/"
cp "${SOURCE_DIR}/README.md" "${INSTALL_DIR}/"

python3 -m venv "${INSTALL_DIR}/.venv"
"${INSTALL_DIR}/.venv/bin/pip" install --upgrade pip
"${INSTALL_DIR}/.venv/bin/pip" install -r "${INSTALL_DIR}/requirements.txt"

if [ ! -f "${CONFIG_DIR}/client.env" ]; then
  cp "${SOURCE_DIR}/printeasy-client.env.example" "${CONFIG_DIR}/client.env"
  chmod 600 "${CONFIG_DIR}/client.env"
  echo "[PrintEasy] Created ${CONFIG_DIR}/client.env. Edit it before starting the service."
else
  echo "[PrintEasy] Keeping existing ${CONFIG_DIR}/client.env"
fi

sed \
  -e "s#WorkingDirectory=/opt/printeasy/clients/linux-python#WorkingDirectory=${INSTALL_DIR}#" \
  -e "s#ExecStart=/opt/printeasy/clients/linux-python/.venv/bin/python /opt/printeasy/clients/linux-python/printeasy_client.py#ExecStart=${INSTALL_DIR}/.venv/bin/python ${INSTALL_DIR}/printeasy_client.py#" \
  -e "s#User=printeasy#User=${USER_NAME}#" \
  -e "s#Group=printeasy#Group=${USER_NAME}#" \
  "${SOURCE_DIR}/printeasy-client.service" > "/etc/systemd/system/${SERVICE_NAME}.service"
chown -R "${USER_NAME}:${USER_NAME}" "${INSTALL_DIR}"
usermod -aG dialout,lp,bluetooth "${USER_NAME}" 2>/dev/null || true

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.service"

echo
echo "Install complete."
echo "1. Edit ${CONFIG_DIR}/client.env"
echo "2. Start with: sudo systemctl start ${SERVICE_NAME}"
echo "3. Check logs: sudo journalctl -u ${SERVICE_NAME} -f"
