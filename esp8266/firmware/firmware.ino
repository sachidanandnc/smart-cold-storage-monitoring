#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClient.h>
#include <DHT.h>
#include <LiquidCrystal.h>

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
// A0 is used because LCD occupies most digital pins.
//
// Wiring:
//
// 3V3
//  |
// 10k resistor
//  |
//  +------ A0
//  |
// Door switch
//  |
// GND
//
// CLOSED -> A0 near 0
// OPEN   -> A0 high
// ==================================================

#define DOOR_PIN A0

// Adjust after checking actual analog values
const int DOOR_THRESHOLD = 500;


// ==================================================
// Push Button
//
// D3 ------ Button ------ GND
//
// Uses internal pull-up.
//
// IMPORTANT:
// D3 is boot-sensitive.
// Do not hold the button while powering/resetting ESP.
// ==================================================

#define BUTTON_PIN D3

int currentScreen = 0;

bool lastButtonState = HIGH;

unsigned long lastButtonPress = 0;

const unsigned long DEBOUNCE_DELAY = 200;


// ==================================================
// LCD1602
//
// LCD Pin 4  -> D1
// LCD Pin 6  -> D2
// LCD Pin 11 -> D4
// LCD Pin 12 -> D0
// LCD Pin 13 -> D6
// LCD Pin 14 -> D7
// ==================================================

LiquidCrystal lcd(
  D1,   // LCD Pin 4  - RS
  D2,   // LCD Pin 6  - Enable
  D4,   // LCD Pin 11 - D4
  D0,   // LCD Pin 12 - D0
  D6,   // LCD Pin 13 - D6
  D7    // LCD Pin 14 - D7
);


// ==================================================
// Latest Sensor Values
// ==================================================

float currentTemperature = 0.0;
float currentHumidity = 0.0;

bool currentDoorClosed = true;

bool sensorDataAvailable = false;


// ==================================================
// Sensor Reading Timing
// ==================================================

unsigned long lastReading = 0;

const unsigned long READING_INTERVAL = 5000;


// ==================================================
// Clear One LCD Row
// ==================================================

void clearLCDRow(int row) {

  lcd.setCursor(0, row);

  lcd.print("                ");
}


// ==================================================
// Clear Both LCD Rows
// ==================================================

void clearLCDScreen() {

  clearLCDRow(0);
  clearLCDRow(1);

  lcd.setCursor(0, 0);
}


// ==================================================
// Update LCD
// ==================================================

void updateLCD() {

  clearLCDScreen();


  // ==================================================
  // SCREEN 0
  // Temperature + Humidity
  // ==================================================

  if (currentScreen == 0) {

    if (!sensorDataAvailable) {

      lcd.setCursor(0, 0);
      lcd.print("Waiting for");

      lcd.setCursor(0, 1);
      lcd.print("sensor data");

      return;
    }


    lcd.setCursor(0, 0);

    lcd.print("Temp: ");
    lcd.print(currentTemperature, 1);
    lcd.print(" C");


    lcd.setCursor(0, 1);

    lcd.print("Hum : ");
    lcd.print(currentHumidity, 1);
    lcd.print(" %");
  }


  // ==================================================
  // SCREEN 1
  // Door Status
  // ==================================================

  else if (currentScreen == 1) {

    lcd.setCursor(0, 0);
    lcd.print("Door Status:");

    lcd.setCursor(0, 1);

    if (currentDoorClosed) {

      lcd.print("CLOSED");

    } else {

      lcd.print("OPEN");
    }
  }


  // ==================================================
  // SCREEN 2
  // Wi-Fi Status
  // ==================================================

  else if (currentScreen == 2) {

    if (WiFi.status() == WL_CONNECTED) {

      lcd.setCursor(0, 0);
      lcd.print("WiFi: CONNECTED");

      lcd.setCursor(0, 1);
      lcd.print(WiFi.localIP().toString());

    } else {

      lcd.setCursor(0, 0);
      lcd.print("WiFi: OFFLINE");

      lcd.setCursor(0, 1);
      lcd.print("Check Network");
    }
  }
}


// ==================================================
// Button Handling
// ==================================================

void handleButton() {

  bool buttonState = digitalRead(BUTTON_PIN);


  // Detect HIGH -> LOW transition
  if (
    buttonState == LOW &&
    lastButtonState == HIGH &&
    millis() - lastButtonPress > DEBOUNCE_DELAY
  ) {

    currentScreen++;


    // Screens:
    //
    // 0 -> Temperature/Humidity
    // 1 -> Door Status
    // 2 -> Wi-Fi Status

    if (currentScreen > 2) {

      currentScreen = 0;
    }


    lastButtonPress = millis();


    // Immediately refresh LCD

    updateLCD();
  }


  lastButtonState = buttonState;
}


// ==================================================
// Read Door Sensor
// ==================================================

bool readDoorClosed() {

  int doorValue = analogRead(DOOR_PIN);


  // LOW voltage means switch connected to GND
  // therefore door is CLOSED

  bool doorClosed =
    doorValue < DOOR_THRESHOLD;


  return doorClosed;
}


// ==================================================
// Setup
// ==================================================

void setup() {

  Serial.begin(115200);

  delay(1000);


  Serial.println();

  Serial.println("================================");
  Serial.println("   SMART COLD STORAGE");
  Serial.println("================================");


  // ==================================================
  // Initialize DHT22
  // ==================================================

  dht.begin();


  // ==================================================
  // Initialize Button
  // ==================================================

  pinMode(BUTTON_PIN, INPUT_PULLUP);


  // ==================================================
  // Initialize LCD
  // ==================================================

  lcd.begin(16, 2);

  lcd.clear();


  lcd.setCursor(0, 0);
  lcd.print("Smart Cold");

  lcd.setCursor(0, 1);
  lcd.print("Storage System");


  delay(2000);


  // ==================================================
  // Connecting to Wi-Fi Message
  // ==================================================

  lcd.clear();

  lcd.setCursor(0, 0);
  lcd.print("Connecting WiFi");

  lcd.setCursor(0, 1);
  lcd.print("Please wait");


  // ==================================================
  // Connect to Wi-Fi
  // ==================================================

  Serial.print("Connecting to WiFi");


  WiFi.begin(
    WIFI_SSID,
    WIFI_PASSWORD
  );


  while (
    WiFi.status() != WL_CONNECTED
  ) {

    delay(500);

    Serial.print(".");
  }


  Serial.println();

  Serial.println("WiFi Connected!");

  Serial.print("IP Address: ");

  Serial.println(
    WiFi.localIP()
  );


  Serial.println(
    "--------------------------------"
  );


  // ==================================================
  // Wi-Fi Connected LCD Message
  // ==================================================

  lcd.clear();

  lcd.setCursor(0, 0);
  lcd.print("WiFi Connected");

  lcd.setCursor(0, 1);
  lcd.print(
    WiFi.localIP().toString()
  );


  delay(2000);


  // ==================================================
  // Show First Normal Screen
  // ==================================================

  updateLCD();
}


// ==================================================
// Main Loop
// ==================================================

void loop() {

  // ==================================================
  // Handle Button Continuously
  // ==================================================

  handleButton();


  // ==================================================
  // Continuously Check Door
  // ==================================================

  currentDoorClosed =
    readDoorClosed();


  // ==================================================
  // Read Sensors Every 5 Seconds
  // ==================================================

  if (
    millis() - lastReading >=
    READING_INTERVAL
  ) {

    lastReading = millis();


    // ==================================================
    // Read DHT22
    // ==================================================

    float temperature =
      dht.readTemperature();

    float humidity =
      dht.readHumidity();


    // ==================================================
    // Validate DHT22 Reading
    // ==================================================

    if (
      isnan(temperature) ||
      isnan(humidity)
    ) {

      Serial.println(
        "ERROR: DHT22 reading failed"
      );


      lcd.clear();

      lcd.setCursor(0, 0);
      lcd.print("DHT22 ERROR");

      lcd.setCursor(0, 1);
      lcd.print("Check Sensor");


      sensorDataAvailable = false;

      return;
    }


    // ==================================================
    // Store Latest Readings
    // ==================================================

    currentTemperature =
      temperature;

    currentHumidity =
      humidity;

    sensorDataAvailable =
      true;


    bool doorClosed =
      currentDoorClosed;


    String doorStatus =
      doorClosed
        ? "CLOSED"
        : "OPEN";


    // ==================================================
    // Serial Monitor Output
    // ==================================================

    Serial.println();

    Serial.println(
      "--------- SENSOR DATA ---------"
    );


    Serial.print(
      "Temperature : "
    );

    Serial.print(
      temperature,
      2
    );

    Serial.println(
      " C"
    );


    Serial.print(
      "Humidity    : "
    );

    Serial.print(
      humidity,
      2
    );

    Serial.println(
      " %"
    );


    Serial.print(
      "Door        : "
    );

    Serial.println(
      doorStatus
    );


    Serial.print(
      "Door Analog : "
    );

    Serial.println(
      analogRead(DOOR_PIN)
    );


    Serial.println(
      "-------------------------------"
    );


    // ==================================================
    // Update Current LCD Screen
    // ==================================================

    updateLCD();


    // ==================================================
    // Send Data to Backend
    // ==================================================

    if (
      WiFi.status() ==
      WL_CONNECTED
    ) {

      WiFiClient client;

      HTTPClient http;


      // ==================================================
      // Connect to Backend
      // ==================================================

      http.begin(
        client,
        SERVER_URL
      );


      http.addHeader(
        "Content-Type",
        "application/json"
      );


      // ==================================================
      // Build JSON Payload
      // ==================================================

      String jsonPayload = "{";


      jsonPayload +=
        "\"temperature\":";

      jsonPayload +=
        String(
          temperature,
          2
        );


      jsonPayload += ",";


      jsonPayload +=
        "\"humidity\":";

      jsonPayload +=
        String(
          humidity,
          2
        );


      jsonPayload += ",";


      jsonPayload +=
        "\"doorOpen\":";


      jsonPayload +=
        (
          doorClosed
            ? "false"
            : "true"
        );


      jsonPayload += "}";


      // ==================================================
      // Print JSON Being Sent
      // ==================================================

      Serial.println(
        "Sending JSON:"
      );

      Serial.println(
        jsonPayload
      );


      // ==================================================
      // POST Request
      // ==================================================

      int httpResponseCode =
        http.POST(
          jsonPayload
        );


      Serial.print(
        "HTTP Response Code: "
      );


      Serial.println(
        httpResponseCode
      );


      // ==================================================
      // Backend Response
      // ==================================================

      if (
        httpResponseCode > 0
      ) {

        String response =
          http.getString();


        Serial.println(
          "Server Response:"
        );


        Serial.println(
          response
        );

      } else {

        Serial.print(
          "HTTP POST failed: "
        );


        Serial.println(
          http.errorToString(
            httpResponseCode
          )
        );
      }


      // ==================================================
      // Close HTTP Connection
      // ==================================================

      http.end();

    } else {

      Serial.println(
        "WiFi disconnected"
      );
    }
  }
}