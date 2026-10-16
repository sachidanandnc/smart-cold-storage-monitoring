#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClient.h>
#include <WiFiClientSecureBearSSL.h>
#include <LittleFS.h>
#include <DHT.h>
#include <LiquidCrystal.h>
#include <ArduinoJson.h>  // ArduinoJson 6.x
#include <math.h>
#include <string.h>
#include <time.h>
#include "wifi.h"

// ==================================================
// Wi-Fi Configuration
// Copy wifi.example.h to wifi.h and fill in your own settings.
// Keep wifi.h private; it contains credentials.
// ==================================================
const char* WIFI_SSID = MY_WIFI_SSID;
const char* WIFI_PASSWORD = MY_WIFI_PASSWORD;
#ifdef CLOUD_API_HOST
#if !defined(DEVICE_API_KEY) || !defined(SERVER_ROOT_CA)
#error "Cloud uploads require DEVICE_API_KEY and SERVER_ROOT_CA in private wifi.h"
#endif
const String SERVER_URL = "https://" + String(CLOUD_API_HOST) + "/api/sensor-data";
#else
// Local development remains available with the existing private wifi.h.
const String SERVER_URL = "http://" + String(SERVER_IP) + ":" + String(SERVER_PORT) + "/api/sensor-data";
#endif
const char* DEVICE_ID = "cold-storage-01";

// ==================================================
// DHT22
// DHT22 DATA -> D5
// Bare 4-pin DHT22: pin 1 -> 3V3, pin 2 -> D5,
// pin 3 unused, pin 4 -> GND.
// Recommended: 10k pull-up resistor DATA -> 3V3.
// ==================================================
#define DHT_PIN D5
#define DHT_TYPE DHT22
DHT dht(DHT_PIN, DHT_TYPE);

// ==================================================
// Door Sensor
// A0 is used because the LCD occupies most digital pins.
// 3V3 -> 10k resistor -> A0 -> door switch -> GND
// CLOSED -> A0 near 0; OPEN -> A0 high.
// Adjust DOOR_THRESHOLD after checking actual analog values.
// ==================================================
#define DOOR_PIN A0
const int DOOR_THRESHOLD = 500;

// ==================================================
// Push Button
// D3 -> button -> GND, with the internal pull-up enabled.
// D3 is boot-sensitive: do not hold the button during reset.
// ==================================================
#define BUTTON_PIN D3
const uint32_t DEBOUNCE_DELAY_MS = 200;

// ==================================================
// LCD1602 parallel wiring
// LCD pin 4  (RS) -> D1
// LCD pin 6  (E)  -> D2
// LCD pin 11 (D4) -> D4
// LCD pin 12 (D5) -> D0
// LCD pin 13 (D6) -> D6
// LCD pin 14 (D7) -> D7
// ==================================================
LiquidCrystal lcd(D1, D2, D4, D0, D6, D7);

// ==================================================
// Reading, Wi-Fi recovery, and bounded offline queue timing
// ==================================================
const uint32_t READING_INTERVAL_MS = 5000;
// Let the ESP8266 station's automatic reconnect finish its scans first.
// This slow fallback repeats the original WiFi.begin() only if still offline.
const uint32_t WIFI_RETRY_MS = 90000;
const uint32_t WIFI_STATUS_REPORT_MS = 15000;
// Acknowledged history can drain quickly; failures still back off.
const uint32_t UPLOAD_SUCCESS_GAP_MS = 250;
const uint32_t UPLOAD_RETRY_MS = 1500;
const uint32_t MAX_UPLOAD_BACKOFF_MS = 60000;
const uint32_t NTP_GRACE_MS = 15000;
const uint16_t MAX_QUEUE_FILES = 400; // About 33 minutes at one reading / 5 s.
const uint32_t MAX_BACKFILL_AGE_MS = 24UL * 60UL * 60UL * 1000UL;

// ==================================================
// Latest sensor values, button state, and runtime state
// ==================================================
bool storageReady = false;
bool sensorDataAvailable = false;
bool currentDoorClosed = true;
float currentTemperature = 0;
float currentHumidity = 0;
int currentScreen = 0;
bool lastButtonState = HIGH;
uint32_t lastButtonPress = 0;
uint32_t lastReading = 0;
uint32_t lastWiFiAttempt = 0;
uint32_t lastWiFiStatusReport = 0;
uint32_t connectedSinceMs = 0;
uint32_t lastUploadAttempt = 0;
uint32_t uploadBackoffMs = UPLOAD_RETRY_MS;
uint32_t lastNtpRequest = 0;
uint32_t bootNumber = 0;
uint32_t readingNumber = 0;
uint32_t bootNonceHigh = 0;
uint32_t bootNonceLow = 0;
uint32_t millisWrapCount = 0;
uint32_t lastMillisSeen = 0;
uint32_t droppedReadings = 0; // Visible on Serial; resets at reboot.
uint32_t evictedReadings = 0; // Oldest unacknowledged files replaced since boot.
bool wasWiFiConnected = false;
bool wifiDisconnectReasonPending = false;
uint8_t lastWiFiDisconnectReason = 0;
WiFiEventHandler wifiDisconnectedHandler;
enum LcdNotice { LCD_NOTICE_NONE, LCD_NOTICE_CONNECTING, LCD_NOTICE_CONNECTED };
LcdNotice lcdNotice = LCD_NOTICE_NONE;
uint32_t lcdNoticeUntil = 0;

bool hasValidClock() {
  return time(nullptr) >= 1577836800; // 2020-01-01 UTC
}

String utcString(time_t epoch) {
  struct tm utc;
  gmtime_r(&epoch, &utc);
  char result[21];
  strftime(result, sizeof(result), "%Y-%m-%dT%H:%M:%SZ", &utc);
  return String(result);
}

bool endsWith(const String& text, const char* suffix) {
  return text.endsWith(suffix);
}

String normalizedPath(String name) {
  return name.startsWith("/") ? name : "/q/" + name;
}

bool validJsonFile(const String& path) {
  File file = LittleFS.open(path, "r");
  if (!file) return false;
  StaticJsonDocument<512> doc;
  DeserializationError error = deserializeJson(doc, file);
  file.close();
  return !error && doc["readingId"].is<const char*>();
}

void recoverQueueFiles() {
  {
    Dir dir = LittleFS.openDir("/q");
    while (dir.next()) {
      String path = normalizedPath(dir.fileName());
      if (endsWith(path, ".bak")) {
        String finalPath = path.substring(0, path.length() - 4);
        if (LittleFS.exists(finalPath)) LittleFS.remove(path);
        else if (validJsonFile(path)) LittleFS.rename(path, finalPath);
        else Serial.println("Invalid queue backup needs manual recovery: " + path);
      }
    }
  }
  {
    Dir dir = LittleFS.openDir("/q");
    while (dir.next()) {
      String path = normalizedPath(dir.fileName());
      if (endsWith(path, ".tmp")) {
        String finalPath = path.substring(0, path.length() - 4);
        if (LittleFS.exists(finalPath)) LittleFS.remove(path);
        else if (validJsonFile(path)) LittleFS.rename(path, finalPath);
        else Serial.println("Incomplete queue file needs manual recovery: " + path);
      }
    }
  }
}

uint16_t queueCount() {
  uint16_t count = 0;
  Dir dir = LittleFS.openDir("/q");
  while (dir.next()) {
    if (normalizedPath(dir.fileName()).endsWith(".json")) count++;
  }
  return count;
}

String oldestQueuePath() {
  String oldest;
  Dir dir = LittleFS.openDir("/q");
  while (dir.next()) {
    String path = normalizedPath(dir.fileName());
    if (path.endsWith(".json") && (oldest.length() == 0 || path < oldest)) oldest = path;
  }
  return oldest;
}

bool readBootSlot(const char* path, uint32_t& value) {
  File file = LittleFS.open(path, "r");
  if (!file) return false;
  String content = file.readStringUntil('\n');
  file.close();
  unsigned long number = 0, check = 0;
  if (sscanf(content.c_str(), "%lu,%lu", &number, &check) != 2) return false;
  if (((uint32_t)number ^ 0xA5A55A5AUL) != (uint32_t)check) return false;
  value = (uint32_t)number;
  return true;
}

bool advanceBootNumber() {
  uint32_t a = 0, b = 0;
  bool aValid = readBootSlot("/boot0", a);
  bool bValid = readBootSlot("/boot1", b);
  if (!aValid && !bValid && queueCount() != 0) {
    Serial.println("Boot counter lost while queue has data; upload disabled to avoid duplicate IDs");
    return false;
  }
  uint32_t latest = aValid && bValid ? max(a, b) : aValid ? a : bValid ? b : 0;
  if (latest == 0xFFFFFFFFUL) return false;
  bootNumber = latest + 1;
  // Replace the older slot. The newer slot stays valid if power fails mid-write.
  const char* target = (!aValid || (bValid && a < b)) ? "/boot0" : "/boot1";
  File file = LittleFS.open("/boot.tmp", "w");
  if (!file) return false;
  size_t written = file.printf("%lu,%lu\n", (unsigned long)bootNumber,
    (unsigned long)(bootNumber ^ 0xA5A55A5AUL));
  file.flush();
  file.close();
  if (written == 0) return false;
  if (LittleFS.exists(target) && !LittleFS.remove(target)) return false;
  if (!LittleFS.rename("/boot.tmp", target)) return false;
  uint32_t verified = 0;
  return readBootSlot(target, verified) && verified == bootNumber;
}

bool saveQueueJson(const String& path, const String& json) {
  String temp = path + ".tmp";
  String backup = path + ".bak";
  File file = LittleFS.open(temp, "w");
  if (!file) return false;
  size_t written = file.print(json);
  file.flush();
  file.close();
  if (written != json.length() || !validJsonFile(temp)) {
    // This attempt cannot be replayed; free its incomplete temporary file.
    LittleFS.remove(temp);
    return false;
  }
  bool replacing = LittleFS.exists(path);
  if (replacing && !LittleFS.rename(path, backup)) return false;
  if (!LittleFS.rename(temp, path)) {
    if (replacing) LittleFS.rename(backup, path);
    return false;
  }
  if (replacing) LittleFS.remove(backup);
  return true;
}

void clearLCDRow(int row) {
  lcd.setCursor(0, row);
  lcd.print("                ");
}

void clearLCDScreen() {
  clearLCDRow(0);
  clearLCDRow(1);
  lcd.setCursor(0, 0);
}

// The original startup and Wi-Fi notices last two seconds without
// blocking sensor samples or queue replay in loop().
void showLCDNotice(LcdNotice notice) {
  lcdNotice = notice;
  lcdNoticeUntil = millis() + 2000;
  clearLCDScreen();
  if (notice == LCD_NOTICE_CONNECTING) {
    lcd.print("Connecting WiFi");
    lcd.setCursor(0, 1);
    lcd.print("Please wait");
  } else if (notice == LCD_NOTICE_CONNECTED) {
    lcd.print("WiFi Connected");
    lcd.setCursor(0, 1);
    lcd.print(WiFi.localIP().toString());
  }
}

void updateLCD() {
  if (lcdNotice != LCD_NOTICE_NONE) {
    if ((int32_t)(millis() - lcdNoticeUntil) < 0) return;
    lcdNotice = LCD_NOTICE_NONE;
  }
  clearLCDScreen();
  // SCREEN 0: Temperature and humidity
  if (currentScreen == 0) {
    if (!sensorDataAvailable) {
      lcd.print("Waiting for");
      lcd.setCursor(0, 1);
      lcd.print("sensor data");
      return;
    }
    lcd.print("Temp: ");
    lcd.print(currentTemperature, 1);
    lcd.print(" C");
    lcd.setCursor(0, 1);
    lcd.print("Hum : ");
    lcd.print(currentHumidity, 1);
    lcd.print(" %");
  }
  // SCREEN 1: Door status
  else if (currentScreen == 1) {
    lcd.print("Door Status:");
    lcd.setCursor(0, 1);
    lcd.print(currentDoorClosed ? "CLOSED" : "OPEN");
  }
  // SCREEN 2: Wi-Fi status and IP address
  else if (currentScreen == 2) {
    if (WiFi.status() == WL_CONNECTED) {
      lcd.print("WiFi: CONNECTED");
      lcd.setCursor(0, 1);
      lcd.print(WiFi.localIP().toString());
    } else {
      lcd.print("WiFi: OFFLINE");
      lcd.setCursor(0, 1);
      lcd.print("Check Network");
    }
  }
}

// HIGH -> LOW edge cycles the same three screens as the original sketch.
void handleButton() {
  bool buttonState = digitalRead(BUTTON_PIN);
  if (buttonState == LOW &&
      lastButtonState == HIGH &&
      millis() - lastButtonPress > DEBOUNCE_DELAY_MS) {
    currentScreen++;
    if (currentScreen > 2) currentScreen = 0;
    lastButtonPress = millis();
    lcdNotice = LCD_NOTICE_NONE;
    updateLCD();
  }
  lastButtonState = buttonState;
}

bool readDoorClosed() {
  int doorValue = analogRead(DOOR_PIN);
  // LOW voltage means the switch is connected to GND: CLOSED.
  return doorValue < DOOR_THRESHOLD;
}

const char* wifiStatusName(wl_status_t status) {
  switch (status) {
    case WL_IDLE_STATUS: return "idle/joining";
    case WL_NO_SSID_AVAIL: return "network not found";
    case WL_SCAN_COMPLETED: return "scan completed";
    case WL_CONNECTED: return "connected";
    case WL_CONNECT_FAILED: return "connection failed";
    case WL_CONNECTION_LOST: return "connection lost";
    case WL_DISCONNECTED: return "disconnected";
    default: return "unknown";
  }
}

const char* wifiReasonHint(uint8_t reason) {
  switch (reason) {
    case REASON_AUTH_EXPIRE:
      return "Authentication timed out: check router security, signal, and whether 2.4 GHz is enabled.";
    case REASON_NO_AP_FOUND:
      return "SSID not found: check its spelling, range, and that the router/hotspot offers 2.4 GHz.";
    case REASON_AUTH_FAIL:
    case REASON_4WAY_HANDSHAKE_TIMEOUT:
    case REASON_HANDSHAKE_TIMEOUT:
      return "Authentication failed: check the password and router security settings (use WPA2, not WPA3-only).";
    case REASON_BEACON_TIMEOUT:
      return "Access point signal lost: check range and power supply.";
    default:
      return "Check the router/hotspot and power supply; the numeric reason identifies the failure.";
  }
}

void startWiFiJoin() {
  lastWiFiAttempt = millis();
  Serial.println("WiFi join requested for the configured network");
  // Never print credentials or WiFi.printDiag(): it includes the password.
  wl_status_t initialStatus = WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  if (initialStatus == WL_CONNECT_FAILED) {
    Serial.println("WiFi.begin could not start the connection; will retry later.");
  }
}

void maintainWiFi() {
  wl_status_t status = WiFi.status();
  if (status == WL_CONNECTED) {
    wifiDisconnectReasonPending = false;
    if (!wasWiFiConnected) {
      wasWiFiConnected = true;
      connectedSinceMs = millis();
      configTime(0, 0, "pool.ntp.org", "time.nist.gov");
      lastNtpRequest = millis();
      Serial.println();
      Serial.println("WiFi Connected!");
      Serial.print("IP Address: ");
      Serial.println(WiFi.localIP());
      Serial.print("Signal (RSSI): ");
      Serial.print(WiFi.RSSI());
      Serial.println(" dBm");
      Serial.println("NTP synchronization requested");
      Serial.println("--------------------------------");
      uploadBackoffMs = UPLOAD_SUCCESS_GAP_MS;
      lastUploadAttempt = millis() - UPLOAD_SUCCESS_GAP_MS;
      showLCDNotice(LCD_NOTICE_CONNECTED);
    }
    return;
  }

  if (wifiDisconnectReasonPending) {
    wifiDisconnectReasonPending = false;
    Serial.print("WiFi disconnected, reason code ");
    Serial.print(lastWiFiDisconnectReason);
    Serial.print(": ");
    Serial.println(wifiReasonHint(lastWiFiDisconnectReason));
  }
  if (wasWiFiConnected) {
    wasWiFiConnected = false;
    // Give the station's automatic reconnect a full chance before fallback.
    lastWiFiAttempt = millis();
    Serial.println(storageReady
      ? "WiFi disconnected; readings continue into LittleFS queue"
      : "WiFi disconnected; storage is unavailable, so readings cannot be saved");
    if (currentScreen == 2) updateLCD();
  }

  if (millis() - lastWiFiStatusReport >= WIFI_STATUS_REPORT_MS) {
    lastWiFiStatusReport = millis();
    Serial.print("WiFi status: ");
    Serial.print(wifiStatusName(status));
    Serial.print(" (code ");
    Serial.print((int)status);
    Serial.println("); sensor readings continue while offline.");
  }

  if (millis() - lastWiFiAttempt >= WIFI_RETRY_MS) {
    // The original sketch used WiFi.begin(ssid, password). Repeat that same
    // operation only after a long offline period, not during normal scans.
    startWiFiJoin();
  }
}

bool evictOldestQueuedReading(const char* reason) {
  String oldest = oldestQueuePath();
  if (!oldest.length()) return false;
  if (!LittleFS.remove(oldest)) {
    Serial.println("QUEUE EVICTION FAILED: " + oldest);
    return false;
  }
  evictedReadings++;
  Serial.printf("QUEUE %s: discarded oldest unacknowledged %s; evicted since boot=%lu\n",
    reason, oldest.c_str(), (unsigned long)evictedReadings);
  return true;
}

bool enqueueReading(float temperature, float humidity, bool doorOpen) {
  if (!storageReady) {
    Serial.println("STORAGE NOT READY: sample displayed only; not saved or uploaded");
    return false;
  }
  if (readingNumber >= 999999UL) {
    droppedReadings++;
    Serial.println("Reading ID limit reached for this boot");
    return false;
  }
  // Keep the newest sample when the bounded queue reaches its file limit.
  // This deliberately loses the oldest unacknowledged reading.
  while (queueCount() >= MAX_QUEUE_FILES) {
    if (!evictOldestQueuedReading("LIMIT")) {
      droppedReadings++;
      Serial.println("QUEUE LIMIT: could not make room; new reading not saved");
      return false;
    }
  }
  readingNumber++;
  char id[64], filename[64];
  // The random per-boot nonce avoids reusing a MongoDB readingId even if
  // LittleFS has been deliberately formatted since an earlier deployment.
  snprintf(id, sizeof(id), "esp%06X-n%08lX%08lX-b%010lu-r%06lu", ESP.getChipId(),
    (unsigned long)bootNonceHigh, (unsigned long)bootNonceLow,
    (unsigned long)bootNumber, (unsigned long)readingNumber);
  snprintf(filename, sizeof(filename), "/q/b%08lX-r%06lu.json",
    (unsigned long)bootNumber, (unsigned long)readingNumber);
  bool clockValid = hasValidClock();
  StaticJsonDocument<512> doc;
  doc["deviceId"] = DEVICE_ID;
  doc["readingId"] = id;
  doc["temperature"] = temperature;
  doc["humidity"] = humidity;
  doc["doorOpen"] = doorOpen;
  doc["capturedAt"] = clockValid ? utcString(time(nullptr)) : String();
  if (!clockValid) doc["capturedAt"] = nullptr;
  doc["timeQuality"] = clockValid ? "ntp" : "unknown";
  // Once older readings are waiting, this sample is part of the backlog too.
  doc["historical"] = WiFi.status() != WL_CONNECTED || !clockValid || queueCount() > 0;
  doc["bootNumber"] = bootNumber;
  doc["uptimeMs"] = millis();
  doc["uptimeWraps"] = millisWrapCount;
  doc["attempted"] = false;
  if (doc.overflowed()) return false;
  String json;
  serializeJson(doc, json);
  bool saved = saveQueueJson(filename, json);
  // Normally 400 small JSON files fit well inside a 2 MB FS. If other files
  // fill LittleFS first, replace a few oldest queued readings and retry.
  for (uint8_t tries = 0; !saved && tries < 8; tries++) {
    FSInfo info;
    if (!LittleFS.info(info) || info.totalBytes - info.usedBytes >= json.length() + 2048 ||
        !evictOldestQueuedReading("FLASH FULL")) break;
    saved = saveQueueJson(filename, json);
  }
  if (!saved) {
    droppedReadings++;
    Serial.printf("LittleFS write failed; new reading not queued; failed since boot=%lu\n",
      (unsigned long)droppedReadings);
    return false;
  }
  Serial.printf("Queued %s; pending=%u\n", id, queueCount());
  return true;
}

bool backfillCaptureTime(const String& path, StaticJsonDocument<512>& doc) {
  // A POST can succeed even when its ACK is lost. Never change a payload
  // after its first attempt, or the same readingId could conflict on retry.
  if (doc["attempted"].as<bool>()) return true;
  if (doc["timeQuality"].as<String>() != "unknown" || !hasValidClock()) return true;
  if (doc["bootNumber"].as<uint32_t>() != bootNumber) return true;
  // We only infer a capture time within the same millis() cycle. This
  // avoids inventing a recent timestamp for a sample older than 49 days.
  if (!doc["uptimeWraps"].is<uint32_t>() ||
      doc["uptimeWraps"].as<uint32_t>() != millisWrapCount) return true;
  uint32_t age = millis() - doc["uptimeMs"].as<uint32_t>();
  if (age > MAX_BACKFILL_AGE_MS) return true;
  time_t captured = time(nullptr) - (time_t)(age / 1000);
  if (captured < 1577836800) return true;
  doc["capturedAt"] = utcString(captured);
  doc["timeQuality"] = "ntp";
  // Historical remains true because this reading was captured before sync.
  if (doc.overflowed()) return false;
  String json;
  serializeJson(doc, json);
  if (!saveQueueJson(path, json)) return false;
  return true;
}

void deferUploadAfterFailure() {
  // A missing backend must not monopolize loop() with a blocking HTTP
  // attempt every 1.5 seconds. Retries grow to at most one per minute.
  uploadBackoffMs = min(max(uploadBackoffMs * 2, UPLOAD_RETRY_MS), MAX_UPLOAD_BACKOFF_MS);
  lastUploadAttempt = millis();
}

bool quarantineInvalidQueueFile(const String& path, const char* reason) {
  // Keep the bytes for inspection, but let later valid readings replay.
  // The .bad suffix also keeps this entry out of the .json FIFO scan.
  String badPath = path + ".bad";
  if (LittleFS.exists(badPath) || !LittleFS.rename(path, badPath)) {
    Serial.println("Could not quarantine invalid queue entry: " + path);
    return false;
  }
  Serial.print("Invalid queue entry quarantined (no server ACK): ");
  Serial.print(badPath);
  Serial.print("; reason: ");
  Serial.println(reason);
  return true;
}

void uploadOldest() {
  if (!storageReady || WiFi.status() != WL_CONNECTED) return;
  if (millis() - lastUploadAttempt < uploadBackoffMs) return;
  lastUploadAttempt = millis();
  String path = oldestQueuePath();
  if (!path.length()) return;
  File file = LittleFS.open(path, "r");
  if (!file) return;
  StaticJsonDocument<512> payload;
  DeserializationError error = deserializeJson(payload, file);
  file.close();
  if (error || !payload["readingId"].is<const char*>()) {
    quarantineInvalidQueueFile(path, "invalid JSON or readingId");
    return;
  }
  float queuedTemperature = payload["temperature"].as<float>();
  float queuedHumidity = payload["humidity"].as<float>();
  if (payload["temperature"].isNull() || payload["humidity"].isNull() ||
      !isfinite(queuedTemperature) || !isfinite(queuedHumidity) ||
      queuedHumidity < 0.0f || queuedHumidity > 100.0f ||
      !payload["doorOpen"].is<bool>()) {
    quarantineInvalidQueueFile(path, "invalid sensor value or door state");
    return;
  }
  // Give NTP a short chance to timestamp samples captured before Wi-Fi
  // arrived. If NTP never becomes available, upload with unknown time.
  if (!hasValidClock() && !payload["attempted"].as<bool>() &&
      millis() - lastNtpRequest < NTP_GRACE_MS) return;
  if (!backfillCaptureTime(path, payload)) {
    Serial.println("Timestamp backfill could not be saved; upload deferred");
    deferUploadAfterFailure();
    return;
  }
  // A reading that has never been POSTed may still become historical while
  // sitting in LittleFS. Decide that before the first attempt is persisted:
  // retries must use the same payload even if an ACK is lost.
  if (!payload["attempted"].as<bool>() && !payload["historical"].as<bool>()) {
    bool fromEarlierBoot = payload["bootNumber"].as<uint32_t>() != bootNumber;
    bool crossedMillisWrap = !payload["uptimeWraps"].is<uint32_t>() ||
      payload["uptimeWraps"].as<uint32_t>() != millisWrapCount;
    uint32_t capturedUptime = payload["uptimeMs"].as<uint32_t>();
    bool connectionChanged = capturedUptime < connectedSinceMs;
    bool agedPastSampleInterval = millis() - capturedUptime >= READING_INTERVAL_MS;
    if (fromEarlierBoot || crossedMillisWrap || connectionChanged || agedPastSampleInterval) {
      payload["historical"] = true;
      Serial.println("Queued reading is now historical; live alerts will be skipped");
    }
  }
  const String expectedId = payload["readingId"].as<String>();
#ifdef CLOUD_API_HOST
  // Certificate dates cannot be verified until NTP has synchronized.
  if (!hasValidClock()) {
    Serial.println("Waiting for NTP before verified HTTPS upload; queue retained");
    deferUploadAfterFailure();
    return;
  }
  BearSSL::X509List trustAnchors(SERVER_ROOT_CA);
  BearSSL::WiFiClientSecure client;
  client.setTrustAnchors(&trustAnchors);
#else
  WiFiClient client;
#endif
  HTTPClient http;
  if (!http.begin(client, SERVER_URL)) {
    deferUploadAfterFailure();
    return;
  }
  http.setTimeout(8000);
  http.addHeader("Content-Type", "application/json");
#ifdef CLOUD_API_HOST
  http.addHeader("X-Device-Key", DEVICE_API_KEY);
#endif
  bool isRetry = payload["attempted"].as<bool>();
  if (isRetry) http.addHeader("X-Queue-Retry", "true");
  if (!isRetry) {
    payload["attempted"] = true;
    if (payload.overflowed()) { http.end(); return; }
    String committed;
    serializeJson(payload, committed);
    if (!saveQueueJson(path, committed)) {
      Serial.println("Could not record POST attempt; reading retained");
      http.end();
      deferUploadAfterFailure();
      return;
    }
  }
  String json;
  serializeJson(payload, json);
  Serial.println("Sending JSON:");
  Serial.println(json);
  int status = http.POST(json);
  String response = status > 0 ? http.getString() : String();
  http.end();
  Serial.print("HTTP Response Code: ");
  Serial.println(status);
  if (status > 0) {
    Serial.println("Server Response:");
    Serial.println(response);
  } else {
    Serial.print("HTTP POST failed: ");
    Serial.println(http.errorToString(status));
  }
  if (status != 200 && status != 201) {
    Serial.printf("POST failed (%d); retained %s\n", status, expectedId.c_str());
    if (response.length()) Serial.println(response.substring(0, 160));
    deferUploadAfterFailure();
    return;
  }
  StaticJsonDocument<1024> ack;
  if (deserializeJson(ack, response) || ack["success"] != true ||
      ack["ack"]["stored"] != true ||
      ack["ack"]["deviceId"].as<String>() != DEVICE_ID ||
      ack["ack"]["readingId"].as<String>() != expectedId) {
    Serial.println("HTTP response lacked matching durable ACK; reading retained");
    deferUploadAfterFailure();
    return;
  }
  if (!LittleFS.remove(path)) {
    Serial.println("ACK received but queue delete failed; safe duplicate will retry");
    deferUploadAfterFailure();
    return;
  }
  uploadBackoffMs = UPLOAD_SUCCESS_GAP_MS;
  lastUploadAttempt = millis();
  Serial.printf("ACK %s; pending=%u\n", expectedId.c_str(), queueCount());
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println();
  Serial.println("================================");
  Serial.println("   SMART COLD STORAGE");
  Serial.println("================================");
  Serial.print("Reset cause: ");
  Serial.println(ESP.getResetReason());
  Serial.printf("Flash size: IDE=%lu bytes, chip=%lu bytes, config=%s\n",
                (unsigned long)ESP.getFlashChipSize(),
                (unsigned long)ESP.getFlashChipRealSize(),
                ESP.checkFlashConfig() ? "OK" : "MISMATCH (check Tools > Flash Size)");

  // Initialize DHT22 and the original D3 button.
  dht.begin();
  pinMode(BUTTON_PIN, INPUT_PULLUP);

  // Original startup LCD message.
  lcd.begin(16, 2);
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("Smart Cold");
  lcd.setCursor(0, 1);
  lcd.print("Storage System");
  delay(2000);

  // LittleFS must never auto-format on a failed mount: the queue could
  // contain data that has not yet been acknowledged by the server.
  LittleFSConfig fsConfig;
  fsConfig.setAutoFormat(false); // Core default can format a failed mount.
  Serial.println("LittleFS: automatic formatting OFF (queued data protected)");
  bool fsConfigured = LittleFS.setConfig(fsConfig);
  Serial.printf("LittleFS configuration: %s\n", fsConfigured ? "OK" : "FAILED");
  if (!fsConfigured) {
    Serial.println("Check ESP8266 core and Tools > Flash Size / FS layout");
  }
  storageReady = fsConfigured && LittleFS.begin();
  Serial.printf("LittleFS mount: %s\n", storageReady ? "OK" : "FAILED");
  if (fsConfigured && !storageReady) {
    Serial.println("Check the selected FS layout; initialize only a confirmed empty device");
  }
  if (storageReady) {
    FSInfo fsInfo;
    if (LittleFS.info(fsInfo)) {
      Serial.printf("LittleFS space: total=%lu bytes, used=%lu bytes, free=%lu bytes\n",
                    (unsigned long)fsInfo.totalBytes,
                    (unsigned long)fsInfo.usedBytes,
                    (unsigned long)(fsInfo.totalBytes - fsInfo.usedBytes));
    } else {
      Serial.println("LittleFS space: could not read capacity");
    }
    if (!LittleFS.exists("/q")) {
      storageReady = LittleFS.mkdir("/q");
      if (!storageReady) Serial.println("LittleFS queue directory /q: creation FAILED");
    }
    if (storageReady) recoverQueueFiles();
    if (storageReady) {
      storageReady = advanceBootNumber();
      if (!storageReady) Serial.println("LittleFS boot counter: update FAILED");
    }
  }
  if (storageReady) {
    Serial.printf("Offline storage: READY; pending readings=%u of %u file limit\n",
                  queueCount(), MAX_QUEUE_FILES);
  } else {
    Serial.println("Offline storage: UNAVAILABLE; samples are NOT saved or uploaded, even with WiFi");
    Serial.println("Do not format automatically: queued readings may still be recoverable");
  }

  // Start Wi-Fi without the original while(disconnected) loop. An offline
  // startup must still take sensor readings and save them to LittleFS.
  if (!WIFI_SSID || !WIFI_SSID[0] ||
      strcmp(WIFI_SSID, "YOUR_WIFI_NAME") == 0 ||
      strcmp(WIFI_PASSWORD, "YOUR_WIFI_PASSWORD") == 0) {
    Serial.println("WiFi setup needed: replace the example values in private wifi.h.");
  }
  WiFi.mode(WIFI_STA);
  WiFi.persistent(false); // Retries must not write credentials to flash repeatedly.
  bootNonceHigh = ESP.random();
  bootNonceLow = ESP.random();
  // Match the original sketch's station behavior: let the Wi-Fi stack retry.
  // The foreground loop remains free to collect readings during startup.
  WiFi.setAutoReconnect(true);
  wifiDisconnectedHandler = WiFi.onStationModeDisconnected(
      [](const WiFiEventStationModeDisconnected& event) {
        lastWiFiDisconnectReason = (uint8_t)event.reason;
        wifiDisconnectReasonPending = true;
      });
  startWiFiJoin();
  lastWiFiStatusReport = millis();
  lastMillisSeen = millis();
  showLCDNotice(LCD_NOTICE_CONNECTING);
  lastReading = millis() - READING_INTERVAL_MS; // Sample immediately, even offline.
}

void loop() {
  uint32_t uptimeNow = millis();
  if (uptimeNow < lastMillisSeen) millisWrapCount++;
  lastMillisSeen = uptimeNow;
  // Keep button and door sensing active even while Wi-Fi is unavailable.
  handleButton();
  bool closed = readDoorClosed();
  if (closed != currentDoorClosed) {
    currentDoorClosed = closed;
    if (currentScreen == 1) updateLCD();
  }
  maintainWiFi();
  if (lcdNotice != LCD_NOTICE_NONE &&
      (int32_t)(millis() - lcdNoticeUntil) >= 0) updateLCD();

  // Read DHT22 every five seconds, as in the original sketch.
  if (millis() - lastReading >= READING_INTERVAL_MS) {
    lastReading = millis();
    float temperature = dht.readTemperature();
    float humidity = dht.readHumidity();
    bool nonFiniteReading = !isfinite(temperature) || !isfinite(humidity);
    bool humidityOutOfRange = !nonFiniteReading && (humidity < 0.0f || humidity > 100.0f);
    if (nonFiniteReading || humidityOutOfRange) {
      sensorDataAvailable = false;
      if (nonFiniteReading) {
        Serial.println("ERROR: DHT22 reading failed (NaN/Inf); no invalid sample queued");
      } else {
        Serial.print("ERROR: DHT22 humidity out of range: ");
        Serial.print(humidity, 2);
        Serial.println(" %; no invalid sample queued");
      }
      lcdNotice = LCD_NOTICE_NONE;
      lcd.clear();
      lcd.setCursor(0, 0);
      lcd.print("DHT22 ERROR");
      lcd.setCursor(0, 1);
      lcd.print("Check Sensor");
    } else {
      currentTemperature = temperature;
      currentHumidity = humidity;
      sensorDataAvailable = true;
      String doorStatus = currentDoorClosed ? "CLOSED" : "OPEN";
      Serial.println();
      Serial.println("--------- SENSOR DATA ---------");
      Serial.print("Temperature : ");
      Serial.print(temperature, 2);
      Serial.println(" C");
      Serial.print("Humidity    : ");
      Serial.print(humidity, 2);
      Serial.println(" %");
      Serial.print("Door        : ");
      Serial.println(doorStatus);
      Serial.print("Door Analog : ");
      Serial.println(analogRead(DOOR_PIN));
      Serial.println("-------------------------------");
      enqueueReading(temperature, humidity, !currentDoorClosed);
      updateLCD();
    }
  }
  uploadOldest();
  yield();
}
