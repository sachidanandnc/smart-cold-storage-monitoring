#include <ESP8266WiFi.h>

#include <ESP8266HTTPClient.h>

#include <WiFiClient.h>

#include <DHT.h>

#include <LiquidCrystal.h>
#include <LittleFS.h>
#include <time.h>



#include "wifi.h"





// ==================================================

// Wi-Fi Configuration

// ==================================================



const char* WIFI_SSID = MY_WIFI_SSID;

const char* WIFI_PASSWORD = MY_WIFI_PASSWORD;



String SERVER_URL =

  "http://" + String(SERVER_IP) +

  ":" + String(SERVER_PORT) +

  "/api/sensor-data";





// ==================================================

// DHT22

//

// DHT22 DATA -> D5

//

// Bare 4-pin DHT22:

//

// Pin 1 -> 3V3

// Pin 2 -> D5

// Pin 3 -> Not connected

// Pin 4 -> GND

//

// Recommended:

// 10k resistor between DATA and 3V3

// ==================================================



#define DHT_PIN D5

#define DHT_TYPE DHT22



DHT dht(DHT_PIN, DHT_TYPE);





// ==================================================

// Door Sensor

//
