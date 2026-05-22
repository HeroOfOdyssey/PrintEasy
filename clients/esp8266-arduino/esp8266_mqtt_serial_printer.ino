/*
 * ESP8266 MQTT Serial Printer Bridge
 *
 * Starter client for Wi-Fi MQTT -> UART/SoftwareSerial ESC/POS printers.
 * ESP8266 has no native Bluetooth, so Bluetooth printers need an external
 * serial/Bluetooth adapter or a different client target.
 */

#include <ESP8266WiFi.h>
#include <WiFiClientSecureBearSSL.h>
#include <PubSubClient.h>
#include <SoftwareSerial.h>
#include <time.h>

// ==== Wi-Fi configuration ====
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// ==== MQTT configuration ====
const char* MQTT_SERVER = "mqtt.example.com";
#define MQTT_TLS 1
const uint16_t MQTT_PORT = MQTT_TLS ? 8883 : 1883;
const char* MQTT_USER = "printeasy";
const char* MQTT_PASS = "change-me";
const char* MQTT_TOPIC = "receipt/print";
const char MQTT_CA_CERT[] PROGMEM = R"PEM(
-----BEGIN CERTIFICATE-----
replace-with-your-printeasy-ca-certificate
-----END CERTIFICATE-----
)PEM";
const char* NTP_SERVER = "pool.ntp.org";

// ==== Printer serial configuration ====
static const uint8_t PRINTER_RX_PIN = D6; // ESP8266 receives from printer, often unused
static const uint8_t PRINTER_TX_PIN = D5; // ESP8266 transmits to printer RX
static const uint32_t PRINTER_BAUD = 9600;

static const uint16_t MQTT_BUFFER_SIZE = 8192;
static const unsigned long RECONNECT_INTERVAL = 5000;

#if MQTT_TLS
BearSSL::WiFiClientSecure wifiClient;
BearSSL::X509List caCert(MQTT_CA_CERT);
#else
WiFiClient wifiClient;
#endif
PubSubClient mqttClient(wifiClient);
SoftwareSerial printerSerial(PRINTER_RX_PIN, PRINTER_TX_PIN);

unsigned long lastReconnect = 0;

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
  wifiClient.setX509Time(now);
  wifiClient.setTrustAnchors(&caCert);
#endif
}

void connectMQTT() {
  if (mqttClient.connected()) return;
  Serial.println("Connecting to MQTT broker...");
  bool ok;
  if (MQTT_USER && MQTT_PASS) {
    ok = mqttClient.connect("esp8266-printer", MQTT_USER, MQTT_PASS);
  } else {
    ok = mqttClient.connect("esp8266-printer");
  }
  if (ok) {
    Serial.println("MQTT connected");
    mqttClient.subscribe(MQTT_TOPIC, 1);
  } else {
    Serial.print("MQTT failed rc=");
    Serial.println(mqttClient.state());
  }
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  Serial.print("Message arrived [");
  Serial.print(topic);
  Serial.print("] bytes=");
  Serial.println(length);
  printerSerial.write(payload, length);
  printerSerial.flush();
}

void setup() {
  Serial.begin(115200);
  Serial.println("ESP8266 MQTT Serial Printer starting");
  printerSerial.begin(PRINTER_BAUD);
  mqttClient.setServer(MQTT_SERVER, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(MQTT_BUFFER_SIZE);
}

void loop() {
  connectWiFi();
  if (!mqttClient.connected()) {
    unsigned long now = millis();
    if (now - lastReconnect > RECONNECT_INTERVAL) {
      lastReconnect = now;
      connectMQTT();
    }
  }
  mqttClient.loop();
  delay(10);
}
