#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClient.h>
#include <DHT.h>

#include "wifi.h"

// ===============================
// WiFi
// ===============================
const char* WIFI_SSID = MY_WIFI_SSID;
const char* WIFI_PASSWORD = MY_WIFI_PASSWORD;

String SERVER_URL = "http://" + String(SERVER_IP) + ":" + String(SERVER_PORT) + "/api/sensor-data";

// ===============================
// DHT11
// ===============================
#define DHT_PIN 2
#define DHT_TYPE DHT11

DHT dht(DHT_PIN, DHT_TYPE);

// ===============================
// Door
// ===============================
#define DOOR_PIN 14

// ===============================
// Timing
// ===============================
unsigned long lastReading = 0;
const unsigned long READING_INTERVAL = 5000;

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println();
  Serial.println("================================");
  Serial.println("   SMART COLD STORAGE");
  Serial.println("================================");

  dht.begin();
  pinMode(DOOR_PIN, INPUT_PULLUP);

  Serial.print("Connecting to WiFi");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println();
  Serial.println("WiFi Connected!");
  Serial.print("IP Address: ");
  Serial.println(WiFi.localIP());
  Serial.println("--------------------------------");
}

void loop() {
  if (millis() - lastReading >= READING_INTERVAL) {
    lastReading = millis();

    float temperature = dht.readTemperature();
    float humidity = dht.readHumidity();
    bool doorClosed = digitalRead(DOOR_PIN) == LOW;

    if (isnan(temperature) || isnan(humidity)) {
      Serial.println("ERROR: DHT11 reading failed");
      return;
    }

    String doorStatus = doorClosed ? "CLOSED" : "OPEN";

    Serial.println();
    Serial.println("--------- SENSOR DATA ---------");
    Serial.print("Temperature : ");
    Serial.print(temperature);
    Serial.println(" °C");

    Serial.print("Humidity    : ");
    Serial.print(humidity);
    Serial.println(" %");

    Serial.print("Door        : ");
    Serial.println(doorStatus);
    Serial.println("-------------------------------");

    if (WiFi.status() == WL_CONNECTED) {
      WiFiClient client;
      HTTPClient http;

      http.begin(client, SERVER_URL);
      http.addHeader("Content-Type", "application/json");

      String jsonPayload = "{";
      jsonPayload += "\"temperature\":";
      jsonPayload += String(temperature, 2);
      jsonPayload += ",";
      jsonPayload += "\"humidity\":";
      jsonPayload += String(humidity, 2);
      jsonPayload += ",";
      jsonPayload += "\"doorOpen\":";
      jsonPayload += (doorClosed ? "false" : "true");
      jsonPayload += "}";

      int httpResponseCode = http.POST(jsonPayload);

      Serial.print("HTTP Response Code: ");
      Serial.println(httpResponseCode);

      if (httpResponseCode > 0) {
        String response = http.getString();
        Serial.println("Server Response:");
        Serial.println(response);
      } else {
        Serial.print("HTTP POST failed: ");
        Serial.println(http.errorToString(httpResponseCode));
      }

      http.end();
    } else {
      Serial.println("WiFi disconnected");
    }
  }
}