/*
 * ESP32 MQTT Printer Bridge
 *
 * This reference firmware connects an ESP32 (e.g. WROOM-32 or WROOM-32U) to
 * Wi-Fi, an MQTT broker and a Bluetooth Classic SPP thermal printer. It
 * subscribes to a designated MQTT topic and forwards each incoming payload as
 * raw ESC/POS bytes. Other microcontrollers or computers can implement the
 * same MQTT-to-printer bridge contract if they can receive binary MQTT payloads
 * and write them to a printer transport such as Bluetooth SPP, USB, serial or
 * TCP.
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include "BluetoothSerial.h"
#include <time.h>
#if __has_include(<esp_arduino_version.h>)
#include <esp_arduino_version.h>
#endif

#ifndef ESP_ARDUINO_VERSION_MAJOR
#define ESP_ARDUINO_VERSION_MAJOR 2
#endif

// ==== Wi‑Fi configuration ====
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// ==== MQTT configuration ====
const char* MQTT_SERVER   = "mqtt.example.com"; // broker host or IP
#define MQTT_TLS 1                              // 1 for TLS, 0 for unencrypted
const uint16_t MQTT_PORT  = MQTT_TLS ? 8883 : 1883;
const char* MQTT_USER     = "printeasy";        // set to MQTT username or nullptr
const char* MQTT_PASS     = "change-me";        // set to MQTT password or nullptr
const char* MQTT_TOPIC    = "receipt/print";     // topic to subscribe to
#define MQTT_TLS_INSECURE 0                      // set to 1 only for TLS troubleshooting
const char MQTT_CA_CERT[] PROGMEM = R"PEM(
-----BEGIN CERTIFICATE-----
replace-with-your-printeasy-ca-certificate
-----END CERTIFICATE-----
)PEM";
const char* NTP_SERVER = "pool.ntp.org";

// ==== Printer configuration ====
// Set PRINTER_BT_USE_MAC to false if you prefer to connect by Bluetooth name.
// PRINTER_BT_NAME is ignored while PRINTER_BT_USE_MAC is true.
const char* PRINTER_BT_NAME = "TM-P60II";
const bool PRINTER_BT_USE_MAC = true;
uint8_t PRINTER_BT_MAC[6] = {0x00, 0x00, 0x00, 0x00, 0x00, 0x00};

// ==== Runtime settings ====
static const unsigned long RECONNECT_INTERVAL = 5000; // retry connections every 5 seconds
// Must fit the largest MQTT print payload. 2048 leaves much more heap for TLS
// plus Bluetooth Classic on ESP32-WROOM boards; lower the server raster band
// height if your print payloads are too large for this buffer.
static const uint16_t MQTT_BUFFER_SIZE = 2048;

#if MQTT_TLS
WiFiClientSecure wifiClient;
#else
WiFiClient wifiClient;
#endif
PubSubClient mqttClient(wifiClient);
BluetoothSerial SerialBT;

unsigned long lastReconnect = 0;
bool printerConnected = false;

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.print("Connecting to WiFi");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("WiFi connected: ");
  Serial.println(WiFi.localIP());
#if MQTT_TLS
  configTime(0, 0, NTP_SERVER);
  Serial.print("Waiting for NTP time");
  time_t now = time(nullptr);
  while (now < 1700000000) {
    delay(500);
    Serial.print(".");
    now = time(nullptr);
  }
  Serial.println();
  Serial.print("TLS time ready: ");
  Serial.println((long)now);
#if MQTT_TLS_INSECURE
  wifiClient.setInsecure();
#else
  wifiClient.setCACert(MQTT_CA_CERT);
#endif
  wifiClient.setHandshakeTimeout(30);
#endif
}

void connectPrinter() {
  if (SerialBT.connected()) {
    printerConnected = true;
    return;
  }
  printerConnected = false;
  Serial.println("Connecting to Bluetooth printer...");
  if (PRINTER_BT_USE_MAC) {
    printerConnected = SerialBT.connect(PRINTER_BT_MAC);
  } else {
    printerConnected = SerialBT.connect(PRINTER_BT_NAME);
  }
  if (printerConnected) {
    Serial.println("Printer connected");
  } else {
    Serial.println("Failed to connect printer");
  }
}

void connectMQTT() {
  if (mqttClient.connected()) return;
  Serial.println("Connecting to MQTT broker...");
  Serial.print("MQTT endpoint: ");
  Serial.print(MQTT_SERVER);
  Serial.print(":");
  Serial.println(MQTT_PORT);
  // Attempt connection
  bool ok = false;
  if (MQTT_USER && MQTT_PASS) {
    ok = mqttClient.connect("esp32-printer", MQTT_USER, MQTT_PASS);
  } else {
    ok = mqttClient.connect("esp32-printer");
  }
  if (ok) {
    Serial.println("MQTT connected");
  } else {
    Serial.print("MQTT failed, state=");
    Serial.println(mqttClient.state());
#if MQTT_TLS
    char tlsError[160];
    int tlsCode = wifiClient.lastError(tlsError, sizeof(tlsError));
    Serial.print("TLS lastError=");
    Serial.print(tlsCode);
    Serial.print(" ");
    Serial.println(tlsError);
#endif
  }
  // On successful connection, subscribe to the topic
  if (mqttClient.connected()) {
    mqttClient.subscribe(MQTT_TOPIC, 1);
  }
}

// Callback for incoming MQTT messages
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  Serial.print("Message arrived [");
  Serial.print(topic);
  Serial.print("] bytes=");
  Serial.println(length);

  connectPrinter();
  if (!printerConnected) {
    Serial.println("Printer not connected; dropping payload");
    return;
  }
  // Write raw bytes to the printer
  SerialBT.write(payload, length);
  SerialBT.flush();
  // Optionally send cut or form feed commands here if your printer supports them
}

void setup() {
  Serial.begin(115200);
  Serial.println("ESP32 MQTT Printer starting…");
  // Start Bluetooth SPP; set name for this device if needed
  if (!SerialBT.begin("ESP32-Printer-Bridge", true)) {
    Serial.println("An error occurred initializing Bluetooth");
  }
  // Some Epson printers require pairing PIN 0000 or 1234
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  SerialBT.setPin("0000", 4);
#else
  SerialBT.setPin("0000");
#endif
  // Configure MQTT client
  mqttClient.setServer(MQTT_SERVER, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(MQTT_BUFFER_SIZE);

  // Establish Wi-Fi/TLS/MQTT before connecting the printer. Bluetooth Classic
  // can fragment heap; this order has proven more reliable on WROOM-32 boards.
  connectWiFi();
  connectMQTT();
  connectPrinter();
}

void loop() {
  // Ensure Wi‑Fi connectivity
  connectWiFi();

  // Connect to MQTT broker
  if (!mqttClient.connected()) {
    unsigned long now = millis();
    if (now - lastReconnect > RECONNECT_INTERVAL) {
      lastReconnect = now;
      connectMQTT();
    }
  }
  // Maintain MQTT connection
  mqttClient.loop();

  // Keep printer connection available, but avoid doing this before MQTT/TLS
  // setup because Bluetooth Classic can reduce the largest free heap block.
  if (!printerConnected || !SerialBT.connected()) {
    connectPrinter();
  }

  delay(10);
}
