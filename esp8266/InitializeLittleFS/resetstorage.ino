#include <Arduino.h>
#include <LittleFS.h>

bool resetFinished = false;

void setup() {
  Serial.begin(115200);
  Serial.setTimeout(2000);
  delay(1000);

  Serial.println();
  Serial.println("COLD STORAGE - EXPLICIT STORAGE RESET");
  Serial.println("This deletes ALL LittleFS files and pending readings.");
  Serial.println("MongoDB records and files on your computer are unaffected.");

  LittleFSConfig config;
  config.setAutoFormat(false);

  if (!LittleFS.setConfig(config)) {
    Serial.println("ERROR: LittleFS configuration failed. Check board/core.");
    resetFinished = true;
    return;
  }

  Serial.println("Use 115200 baud and Newline or Both NL & CR.");
  Serial.println("To erase existing storage, send exactly: FORMAT LITTLEFS");
}

void loop() {
  if (resetFinished || !Serial.available()) {
    return;
  }

  String command = Serial.readStringUntil('\n');
  command.trim();

  if (command != "FORMAT LITTLEFS") {
    if (command.length()) {
      Serial.println("No change. Send: FORMAT LITTLEFS");
    }
    return;
  }

  resetFinished = true;

  Serial.println("Formatting LittleFS now. Keep USB connected...");

  LittleFS.end();

  if (!LittleFS.format()) {
    Serial.println("ERROR: format failed. Check board and flash layout.");
    return;
  }

  if (!LittleFS.begin()) {
    Serial.println("ERROR: format completed but mount failed.");
    return;
  }

  if (!LittleFS.mkdir("/q") && !LittleFS.exists("/q")) {
    Serial.println("ERROR: could not create empty queue directory.");
    LittleFS.end();
    return;
  }

  FSInfo info;

  if (LittleFS.info(info)) {
    Serial.printf(
      "Storage: total=%lu used=%lu free=%lu bytes\n",
      (unsigned long)info.totalBytes,
      (unsigned long)info.usedBytes,
      (unsigned long)(info.totalBytes - info.usedBytes)
    );
  }

  Serial.println("SUCCESS: LittleFS ready; pending readings=0.");
  Serial.println("Set Erase Flash to ONLY SKETCH before uploading main firmware.");
  Serial.println("Keep the SAME 4MB / FS:2MB flash layout.");

  LittleFS.end();
}