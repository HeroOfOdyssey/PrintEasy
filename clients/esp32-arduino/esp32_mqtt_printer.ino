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
const char MQTT_CA_CERT[] PROGMEM = R"PEM(
-----BEGIN CERTIFICATE-----
replace-with-your-printeasy-ca-certificate
-----END CERTIFICATE-----
)PEM";
const char* NTP_SERVER = "pool.ntp.org";

// ==== Printer configuration ====
const char* PRINTER_BT_NAME = "TM-P60II"; // Bluetooth device name of the Epson printer
// If you know the MAC address, you can use `connect(uint8_t[])` instead of name

// ==== Keep‑alive settings ====
static const unsigned long BT_WAKE_INTERVAL = 60000; // send wake newline every 60 seconds
static const unsigned long RECONNECT_INTERVAL = 5000; // retry connections every 5 seconds
static const uint16_t MQTT_BUFFER_SIZE = 16384; // must fit the largest ESC/POS MQTT packet

#if MQTT_TLS
WiFiClientSecure wifiClient;
#else
WiFiClient wifiClient;
#endif
PubSubClient mqttClient(wifiClient);
BluetoothSerial SerialBT;

unsigned long lastWake = 0;
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
  time_t now = time(nullptr);
  while (now < 1700000000) {
    delay(500);
    now = time(nullptr);
  }
  wifiClient.setCACert(MQTT_CA_CERT);
#endif
}

void connectPrinter() {
  if (SerialBT.connected()) {
    printerConnected = true;
    return;
  }
  printerConnected = false;
  Serial.println("Connecting to Bluetooth printer...");
  // connect by name
  printerConnected = SerialBT.connect(PRINTER_BT_NAME);
  if (printerConnected) {
    Serial.println("Printer connected");
  } else {
    Serial.println("Failed to connect printer");
  }
}

void connectMQTT() {
  if (mqttClient.connected()) return;
  Serial.println("Connecting to MQTT broker...");
  // Attempt connection
  if (MQTT_USER && MQTT_PASS) {
    if (mqttClient.connect("esp32-printer", MQTT_USER, MQTT_PASS)) {
      Serial.println("MQTT connected");
    }
  } else {
    if (mqttClient.connect("esp32-printer")) {
      Serial.println("MQTT connected");
    }
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
  SerialBT.setPin("0000", 4);
  // Configure MQTT client
  mqttClient.setServer(MQTT_SERVER, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(MQTT_BUFFER_SIZE);
}

void loop() {
  // Ensure Wi‑Fi connectivity
  connectWiFi();
  // Connect to printer if not already
  connectPrinter();
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
  // Wake up printer periodically
  unsigned long now = millis();
  if (printerConnected && now - lastWake > BT_WAKE_INTERVAL) {
    lastWake = now;
    SerialBT.write('\n');
    SerialBT.flush();
  }
  delay(10);
}
