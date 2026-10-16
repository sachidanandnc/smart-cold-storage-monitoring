#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClient.h>
#include <WiFiClientSecureBearSSL.h>
#include <LittleFS.h>
#include <DHT.h>
#include <LiquidCrystal.h>
#include <ArduinoJson.h>
#include <math.h>
#include <string.h>
#include <time.h>
#include "wifi.h"

const char* WIFI_SSID = MY_WIFI_SSID;
const char* WIFI_PASSWORD = MY_WIFI_PASSWORD;

#ifndef CLOUD_API_HOST
#ifdef SERVER_HOST
#define CLOUD_API_HOST SERVER_HOST
#else
#define CLOUD_API_HOST "smart-cold-storage-monitoring.onrender.com"
#endif
#endif

#ifndef DEVICE_API_KEY
#error "Define DEVICE_API_KEY in private wifi.h (same value as Render)"
#endif

const String SERVER_URL =
  "https://" + String(CLOUD_API_HOST) + "/api/sensor-data";

BearSSL::Session cloudTlsSession;
bool cloudConfigReady = false;
const char* DEVICE_ID = "cold-storage-01";

#define DHT_PIN D5
#define DHT_TYPE DHT22
DHT dht(DHT_PIN, DHT_TYPE);

#define DOOR_PIN A0
const int DOOR_THRESHOLD = 500;

#define BUTTON_PIN D0
const uint32_t DEBOUNCE_DELAY_MS = 50;
const uint32_t DOOR_POLL_MS = 50;

// LCD: RS, Enable, D4, D5, D6, D7
LiquidCrystal lcd(D1, D2, D4, D3, D6, D7);

const uint32_t READING_INTERVAL_MS = 5000;
const uint32_t WIFI_RETRY_MS = 90000;
const uint32_t WIFI_STATUS_REPORT_MS = 15000;
const uint32_t UPLOAD_SUCCESS_GAP_MS = 250;
const uint32_t UPLOAD_RETRY_MS = 1500;
const uint32_t MAX_UPLOAD_BACKOFF_MS = 60000;
const uint32_t NTP_GRACE_MS = 15000;

const uint16_t MAX_QUEUE_FILES = 400;
const size_t QUEUE_RESERVE_BYTES = 32UL * 1024UL;
const uint32_t MAX_BACKFILL_AGE_MS =
  24UL * 60UL * 60UL * 1000UL;

bool storageReady = false;
bool sensorDataAvailable = false;
bool currentDoorClosed = true;

int currentDoorAnalog = 0;
bool doorReadAvailable = false;
uint32_t lastDoorRead = 0;

float currentTemperature = 0;
float currentHumidity = 0;
int currentScreen = 0;
const uint8_t LCD_SCREEN_COUNT = 5;

bool lastButtonState = LOW;
bool stableButtonState = LOW;
uint32_t lastButtonChange = 0;

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
uint32_t droppedReadings = 0;
uint32_t evictedReadings = 0;

bool wasWiFiConnected = false;
bool wifiDisconnectReasonPending = false;
uint8_t lastWiFiDisconnectReason = 0;

WiFiEventHandler wifiDisconnectedHandler;

enum LcdNotice {
  LCD_NOTICE_NONE,
  LCD_NOTICE_CONNECTING,
  LCD_NOTICE_CONNECTED
};

LcdNotice lcdNotice = LCD_NOTICE_NONE;
void showLCDNotice(LcdNotice notice);

uint32_t lcdNoticeUntil = 0;
uint32_t lastLcdRefresh = 0;
const uint32_t BACKEND_FRESH_MS = 30000;

enum BackendState {
  BACKEND_CHECKING,
  BACKEND_SENDING,
  BACKEND_ONLINE,
  BACKEND_RETRY,
  BACKEND_AUTH_ERROR,
  BACKEND_TLS_ERROR,
  BACKEND_BAD_ACK,
  BACKEND_CONFIG_ERROR
};

BackendState backendState = BACKEND_CHECKING;
bool backendAcknowledged = false;
uint32_t lastBackendAck = 0;
int lastHttpStatus = 0;

char lcdRows[2][17] = {{0}, {0}};

bool hasValidClock();

const char* backendLabel() {
  if (!cloudConfigReady) return "CONFIG";
  if (WiFi.status() != WL_CONNECTED) return "OFFLINE";
  if (!hasValidClock()) return "WAIT NTP";

  switch (backendState) {
    case BACKEND_SENDING: return "SENDING";
    case BACKEND_AUTH_ERROR: return "AUTH ERR";
    case BACKEND_TLS_ERROR: return "TLS ERR";
    case BACKEND_BAD_ACK: return "ACK ERR";
    case BACKEND_CONFIG_ERROR: return "CONFIG";
    case BACKEND_RETRY: return "RETRY";

    case BACKEND_ONLINE:
      return backendAcknowledged &&
             millis() - lastBackendAck < BACKEND_FRESH_MS
        ? "ONLINE" : "STALE";

    default: return "CHECKING";
  }
}

bool hasValidClock() {
  return time(nullptr) >= 1577836800;
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

        if (validJsonFile(finalPath)) {
          LittleFS.remove(path);
        } else if (LittleFS.exists(finalPath)) {
          Serial.println(
            "Invalid committed queue entry; backup preserved: " + path
          );
        } else if (validJsonFile(path)) {
          LittleFS.rename(path, finalPath);
        } else {
          Serial.println(
            "Invalid queue backup needs manual recovery: " + path
          );
        }
      }
    }
  }

  {
    Dir dir = LittleFS.openDir("/q");
    while (dir.next()) {
      String path = normalizedPath(dir.fileName());

      if (endsWith(path, ".tmp")) {
        String finalPath = path.substring(0, path.length() - 4);

        if (validJsonFile(finalPath)) {
          LittleFS.remove(path);
        } else if (LittleFS.exists(finalPath)) {
          Serial.println(
            "Invalid committed queue entry; temporary copy preserved: " +
            path
          );
        } else if (validJsonFile(path)) {
          LittleFS.rename(path, finalPath);
        } else {
          Serial.println(
            "Incomplete queue file needs manual recovery: " + path
          );
        }
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

String oldestQueuePathExcept(const String& protectedPath) {
  String oldest;
  Dir dir = LittleFS.openDir("/q");

  while (dir.next()) {
    String path = normalizedPath(dir.fileName());

    if (path.endsWith(".json") && path != protectedPath &&
        (oldest.length() == 0 || path < oldest)) {
      oldest = path;
    }
  }

  return oldest;
}

String oldestQueuePath() {
  return oldestQueuePathExcept(String());
}

bool evictQueuedReadingExcept(
  const char* reason,
  const String& protectedPath
) {
  String oldest = oldestQueuePathExcept(protectedPath);
  if (!oldest.length()) return false;

  if (!LittleFS.remove(oldest)) {
    Serial.println("QUEUE EVICTION FAILED: " + oldest);
    return false;
  }

  evictedReadings++;

  Serial.printf(
    "QUEUE %s: discarded oldest unacknowledged %s; "
    "evicted since boot=%lu\n",
    reason, oldest.c_str(), (unsigned long)evictedReadings
  );

  return true;
}

bool evictOldestQueuedReading(const char* reason) {
  return evictQueuedReadingExcept(reason, String());
}

void reportStorageSpace(const char* reason) {
  FSInfo info;

  if (!LittleFS.info(info) || info.usedBytes > info.totalBytes) {
    Serial.printf(
      "STORAGE %s: cannot read valid filesystem capacity\n", reason
    );
    return;
  }

  Serial.printf(
    "STORAGE %s: total=%lu used=%lu free=%lu "
    "block=%lu reserve=%lu bytes\n",
    reason,
    (unsigned long)info.totalBytes,
    (unsigned long)info.usedBytes,
    (unsigned long)(info.totalBytes - info.usedBytes),
    (unsigned long)info.blockSize,
    (unsigned long)QUEUE_RESERVE_BYTES
  );
}

bool ensureQueueWriteSpace(
  size_t jsonBytes,
  const String& protectedPath
) {
  for (uint16_t evictions = 0;
       evictions <= MAX_QUEUE_FILES;
       evictions++) {
    FSInfo info;

    if (!LittleFS.info(info) || info.usedBytes > info.totalBytes) {
      Serial.println("STORAGE: capacity check failed; write deferred");
      return false;
    }

    const size_t block = info.blockSize ? info.blockSize : 4096;
    const size_t reserve = max(QUEUE_RESERVE_BYTES, block * 8);
    const size_t needed =
      reserve + ((jsonBytes + block - 1) / block + 2) * block;

    if (needed > info.totalBytes) {
      reportStorageSpace("PARTITION TOO SMALL");
      return false;
    }

    if (info.totalBytes - info.usedBytes >= needed) return true;

    if (evictions == MAX_QUEUE_FILES ||
        !evictQueuedReadingExcept("SPACE RESERVE", protectedPath)) {
      reportStorageSpace("NO ROOM");
      Serial.println(
        "STORAGE: no evictable readings; active reading retained. "
        "Other files may occupy flash."
      );
      return false;
    }

    yield();
  }

  return false;
}

bool readBootSlot(const char* path, uint32_t& value) {
  File file = LittleFS.open(path, "r");
  if (!file) return false;

  String content = file.readStringUntil('\n');
  file.close();

  unsigned long number = 0, check = 0;
  if (sscanf(content.c_str(), "%lu,%lu", &number, &check) != 2) {
    return false;
  }

  if (((uint32_t)number ^ 0xA5A55A5AUL) != (uint32_t)check) {
    return false;
  }

  value = (uint32_t)number;
  return true;
}

bool advanceBootNumber() {
  uint32_t a = 0, b = 0;
  bool aValid = readBootSlot("/boot0", a);
  bool bValid = readBootSlot("/boot1", b);

  if (!aValid && !bValid && queueCount() != 0) {
    Serial.println(
      "Boot counter lost while queue has data; "
      "upload disabled to avoid duplicate IDs"
    );
    return false;
  }

  uint32_t latest =
    aValid && bValid ? max(a, b) : aValid ? a : bValid ? b : 0;

  if (latest == 0xFFFFFFFFUL) return false;
  bootNumber = latest + 1;

  const char* target =
    (!aValid || (bValid && a < b)) ? "/boot0" : "/boot1";

  File file = LittleFS.open("/boot.tmp", "w");
  if (!file) return false;

  size_t written = file.printf(
    "%lu,%lu\n",
    (unsigned long)bootNumber,
    (unsigned long)(bootNumber ^ 0xA5A55A5AUL)
  );

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

  if (LittleFS.exists(backup)) {
    if (validJsonFile(path)) {
      if (!LittleFS.remove(backup)) return false;
    } else if (!LittleFS.exists(path) && validJsonFile(backup)) {
      if (!LittleFS.rename(backup, path)) return false;
    } else {
      Serial.println("Queue backup needs recovery; write deferred: " + path);
      return false;
    }
  }

  if (!ensureQueueWriteSpace(json.length(), path)) return false;

  File file = LittleFS.open(temp, "w");
  if (!file) {
    reportStorageSpace("TEMP OPEN FAILED");
    return false;
  }

  size_t written = file.print(json);
  file.flush();
  file.close();

  if (written != json.length() || !validJsonFile(temp)) {
    LittleFS.remove(temp);
    reportStorageSpace("TEMP WRITE FAILED");
    return false;
  }

  bool replacing = LittleFS.exists(path);

  if (replacing && !LittleFS.rename(path, backup)) {
    LittleFS.remove(temp);
    reportStorageSpace("BACKUP RENAME FAILED");
    return false;
  }

  if (!LittleFS.rename(temp, path)) {
    if (replacing) LittleFS.rename(backup, path);
    Serial.println("Queue commit failed; recovery files retained: " + path);
    return false;
  }

  if (replacing) LittleFS.remove(backup);
  return true;
}

void clearLCDScreen() {
  lcd.clear();
  memset(lcdRows, 0, sizeof(lcdRows));
  lcd.setCursor(0, 0);
}

void writeLCDRow(uint8_t row, const char* text) {
  char padded[17];
  memset(padded, ' ', 16);
  padded[16] = '\0';

  size_t length = strlen(text);
  if (length > 16) length = 16;
  memcpy(padded, text, length);

  if (strcmp(lcdRows[row], padded) == 0) return;

  lcd.setCursor(0, row);
  lcd.print(padded);
  memcpy(lcdRows[row], padded, sizeof(padded));
}

void showLCDNotice(LcdNotice notice) {
  lcdNotice = notice;
  lcdNoticeUntil = millis() + 2000;

  if (notice == LCD_NOTICE_CONNECTING) {
    writeLCDRow(0, "Connecting WiFi");
    writeLCDRow(1, "Sensing active");
  } else if (notice == LCD_NOTICE_CONNECTED) {
    writeLCDRow(0, "WiFi Connected");
    writeLCDRow(1, WiFi.localIP().toString().c_str());
  }
}

void updateLCD() {
  if (lcdNotice != LCD_NOTICE_NONE) {
    if ((int32_t)(millis() - lcdNoticeUntil) < 0) return;
    lcdNotice = LCD_NOTICE_NONE;
  }
  lastLcdRefresh = millis();
  char row0[17], row1[17];
  if (currentScreen == 0) {
    if (!sensorDataAvailable) {
      writeLCDRow(0, "DHT22 waiting");
      writeLCDRow(1, "Check sensor");
      return;
    }
    snprintf(row0, sizeof(row0), "Temp: %.1f C", currentTemperature);
    snprintf(row1, sizeof(row1), "Hum : %.1f %%", currentHumidity);
  } else if (currentScreen == 1) {
    snprintf(row0, sizeof(row0), "Door Status:");
    snprintf(row1, sizeof(row1), "%s", currentDoorClosed ? "CLOSED" : "OPEN");
  } else if (currentScreen == 2) {
    snprintf(row0, sizeof(row0), "WiFi: %s",
      WiFi.status() == WL_CONNECTED ? "CONNECTED" : "OFFLINE");
    snprintf(row1, sizeof(row1), "%s",
      WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString().c_str() : "Saving offline");
  } else if (currentScreen == 3) {
    snprintf(row0, sizeof(row0), "API:%s", backendLabel());
    if (!storageReady) {
      snprintf(row1, sizeof(row1), "STORAGE ERROR");
    } else {
      uint16_t pending = queueCount();
      const char* state = pending >= MAX_QUEUE_FILES ? "FULL" :
        pending > 0 ? "WAIT" : "IDLE";
      snprintf(row1, sizeof(row1), "Q:%u/%u %s", pending, MAX_QUEUE_FILES, state);
    }
  } else {
    snprintf(row0, sizeof(row0), "Smart Cold");
    snprintf(row1, sizeof(row1), "Storage Monitor");
  }
  writeLCDRow(0, row0);
  writeLCDRow(1, row1);
}

void handleButton() {
  bool buttonState = digitalRead(BUTTON_PIN);
  uint32_t now = millis();
  if (buttonState != lastButtonState) {
    lastButtonState = buttonState;
    lastButtonChange = now;
  }
  if (now - lastButtonChange < DEBOUNCE_DELAY_MS ||
      buttonState == stableButtonState) return;
  stableButtonState = buttonState;
  if (stableButtonState == HIGH) {
    currentScreen = (currentScreen + 1) % LCD_SCREEN_COUNT;
    lcdNotice = LCD_NOTICE_NONE;
    updateLCD();
  }
}

bool readDoorClosed() {
  if (!doorReadAvailable || millis() - lastDoorRead >= DOOR_POLL_MS) {
    currentDoorAnalog = analogRead(DOOR_PIN);
    lastDoorRead = millis();
    doorReadAvailable = true;
  }

  return currentDoorAnalog < DOOR_THRESHOLD;
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

      backendState = BACKEND_CHECKING;
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
    lastWiFiAttempt = millis();

    Serial.println(
      storageReady
        ? "WiFi disconnected; readings continue into LittleFS queue"
        : "WiFi disconnected; storage is unavailable, so readings cannot be saved"
    );

    if (currentScreen >= 2) updateLCD();
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
    startWiFiJoin();
  }
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

  while (queueCount() >= MAX_QUEUE_FILES) {
    if (!evictOldestQueuedReading("LIMIT")) {
      droppedReadings++;
      Serial.println("QUEUE LIMIT: could not make room; new reading not saved");
      return false;
    }
  }

  readingNumber++;

  char id[64], filename[64];

  snprintf(
    id, sizeof(id), "esp%06X-n%08lX%08lX-b%010lu-r%06lu",
    ESP.getChipId(),
    (unsigned long)bootNonceHigh,
    (unsigned long)bootNonceLow,
    (unsigned long)bootNumber,
    (unsigned long)readingNumber
  );

  snprintf(
    filename, sizeof(filename), "/q/b%08lX-r%06lu.json",
    (unsigned long)bootNumber,
    (unsigned long)readingNumber
  );

  bool clockValid = hasValidClock();
  StaticJsonDocument<512> doc;

  doc["deviceId"] = DEVICE_ID;
  doc["readingId"] = id;
  doc["temperature"] = temperature;
  doc["humidity"] = humidity;
  doc["doorOpen"] = doorOpen;

  doc["capturedAt"] =
    clockValid ? utcString(time(nullptr)) : String();

  if (!clockValid) doc["capturedAt"] = nullptr;

  doc["timeQuality"] = clockValid ? "ntp" : "unknown";
  doc["historical"] =
    WiFi.status() != WL_CONNECTED || !clockValid || queueCount() > 0;

  doc["bootNumber"] = bootNumber;
  doc["uptimeMs"] = millis();
  doc["uptimeWraps"] = millisWrapCount;
  doc["attempted"] = false;

  if (doc.overflowed()) return false;

  String json;
  serializeJson(doc, json);

  bool saved = saveQueueJson(filename, json);

  if (!saved) {
    droppedReadings++;
    Serial.printf(
      "LittleFS write failed; new reading not queued; failed since boot=%lu\n",
      (unsigned long)droppedReadings
    );
    return false;
  }

  Serial.printf("Queued %s; pending=%u\n", id, queueCount());
  return true;
}

bool backfillCaptureTime(
  const String& path,
  StaticJsonDocument<512>& doc
) {
  if (doc["attempted"].as<bool>()) return true;

  if (doc["timeQuality"].as<String>() != "unknown" ||
      !hasValidClock()) return true;

  if (doc["bootNumber"].as<uint32_t>() != bootNumber) return true;

  if (!doc["uptimeWraps"].is<uint32_t>() ||
      doc["uptimeWraps"].as<uint32_t>() != millisWrapCount) return true;

  uint32_t age = millis() - doc["uptimeMs"].as<uint32_t>();
  if (age > MAX_BACKFILL_AGE_MS) return true;

  time_t captured = time(nullptr) - (time_t)(age / 1000);
  if (captured < 1577836800) return true;

  doc["capturedAt"] = utcString(captured);
  doc["timeQuality"] = "ntp";

  if (doc.overflowed()) return false;

  String json;
  serializeJson(doc, json);

  if (!saveQueueJson(path, json)) return false;
  return true;
}

void deferUploadAfterFailure() {
  uploadBackoffMs = min(
    max(uploadBackoffMs * 2, UPLOAD_RETRY_MS),
    MAX_UPLOAD_BACKOFF_MS
  );

  lastUploadAttempt = millis();
}

bool quarantineInvalidQueueFile(
  const String& path,
  const char* reason
) {
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
  if (!storageReady ||
      !cloudConfigReady ||
      WiFi.status() != WL_CONNECTED) return;

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

  if (payload["temperature"].isNull() ||
      payload["humidity"].isNull() ||
      !isfinite(queuedTemperature) ||
      !isfinite(queuedHumidity) ||
      queuedHumidity < 0.0f ||
      queuedHumidity > 100.0f ||
      !payload["doorOpen"].is<bool>()) {
    quarantineInvalidQueueFile(path, "invalid sensor value or door state");
    return;
  }

  if (!hasValidClock() &&
      !payload["attempted"].as<bool>() &&
      millis() - lastNtpRequest < NTP_GRACE_MS) return;

  if (!backfillCaptureTime(path, payload)) {
    Serial.println("Timestamp backfill could not be saved; upload deferred");
    deferUploadAfterFailure();
    return;
  }

  if (!payload["attempted"].as<bool>() &&
      !payload["historical"].as<bool>()) {
    bool fromEarlierBoot =
      payload["bootNumber"].as<uint32_t>() != bootNumber;

    bool crossedMillisWrap =
      !payload["uptimeWraps"].is<uint32_t>() ||
      payload["uptimeWraps"].as<uint32_t>() != millisWrapCount;

    uint32_t capturedUptime = payload["uptimeMs"].as<uint32_t>();

    bool connectionChanged = capturedUptime < connectedSinceMs;
    bool agedPastSampleInterval =
      millis() - capturedUptime >= READING_INTERVAL_MS;

    if (fromEarlierBoot ||
        crossedMillisWrap ||
        connectionChanged ||
        agedPastSampleInterval) {
      payload["historical"] = true;
      Serial.println(
        "Queued reading is now historical; live alerts will be skipped"
      );
    }
  }

  const String expectedId = payload["readingId"].as<String>();

  if (!hasValidClock()) {
    Serial.println(
      "Waiting for NTP before verified HTTPS upload; queue retained"
    );
    deferUploadAfterFailure();
    return;
  }

  static BearSSL::X509List trustAnchors(SERVER_ROOT_CA);

  if (trustAnchors.getCount() == 0) {
    backendState = BACKEND_CONFIG_ERROR;
    Serial.println("Certificate in wifi.h is not valid PEM; queue retained");
    deferUploadAfterFailure();
    return;
  }

  BearSSL::WiFiClientSecure client;
  client.setTrustAnchors(&trustAnchors);
  client.setSession(&cloudTlsSession);

  HTTPClient http;

  if (!http.begin(client, SERVER_URL)) {
    backendState = BACKEND_RETRY;
    Serial.println("HTTPS initialization failed; queue retained");
    deferUploadAfterFailure();
    return;
  }

  http.setTimeout(8000);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Key", DEVICE_API_KEY);

  bool isRetry = payload["attempted"].as<bool>();
  if (isRetry) http.addHeader("X-Queue-Retry", "true");

  if (!isRetry) {
    payload["attempted"] = true;

    if (payload.overflowed()) {
      http.end();
      return;
    }

    String committed;
    serializeJson(payload, committed);

    if (!saveQueueJson(path, committed)) {
      Serial.println("Could not record POST attempt; reading retained");
      reportStorageSpace("POST MARKER FAILED");
      http.end();
      deferUploadAfterFailure();
      return;
    }
  }

  String json;
  serializeJson(payload, json);

  Serial.println("Sending JSON:");
  Serial.println(json);

  backendState = BACKEND_SENDING;
  if (currentScreen == 3) updateLCD();

  int status = http.POST(json);
  lastHttpStatus = status;

  char tlsMessage[160] = {0};
  int tlsError =
    status < 0
      ? client.getLastSSLError(tlsMessage, sizeof(tlsMessage)) : 0;

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

    if (tlsError != 0) {
      Serial.printf("TLS error %d: %s\n", tlsError, tlsMessage);
    }
  }

  if (status != 200 && status != 201) {
    backendState =
      status == 401 || status == 403
        ? BACKEND_AUTH_ERROR
        : tlsError != 0 ? BACKEND_TLS_ERROR : BACKEND_RETRY;

    if (status == 401 || status == 403) {
      Serial.println(
        "Check private DEVICE_API_KEY against Render; never print the key."
      );
    } else if (status == 429) {
      Serial.println(
        "Backend rate limit: backing off; queued reading retained."
      );
    } else if (status >= 500) {
      Serial.println(
        "Backend unavailable or waking up: retrying with queue retained."
      );
    }

    Serial.printf(
      "POST failed (%d); retained %s\n",
      status, expectedId.c_str()
    );

    if (response.length()) {
      Serial.println(response.substring(0, 160));
    }

    deferUploadAfterFailure();
    return;
  }

  StaticJsonDocument<1024> ack;

  if (deserializeJson(ack, response) ||
      ack["success"] != true ||
      ack["ack"]["stored"] != true ||
      ack["ack"]["deviceId"].as<String>() != DEVICE_ID ||
      ack["ack"]["readingId"].as<String>() != expectedId) {
    backendState = BACKEND_BAD_ACK;
    Serial.println(
      "HTTP response lacked matching durable ACK; reading retained"
    );
    deferUploadAfterFailure();
    return;
  }

  backendAcknowledged = true;
  lastBackendAck = millis();
  backendState = BACKEND_ONLINE;

  if (!LittleFS.remove(path)) {
    Serial.println(
      "ACK received but queue delete failed; safe duplicate will retry"
    );
    deferUploadAfterFailure();
    return;
  }

  uploadBackoffMs = UPLOAD_SUCCESS_GAP_MS;
  lastUploadAttempt = millis();

  Serial.printf(
    "ACK %s; pending=%u\n",
    expectedId.c_str(), queueCount()
  );

  if (currentScreen == 3) updateLCD();
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println();
  Serial.println("================================");
  Serial.println(" SMART COLD STORAGE - CLOUD 21.1.4");
  Serial.println("================================");
  Serial.print("Reset cause: ");
  Serial.println(ESP.getResetReason());

  Serial.printf(
    "Flash size: IDE=%lu bytes, chip=%lu bytes, config=%s\n",
    (unsigned long)ESP.getFlashChipSize(),
    (unsigned long)ESP.getFlashChipRealSize(),
    ESP.checkFlashConfig()
      ? "OK" : "MISMATCH (check Tools > Flash Size)"
  );

  String configuredHost(CLOUD_API_HOST);
  String keyCheck(DEVICE_API_KEY);
  keyCheck.toLowerCase();

  cloudConfigReady =
    strlen(DEVICE_API_KEY) >= 32 &&
    keyCheck.indexOf("your_") < 0 &&
    configuredHost.length() > 0 &&
    configuredHost.indexOf('/') < 0 &&
    configuredHost.indexOf(':') < 0 &&
    configuredHost.indexOf('<') < 0 &&
    configuredHost.indexOf('>') < 0 &&
    configuredHost.indexOf(' ') < 0;

  Serial.println("Cloud endpoint: " + SERVER_URL);
  Serial.println(
    cloudConfigReady
      ? "Cloud settings: READY (key hidden)"
      : "Cloud settings: INVALID; set hostname only "
        "and a device key of at least 32 characters"
  );

  if (!cloudConfigReady) backendState = BACKEND_CONFIG_ERROR;

  dht.begin();
  pinMode(BUTTON_PIN, INPUT_PULLDOWN_16);

  lastButtonState = digitalRead(BUTTON_PIN);
  stableButtonState = lastButtonState;
  lastButtonChange = millis();

  Serial.println(
    "Wiring: page button D0 -> button -> 3V3; LCD pin 12 -> D3"
  );

  lcd.begin(16, 2);
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("Smart Cold");
  lcd.setCursor(0, 1);
  lcd.print("Storage Monitor");
  delay(2000);

  LittleFSConfig fsConfig;
  fsConfig.setAutoFormat(false);

  Serial.println(
    "LittleFS: automatic formatting OFF (queued data protected)"
  );

  bool fsConfigured = LittleFS.setConfig(fsConfig);
  Serial.printf(
    "LittleFS configuration: %s\n",
    fsConfigured ? "OK" : "FAILED"
  );

  if (!fsConfigured) {
    Serial.println(
      "Check ESP8266 core and Tools > Flash Size / FS layout"
    );
  }

  storageReady = fsConfigured && LittleFS.begin();
  Serial.printf(
    "LittleFS mount: %s\n",
    storageReady ? "OK" : "FAILED"
  );

  if (fsConfigured && !storageReady) {
    Serial.println(
      "Check the selected FS layout; initialize only a confirmed empty device"
    );
  }

  if (storageReady) {
    FSInfo fsInfo;

    if (LittleFS.info(fsInfo)) {
      Serial.printf(
        "LittleFS space: total=%lu bytes, used=%lu bytes, free=%lu bytes\n",
        (unsigned long)fsInfo.totalBytes,
        (unsigned long)fsInfo.usedBytes,
        (unsigned long)(fsInfo.totalBytes - fsInfo.usedBytes)
      );
    } else {
      Serial.println("LittleFS space: could not read capacity");
    }

    if (!LittleFS.exists("/q")) {
      storageReady = LittleFS.mkdir("/q");

      if (!storageReady) {
        Serial.println("LittleFS queue directory /q: creation FAILED");
      }
    }

    if (storageReady) recoverQueueFiles();

    if (storageReady) {
      storageReady =
        ensureQueueWriteSpace(64, String()) && advanceBootNumber();

      if (!storageReady) {
        Serial.println("LittleFS boot counter: update FAILED");
      }
    }
  }

  if (storageReady) {
    reportStorageSpace("READY");
    Serial.printf(
      "Offline storage: READY; pending readings=%u of %u file limit\n",
      queueCount(), MAX_QUEUE_FILES
    );
  } else {
    Serial.println(
      "Offline storage: UNAVAILABLE; samples are NOT saved "
      "or uploaded, even with WiFi"
    );
    Serial.println(
      "Do not format automatically: queued readings may still be recoverable"
    );
  }

  if (!WIFI_SSID ||
      !WIFI_SSID[0] ||
      strcmp(WIFI_SSID, "YOUR_WIFI_NAME") == 0 ||
      strcmp(WIFI_PASSWORD, "YOUR_WIFI_PASSWORD") == 0) {
    Serial.println(
      "WiFi setup needed: replace the example values in private wifi.h."
    );
  }

  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);

  bootNonceHigh = ESP.random();
  bootNonceLow = ESP.random();

  WiFi.setAutoReconnect(true);

  wifiDisconnectedHandler = WiFi.onStationModeDisconnected(
    [](const WiFiEventStationModeDisconnected& event) {
      lastWiFiDisconnectReason = (uint8_t)event.reason;
      wifiDisconnectReasonPending = true;
    }
  );

  startWiFiJoin();
  lastWiFiStatusReport = millis();
  lastMillisSeen = millis();
  showLCDNotice(LCD_NOTICE_CONNECTING);

  lastReading = millis() - READING_INTERVAL_MS;
}

void loop() {
  uint32_t uptimeNow = millis();

  if (uptimeNow < lastMillisSeen) millisWrapCount++;
  lastMillisSeen = uptimeNow;

  handleButton();

  bool closed = readDoorClosed();

  if (closed != currentDoorClosed) {
    currentDoorClosed = closed;
    if (currentScreen == 1) updateLCD();
  }

  maintainWiFi();

  if (
    (lcdNotice != LCD_NOTICE_NONE &&
     (int32_t)(millis() - lcdNoticeUntil) >= 0) ||
    (currentScreen >= 2 &&
     millis() - lastLcdRefresh >= 1000)
  ) {
    updateLCD();
  }

  if (millis() - lastReading >= READING_INTERVAL_MS) {
    lastReading = millis();

    float temperature = dht.readTemperature();
    float humidity = dht.readHumidity();

    bool nonFiniteReading =
      !isfinite(temperature) || !isfinite(humidity);

    bool humidityOutOfRange =
      !nonFiniteReading &&
      (humidity < 0.0f || humidity > 100.0f);

    if (nonFiniteReading || humidityOutOfRange) {
      sensorDataAvailable = false;

      if (nonFiniteReading) {
        Serial.println(
          "ERROR: DHT22 reading failed (NaN/Inf); no invalid sample queued"
        );
      } else {
        Serial.print("ERROR: DHT22 humidity out of range: ");
        Serial.print(humidity, 2);
        Serial.println(" %; no invalid sample queued");
      }

      lcdNotice = LCD_NOTICE_NONE;

      if (currentScreen == 0) {
        writeLCDRow(0, "DHT22 ERROR");
        writeLCDRow(1, "Check Sensor");
      }
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
      Serial.println(currentDoorAnalog);
      Serial.println("-------------------------------");

      enqueueReading(temperature, humidity, !currentDoorClosed);
      updateLCD();
    }
  }

  uploadOldest();
  yield();
}
