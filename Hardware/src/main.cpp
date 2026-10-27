#include <Arduino.h>
#include <Wire.h>
#include <U8g2lib.h>
#include <string.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// ==================================================
// VOLTEX - SMART MULTIMETER
// ESP32 DevKit V1 + 128x64 OLED + ADS1115 + LM35
// ==================================================

#define SDA_PIN 21
#define SCL_PIN 22
#define MODE_BUTTON_PIN 25
#define HOLD_BUTTON_PIN 26
#define LM35_PIN 34

U8G2_SSD1306_128X64_NONAME_F_HW_I2C oled(
    U8G2_R0, U8X8_PIN_NONE
);

// ==================================================
// MEASUREMENT MODES
// ==================================================

enum Mode {
    MODE_STANDBY,
    MODE_VOLTAGE,
    MODE_RESISTANCE,
    MODE_CONTINUITY,
    MODE_TEMPERATURE,
    MODE_OFF,
    MODE_COUNT
};

// Power-up starts in OFF after the startup animation. A short MODE press wakes to STANDBY.
Mode currentMode = MODE_OFF;

bool holdEnabled = false;
bool bleStateChanged = false; // State changes are redrawn safely from loop().
float liveTemperature = 0.0f;
float heldTemperature = 0.0f;

bool adsFound = false;
uint8_t adsAddress = 0;

// ==================================================
// STANDBY / OFF DISPLAY STATE
// ==================================================

uint8_t offScreenPage = 0;
uint32_t lastOffScreenChange = 0;

const uint32_t MODE_LONG_PRESS_MS = 3000;
bool modeRawLast = HIGH;
bool modeStablePressed = false;
uint32_t modeRawChangedAt = 0;
uint32_t modePressedAt = 0;
bool modeLongPressHandled = false;

// ==================================================
// BUTTON DEBOUNCE
// ==================================================

struct Button {
    uint8_t pin;
    bool lastRaw;
    bool stable;
    uint32_t lastChange;
};

Button modeButton = {MODE_BUTTON_PIN, HIGH, HIGH, 0};
Button holdButton = {HOLD_BUTTON_PIN, HIGH, HIGH, 0};

uint32_t lastSensorRead = 0;
uint32_t lastDisplayUpdate = 0;

// ==================================================
// MODE NAME HELPER
// ==================================================

const char* getModeName(Mode mode) {
    switch (mode) {
        case MODE_STANDBY:     return "STANDBY";
        case MODE_VOLTAGE:     return "V DC";
        case MODE_RESISTANCE:  return "RESISTANCE";
        case MODE_CONTINUITY:  return "CONTINUITY";
        case MODE_TEMPERATURE: return "TEMPERATURE";
        case MODE_OFF:         return "OFF";
        default:               return "UNKNOWN";
    }
}

// ==================================================
// BUTTON HANDLING
// ==================================================

bool wasPressed(Button &button) {
    bool raw = digitalRead(button.pin);
    uint32_t now = millis();

    if (raw != button.lastRaw) {
        button.lastRaw = raw;
        button.lastChange = now;
    }

    if ((uint32_t)(now - button.lastChange) >= 35 &&
        raw != button.stable) {

        button.stable = raw;

        // INPUT_PULLUP: LOW means pressed
        if (button.stable == LOW) {
            return true;
        }
    }

    return false;
}

// MODE button: short press cycles modes; holding for 3 seconds enters OFF.
// The stable-state debounce is handled separately from the HOLD button helper.
void pollModeButton() {
    const bool raw = digitalRead(MODE_BUTTON_PIN);
    const uint32_t now = millis();

    if (raw != modeRawLast) {
        modeRawLast = raw;
        modeRawChangedAt = now;
    }

    if ((uint32_t)(now - modeRawChangedAt) >= 35 && raw == LOW && !modeStablePressed) {
        modeStablePressed = true;
        modePressedAt = now;
        modeLongPressHandled = false;
    }

    if (modeStablePressed && raw == LOW && !modeLongPressHandled &&
        (uint32_t)(now - modePressedAt) >= MODE_LONG_PRESS_MS) {
        modeLongPressHandled = true;
        currentMode = MODE_OFF;
        holdEnabled = false;
        bleStateChanged = true;
        Serial.println("MODE button held 3 seconds: OFF");
    }

    if ((uint32_t)(now - modeRawChangedAt) >= 35 && raw == HIGH && modeStablePressed) {
        modeStablePressed = false;
        if (!modeLongPressHandled) {
            // A short press wakes OFF into STANDBY. After TEMPERATURE,
            // return to STANDBY; from STANDBY, begin the measurement cycle.
            if (currentMode == MODE_OFF) {
                currentMode = MODE_STANDBY;
            } else if (currentMode == MODE_TEMPERATURE) {
                currentMode = MODE_STANDBY;
            } else if (currentMode == MODE_STANDBY) {
                currentMode = MODE_VOLTAGE;
            } else {
                currentMode = static_cast<Mode>(static_cast<int>(currentMode) + 1);
                if (currentMode >= MODE_OFF) currentMode = MODE_STANDBY;
            }
            holdEnabled = false;
            if (currentMode == MODE_TEMPERATURE) {
                liveTemperature = 0.0f; // refreshed by loop() immediately after mode change
            }
            bleStateChanged = true;
            Serial.printf("Short MODE press -> %s\n", getModeName(currentMode));
        }
    }
}

// ==================================================
// ADS1115 I2C DETECTION
// ==================================================

bool i2cResponds(uint8_t address) {
    Wire.beginTransmission(address);
    return Wire.endTransmission() == 0;
}

void detectADS1115() {
    adsFound = false;
    adsAddress = 0;

    for (uint8_t address = 0x48; address <= 0x4B; address++) {
        if (i2cResponds(address)) {
            adsFound = true;
            adsAddress = address;
            break;
        }
    }

    Serial.println(
        adsFound ? "ADS1115 detected." : "ADS1115 NOT detected."
    );

    if (adsFound) {
        Serial.printf("ADS1115 address: 0x%02X\n", adsAddress);
    }
}


// ==================================================
// BLUETOOTH LOW ENERGY TELEMETRY
// Service/characteristic UUIDs must match React App.jsx
// ==================================================

static const char* BLE_DEVICE_NAME = "VOLTEX";
static const char* BLE_SERVICE_UUID = "12345678-1234-1234-1234-1234567890ab";
static const char* BLE_CHARACTERISTIC_UUID = "12345678-1234-1234-1234-1234567890ac";
BLECharacteristic* measurementCharacteristic = nullptr;
bool bleClientConnected = false;
uint32_t lastBleNotify = 0;
const uint32_t BLE_NOTIFY_INTERVAL_MS = 100; // 10 updates/second when connected

class VoltexServerCallbacks : public BLEServerCallbacks {
    void onConnect(BLEServer*) override {
        bleClientConnected = true;
        Serial.println("BLE client connected.");
    }
    void onDisconnect(BLEServer*) override {
        bleClientConnected = false;
        Serial.println("BLE client disconnected; advertising again.");
        BLEDevice::startAdvertising();
    }
};

// Dashboard -> ESP32 commands use the same characteristic as telemetry.
// Accepted examples:
// {"type":"command","action":"SET_MODE","mode":"TEMPERATURE"}
// {"type":"command","action":"SET_HOLD","value":true}
class VoltexCharacteristicCallbacks : public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic* characteristic) override {
        // This ESP32 BLE library returns Arduino String from getValue().
        String command = characteristic->getValue();
        if (command.isEmpty()) return;

        if (command.indexOf("\"action\":\"SET_MODE\"") >= 0) {
            Mode requestedMode = MODE_COUNT;
            if (command.indexOf("\"mode\":\"STANDBY\"") >= 0) requestedMode = MODE_STANDBY;
            else if (command.indexOf("\"mode\":\"V_DC\"") >= 0) requestedMode = MODE_VOLTAGE;
            else if (command.indexOf("\"mode\":\"RESISTANCE\"") >= 0) requestedMode = MODE_RESISTANCE;
            else if (command.indexOf("\"mode\":\"CONTINUITY\"") >= 0) requestedMode = MODE_CONTINUITY;
            else if (command.indexOf("\"mode\":\"TEMPERATURE\"") >= 0) requestedMode = MODE_TEMPERATURE;
            else if (command.indexOf("\"mode\":\"OFF\"") >= 0) requestedMode = MODE_OFF;

            if (requestedMode != MODE_COUNT && requestedMode != currentMode) {
                currentMode = requestedMode;
                holdEnabled = false;
                bleStateChanged = true;
                Serial.printf("BLE command: mode -> %s\n", getModeName(currentMode));
            }
        } else if (command.indexOf("\"action\":\"SET_HOLD\"") >= 0) {
            if (currentMode == MODE_TEMPERATURE) {
                const bool requestedHold = command.indexOf("\"value\":true") >= 0;
                if (requestedHold != holdEnabled) {
                    if (requestedHold) heldTemperature = liveTemperature;
                    holdEnabled = requestedHold;
                    bleStateChanged = true;
                    Serial.printf("BLE command: temperature HOLD -> %s\n", holdEnabled ? "ON" : "OFF");
                }
            }
        }
    }
};
void setupBLE() {
    BLEDevice::init(BLE_DEVICE_NAME);
    BLEServer* server = BLEDevice::createServer();
    server->setCallbacks(new VoltexServerCallbacks());
    BLEService* service = server->createService(BLE_SERVICE_UUID);
    measurementCharacteristic = service->createCharacteristic(
        BLE_CHARACTERISTIC_UUID,
        BLECharacteristic::PROPERTY_READ |
        BLECharacteristic::PROPERTY_NOTIFY |
        BLECharacteristic::PROPERTY_WRITE |
        BLECharacteristic::PROPERTY_WRITE_NR
    );
    measurementCharacteristic->setCallbacks(new VoltexCharacteristicCallbacks());
    measurementCharacteristic->addDescriptor(new BLE2902());
    measurementCharacteristic->setValue("{\"mode\":\"OFF\"}");
    service->start();
    BLEAdvertising* advertising = BLEDevice::getAdvertising();
    advertising->addServiceUUID(BLE_SERVICE_UUID);
    advertising->setScanResponse(true);
    advertising->start();
    Serial.println("BLE ready. Device name: VOLTEX (read/write/notify)");
}

void notifyBLEMeasurements() {
    const uint32_t now = millis();
    if (!measurementCharacteristic || !bleClientConnected ||
        (uint32_t)(now - lastBleNotify) < BLE_NOTIFY_INTERVAL_MS) return;
    lastBleNotify = now;

    char payload[220];
    char temperatureField[20];
    if (currentMode == MODE_TEMPERATURE) {
        const float value = holdEnabled ? heldTemperature : liveTemperature;
        snprintf(temperatureField, sizeof(temperatureField), "%.2f", value);
    } else {
        snprintf(temperatureField, sizeof(temperatureField), "null");
    }

    // Voltage, resistance, and continuity remain null until their acquisition
    // circuits are implemented and validated in firmware. Never fabricate data.
    snprintf(payload, sizeof(payload),
        "{\"mode\":\"%s\",\"voltageV\":null,\"resistanceOhm\":null,\"continuityClosed\":null,\"temperatureC\":%s,\"holdEnabled\":%s,\"adsFound\":%s,\"timestampMs\":%lu}",
        currentMode == MODE_STANDBY ? "STANDBY" :
        currentMode == MODE_VOLTAGE ? "V_DC" :
        currentMode == MODE_RESISTANCE ? "RESISTANCE" :
        currentMode == MODE_CONTINUITY ? "CONTINUITY" :
        currentMode == MODE_TEMPERATURE ? "TEMPERATURE" : "OFF",
        temperatureField,
        holdEnabled ? "true" : "false",
        adsFound ? "true" : "false",
        (unsigned long)now
    );
    measurementCharacteristic->setValue((uint8_t*)payload, strlen(payload));
    measurementCharacteristic->notify();
}

// ==================================================
// LM35 TEMPERATURE
// ==================================================

float readLM35Celsius() {
    // 10-sample average for steadier temperature readings.
    uint32_t totalMilliVolts = 0;
    constexpr int SAMPLE_COUNT = 10;

    for (int i = 0; i < SAMPLE_COUNT; i++) {
        totalMilliVolts += analogReadMilliVolts(LM35_PIN);
        if (i + 1 < SAMPLE_COUNT) delay(1);
    }

    const float milliVolts = totalMilliVolts / static_cast<float>(SAMPLE_COUNT);

    // LM35 output: approximately 10 mV per degree C
    return milliVolts / 10.0f;
}

// ==================================================
// CENTERED TEXT HELPER
// ==================================================

void drawCentered(const char *text, int y) {
    int width = oled.getStrWidth(text);
    int x = (128 - width) / 2;

    if (x < 0) {
        x = 0;
    }

    oled.drawStr(x, y, text);
}

// ==================================================
// GROUP CREDIT SCREEN
// Compact bold GROUP-2 with improved spacing
// Used by startup and OFF-mode rotation
// ==================================================

void drawGroupCreditScreen() {
    oled.clearBuffer();
    oled.drawFrame(0, 0, 128, 64);

    // Top heading
    oled.setFont(u8g2_font_6x10_tf);
    drawCentered("V O L T E X", 12);

    oled.drawHLine(12, 17, 104);

    // Credit label
    oled.setFont(u8g2_font_5x8_tf);
    drawCentered("CREATED BY", 28);

    // Compact bold font; larger bold font avoided
    oled.setFont(u8g2_font_helvB10_tf);
    drawCentered("GROUP-2", 42);

    // Semester details with space below group name
    oled.setFont(u8g2_font_5x8_tf);
    drawCentered("ETC 5TH SEM (2026)", 54);

    oled.sendBuffer();
}

// ==================================================
// SPLASH SCREEN HELPER
// ==================================================

void showSplash(
    const char* line1,
    const char* line2,
    const char* line3,
    uint32_t duration
) {
    // Reuse the custom group-credit layout
    if (line2 != nullptr && strcmp(line2, "GROUP-2") == 0) {
        drawGroupCreditScreen();
        delay(duration);
        return;
    }

    oled.clearBuffer();
    oled.drawFrame(0, 0, 128, 64);

    oled.setFont(u8g2_font_6x10_tf);
    drawCentered("V O L T E X", 12);
    oled.drawHLine(8, 17, 112);

    if (line1 != nullptr) {
        oled.setFont(u8g2_font_6x10_tf);
        drawCentered(line1, 29);
    }

    if (line2 != nullptr) {
        // Keep SAI & RUDRA screen unchanged.
        // Give ESP32 & CHAI a bold, centered line with comfortable margins.
        if (strcmp(line2, "SAI & RUDRA") == 0) {
            oled.setFont(u8g2_font_helvB14_tf);
            drawCentered(line2, 48);
        } else if (strcmp(line2, "ESP32 & CHAI") == 0) {
            oled.setFont(u8g2_font_helvB10_tf);
            drawCentered(line2, 44);
        } else {
            oled.setFont(u8g2_font_6x10_tf);
            drawCentered(line2, 41);
        }
    }

    if (line3 != nullptr) {
        oled.setFont(u8g2_font_5x8_tf);
        drawCentered(line3, 56);
    }

    oled.sendBuffer();
    delay(duration);
}

// ==================================================
// STARTUP ANIMATION
// ==================================================

void startupAnimation() {
    // SCREEN 1: INITIALIZING
    oled.clearBuffer();
    oled.drawFrame(0, 0, 128, 64);

    oled.setFont(u8g2_font_6x10_tf);
    drawCentered("INITIALIZING", 27);

    oled.setFont(u8g2_font_helvB14_tf);
    drawCentered("VOLTEX", 46);

    oled.sendBuffer();
    delay(900);

    // SCREEN 2: GROUP CREDITS
    showSplash(
        "CREATED BY",
        "GROUP-2",
        "ETC 5TH SEM (2026)",
        1800
    );

    // SCREEN 3: POWERED BY (unchanged)
    showSplash(
        "POWERED BY",
        "SAI & RUDRA",
        nullptr,
        1800
    );

    // SCREEN 4: DRIVEN BY
    showSplash(
        "DRIVEN BY",
        "ESP32 & CHAI",
        nullptr,
        1800
    );

    // SCREEN 5: BOOT PROGRESS
    for (int progress = 0; progress <= 100; progress += 5) {
        oled.clearBuffer();
        oled.drawFrame(0, 0, 128, 64);

        oled.setFont(u8g2_font_helvB14_tf);
        drawCentered("VOLTEX", 23);

        oled.setFont(u8g2_font_6x10_tf);
        drawCentered("SMART MULTIMETER", 36);

        oled.drawFrame(14, 43, 100, 9);
        oled.drawBox(16, 45, (progress * 96) / 100, 5);

        char percentage[8];
        snprintf(percentage, sizeof(percentage), "%d%%", progress);
        drawCentered(percentage, 61);

        oled.sendBuffer();
        delay(45);
    }

    delay(250);
}

// ==================================================
// HOME SCREEN
// ==================================================

// STANDBY shows its home screen first, then rotates through the credits.
// Each page remains visible for 4 seconds. OFF stays a static VOLTEX wordmark.
void drawStandbyCreditScreen() {
    if (offScreenPage == 0) {
        oled.clearBuffer();
        oled.drawFrame(0, 0, 128, 64);
        oled.setFont(u8g2_font_helvB14_tf);
        drawCentered("VOLTEX", 25);
        oled.setFont(u8g2_font_6x10_tf);
        drawCentered("SMART MULTIMETER", 39);
        oled.drawHLine(20, 44, 88);
        oled.setFont(u8g2_font_helvB10_tf);
        drawCentered("STANDBY", 58);
        oled.sendBuffer();
        return;
    }

    if (offScreenPage == 1) {
        drawGroupCreditScreen();
        return;
    }

    oled.clearBuffer();
    oled.drawFrame(0, 0, 128, 64);
    oled.setFont(u8g2_font_6x10_tf);
    drawCentered("V O L T E X", 12);
    oled.drawHLine(12, 17, 104);
    oled.setFont(u8g2_font_5x8_tf);
    drawCentered("POWERED BY", 29);
    oled.setFont(u8g2_font_helvB14_tf);
    drawCentered("SAI & RUDRA", 49);
    oled.sendBuffer();
}

void drawStandbyScreen() {
    drawStandbyCreditScreen();
}

// OFF is a true shutdown state: one static bold VOLTEX word, no rotating pages.
void drawOffScreen() {
    oled.clearBuffer();
    oled.setFont(u8g2_font_helvB18_tf);
    drawCentered("VOLTEX", 38);
    oled.sendBuffer();
}

// ==================================================
// MODE DISPLAY
// ==================================================

void drawModeScreen() {
    oled.clearBuffer();
    oled.drawFrame(0, 0, 128, 64);

    oled.setFont(u8g2_font_6x10_tf);
    drawCentered("V O L T E X", 10);
    oled.drawHLine(8, 14, 112);

    char reading[24];

    switch (currentMode) {
        case MODE_STANDBY:
            drawStandbyScreen();
            return;

        case MODE_OFF:
            drawOffScreen();
            return;

        case MODE_VOLTAGE:
            oled.setFont(u8g2_font_6x10_tf);
            drawCentered("DC VOLTAGE", 26);

            oled.setFont(u8g2_font_helvB18_tf);
            drawCentered("0.00 V", 53);
            break;

        case MODE_RESISTANCE:
            oled.setFont(u8g2_font_6x10_tf);
            drawCentered("RESISTANCE", 26);

            oled.setFont(u8g2_font_helvB18_tf);
            drawCentered("0 Ohm", 53);
            break;

        case MODE_CONTINUITY:
            oled.setFont(u8g2_font_6x10_tf);
            drawCentered("CONTINUITY", 26);

            oled.setFont(u8g2_font_helvB14_tf);
            drawCentered("OPEN", 49);
            break;

        case MODE_TEMPERATURE: {
            float temperature =
                holdEnabled ? heldTemperature : liveTemperature;

            snprintf(reading, sizeof(reading), "%.1f C", temperature);

            oled.setFont(u8g2_font_6x10_tf);
            drawCentered("TEMPERATURE", 26);

            oled.setFont(u8g2_font_helvB18_tf);
            drawCentered(reading, 49);

            oled.setFont(u8g2_font_5x8_tf);
            drawCentered(holdEnabled ? "HOLD ON" : "LIVE", 61);
            break;
        }

        default:
            break;
    }

    oled.sendBuffer();
}

// ==================================================
// SETUP
// ==================================================

void setup() {
    Serial.begin(115200);

    pinMode(MODE_BUTTON_PIN, INPUT_PULLUP);
    pinMode(HOLD_BUTTON_PIN, INPUT_PULLUP);

    analogReadResolution(12);
    analogSetPinAttenuation(LM35_PIN, ADC_11db);

    Wire.begin(SDA_PIN, SCL_PIN);
    Wire.setClock(100000);

    // Common OLED address: 0x3C
    oled.setI2CAddress(0x3C << 1);
    oled.begin();

    startupAnimation();
    detectADS1115();
    setupBLE();

    liveTemperature = readLM35Celsius();
    heldTemperature = liveTemperature;

    offScreenPage = 0;
    lastOffScreenChange = millis();
    drawModeScreen();

    Serial.println();
    Serial.println("VOLTEX ready.");
    Serial.println("MODE: GPIO 25");
    Serial.println("HOLD: GPIO 26");
    Serial.println("LM35: GPIO 34");

    Serial.printf(
        "Current mode: %d (%s)\n",
        (int)currentMode,
        getModeName(currentMode)
    );
}

// ==================================================
// MAIN LOOP
// ==================================================

void loop() {
    uint32_t now = millis();

    // BLE callbacks only update state; redraw the OLED here on the main loop.
    if (bleStateChanged) {
        bleStateChanged = false;
        offScreenPage = 0;
        lastOffScreenChange = now;
        if (currentMode == MODE_TEMPERATURE && !holdEnabled) {
            liveTemperature = readLM35Celsius();
            heldTemperature = liveTemperature;
        }
        drawModeScreen();
        lastDisplayUpdate = millis();
    }

    // MODE button: short press cycles modes; 3-second hold enters OFF.
    pollModeButton();

    // HOLD button: temperature mode only
    if (wasPressed(holdButton)) {
        if (currentMode == MODE_TEMPERATURE) {
            if (!holdEnabled) {
                heldTemperature = liveTemperature;
                holdEnabled = true;
            } else {
                holdEnabled = false;
            }

            Serial.printf(
                "Temperature HOLD: %s\n",
                holdEnabled ? "ON" : "OFF"
            );

            drawModeScreen();
            lastDisplayUpdate = millis();
        } else {
            Serial.println(
                "HOLD works in TEMP mode only during this test."
            );
        }
    }

    // Rotate standby home and credit pages every 4 seconds. This runs only in
    // STANDBY; entering OFF still shows the static VOLTEX wordmark.
    if (currentMode == MODE_STANDBY &&
        (uint32_t)(now - lastOffScreenChange) >= 4000) {
        lastOffScreenChange = now;
        offScreenPage = (offScreenPage + 1) % 3;
        drawStandbyCreditScreen();
        lastDisplayUpdate = now;
    }

    // Refresh live temperature every 100 ms; BLE sends the latest sample promptly.
    // The shorter ADC average above keeps this sampling step from blocking the loop too long.
    if (currentMode == MODE_TEMPERATURE &&
        !holdEnabled &&
        (uint32_t)(now - lastSensorRead) >= 100) {

        lastSensorRead = now;
        liveTemperature = readLM35Celsius();

        Serial.printf("LM35: %.1f C\n", liveTemperature);

        drawModeScreen();
        lastDisplayUpdate = millis();
    }

    // Refresh static measurement screens
    if (currentMode != MODE_OFF &&
        currentMode != MODE_STANDBY &&
        currentMode != MODE_TEMPERATURE &&
        (uint32_t)(now - lastDisplayUpdate) >= 1000) {

        drawModeScreen();
        lastDisplayUpdate = millis();
    }

    notifyBLEMeasurements();
    delay(2);
}
