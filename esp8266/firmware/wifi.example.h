#ifndef WIFI_H
#define WIFI_H

#define MY_WIFI_SSID "YOUR_WIFI_NAME"
#define MY_WIFI_PASSWORD "YOUR_WIFI_PASSWORD"

// #define SERVER_IP "YOUR_LAPTOP_IP"
// #define SERVER_PORT 5000

#define CLOUD_API_HOST "<backend-name>.onrender.com"
#define DEVICE_API_KEY "your_same_render_device_api_key"

static const char SERVER_ROOT_CA[] PROGMEM = R"EOF(
-----BEGIN CERTIFICATE-----
PASTE_THE_CERTIFICATE_CONTENT_HERE
-----END CERTIFICATE-----
)EOF";

#endif
