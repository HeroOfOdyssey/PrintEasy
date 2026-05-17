/*
 * ESP32 MQTT Printer Bridge
 *
 * This firmware connects an ESP32 (e.g. WROOM‑32 or WROOM‑32U) to a Wi‑Fi network,
 * an MQTT broker and a Bluetooth thermal printer (Epson TM‑P60II in Classic SPP
 * mode).  It subscribes to a designated MQTT topic and forwards the incoming
 * payload as raw bytes to the printer.  The firmware automatically
 * reconnects if Wi‑Fi, MQTT or the Bluetooth link drops and periodically
 * sends a newline to the printer to prevent it from sleeping.
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include "BluetoothSerial.h"

// ==== Wi‑Fi configuration ====
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// ==== MQTT configuration ====
const char* MQTT_SERVER   = "mqtt.example.com"; // broker host or IP
const uint16_t MQTT_PORT  = 1883;               // 1883 for unencrypted, 8883 for TLS
const char* MQTT_USER     = nullptr;            // set to MQTT username or nullptr
const char* MQTT_PASS     = nullptr;            // set to MQTT password or nullptr
const char* MQTT_TOPIC    = "receipt/print";     // topic to subscribe to

// ==== Printer configuration ====
const char* PRINTER_BT_NAME = "TM-P60II"; // Bluetooth device name of the Epson printer
// If you know the MAC address, you can use `connect(uint8_t[])` instead of name

// ==== Keep‑alive settings ====
static const unsigned long BT_WAKE_INTERVAL = 60000; // send wake newline every 60 seconds
static const unsigned long RECONNECT_INTERVAL = 5000; // retry connections every 5 seconds

WiFiClient wifiClient;
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
  SerialBT.setPin("0000");
  // Configure MQTT client
  mqttClient.setServer(MQTT_SERVER, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
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
