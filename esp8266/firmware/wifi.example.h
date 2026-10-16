#ifndef WIFI_H
#define WIFI_H

#define MY_WIFI_SSID "YOUR_WIFI_NAME"
#define MY_WIFI_PASSWORD "YOUR_WIFI_PASSWORD"

// For cloud deployment, uncomment and fill these in your private wifi.h.
// CLOUD_API_HOST is only the hostname, with no https:// or path.
// Paste the public root CA certificate(s) that validate this Render service.
// Never use setInsecure() or a certificate fingerprint that breaks on renewal.
// #define CLOUD_API_HOST "your-backend.onrender.com"
// #define DEVICE_API_KEY "same-long-random-secret-as-Render"
// #define SERVER_ROOT_CA R"EOF(-----BEGIN CERTIFICATE-----
// ...public root CA PEM...
// -----END CERTIFICATE-----)EOF"

// Optional local-development fallback when CLOUD_API_HOST is not defined.
#define SERVER_IP "YOUR_LAPTOP_IP"
#define SERVER_PORT 5000

#endif
