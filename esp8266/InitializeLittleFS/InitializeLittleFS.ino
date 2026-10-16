#include <LittleFS.h>

// One-time setup for a NEW, EMPTY ESP8266 LittleFS partition only.
// Flashing this sketch never formats by itself. Type the exact command
// in Serial Monitor only after confirming that no queued readings exist.
bool finished = false;

void setup() {
  Serial.begin(115200);
  Serial.setTimeout(2000);
  delay(500);
  Serial.println();
  Serial.println("LittleFS one-time initializer");

  LittleFSConfig config;
  config.setAutoFormat(false);
  if (!LittleFS.setConfig(config)) {
    Serial.println("Cannot configure LittleFS. Check ESP8266 board/core and flash layout.");
    finished = true;
    return;
  }

  if (LittleFS.begin()) {
    Serial.println("LittleFS already mounts. Refusing to format existing storage.");
    Serial.println("Flash ColdStoragePhase21.ino with the SAME flash layout.");
    LittleFS.end();
    finished = true;
    return;
  }

  Serial.println("LittleFS does not mount. It may be blank, damaged, or the wrong flash layout.");
  Serial.println("Formatting permanently erases all LittleFS files, including queued readings.");
  Serial.println("If this is a NEW/EMPTY device and you accept that loss, type:");
  Serial.println("FORMAT LITTLEFS");
  Serial.println("Use Serial Monitor at 115200 baud with Both NL & CR.");
}

void loop() {
  if (finished || !Serial.available()) return;

  String command = Serial.readStringUntil('\n');
  command.trim();
  if (command != "FORMAT LITTLEFS") {
    Serial.println("No change. Type FORMAT LITTLEFS only for confirmed empty storage.");
    return;
  }

  finished = true;  // One attempt per boot; never repeat on a stray Serial command.
  // Recheck immediately before erasure in case storage has become mountable.
  if (LittleFS.begin()) {
    Serial.println("LittleFS now mounts. Refusing to format.");
    LittleFS.end();
    return;
  }

  Serial.println("Formatting LittleFS...");
  if (!LittleFS.format()) {
    Serial.println("Format FAILED. Check board selection, flash layout, and flash hardware.");
    return;
  }
  if (!LittleFS.begin()) {
    Serial.println("Format returned success but mount FAILED. Check flash layout/hardware.");
    return;
  }
  if (!LittleFS.exists("/q") && !LittleFS.mkdir("/q")) {
    Serial.println("Mounted, but could not create /q. Storage is not ready.");
    LittleFS.end();
    return;
  }
  Serial.println("LittleFS ready: /q exists.");
  Serial.println("Now flash ColdStoragePhase21.ino with the SAME flash layout.");
  LittleFS.end();
}
