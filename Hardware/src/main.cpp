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

// Shared HOLD snapshots: OLED and BLE transmit the same captured readings.
float heldInputVoltage = 0.0f;
bool heldVoltageAdcValid = false;
float heldResistanceOhms = 0.0f;
bool heldResistanceAdcValid = false;
bool heldResistanceOpen = false;
bool heldContinuityClosed = false;
bool heldContinuityAdcValid = false;

bool adsFound = false;
uint8_t adsAddress = 0;

// DC voltage measurement on ADS1115 A3: 120 kOhm / 10 kOhm divider.
float measuredInputVoltage = 0.0f;
float voltageAdcNodeVoltage = 0.0f;
bool voltageAdcValid = false;
uint32_t lastVoltageRead = 0;
const float VOLTAGE_DIVIDER_RATIO = 13.0f;
const uint32_t VOLTAGE_SAMPLE_INTERVAL_MS = 100;

// Continuity measurement on ADS1115 A1 (AIN1 referenced to GND).
float continuityVoltage = 0.0f;
bool continuityClosed = false;
bool continuityAdcValid = false;
uint32_t lastContinuityRead = 0;
const float CONTINUITY_THRESHOLD_V = 0.20f;
const uint32_t CONTINUITY_SAMPLE_INTERVAL_MS = 100;

// Resistance measurement on ADS1115 A2 using the 10 kOhm reference divider.
float resistanceVoltage = 0.0f;
float measuredResistanceOhms = 0.0f;
bool resistanceAdcValid = false;
bool resistanceOpen = false;
uint32_t lastResistanceRead = 0;
const float RESISTANCE_REFERENCE_OHMS = 10000.0f;
float resistanceSupplyVolts = 3.3f; // Calibrated from A2 at startup with probes disconnected.
const float RESISTANCE_OPEN_MARGIN_V = 0.05f; // Within 50 mV of open-circuit level = OPEN.
const uint32_t RESISTANCE_SAMPLE_INTERVAL_MS = 100;

// Keep Serial Monitor readable: measurement values are logged at most once per second.
uint32_t lastMeasurementLog = 0;
const uint32_t MEASUREMENT_LOG_INTERVAL_MS = 1000;


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

bool isMeasurementMode(Mode mode) {
    return mode == MODE_VOLTAGE || mode == MODE_RESISTANCE ||
           mode == MODE_CONTINUITY || mode == MODE_TEMPERATURE;
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

    if ((uint32_t)(now - modeRawChangedAt) >= 35 &&
        raw == LOW && !modeStablePressed) {
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

    if ((uint32_t)(now - modeRawChangedAt) >= 35 &&
        raw == HIGH && modeStablePressed) {
        modeStablePressed = false;
        if (!modeLongPressHandled) {
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
                liveTemperature = 0.0f;
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

    if (adsFound) {
        Serial.printf("[I2C] ADS1115 detected at 0x%02X\n", adsAddress);
    } else {
        Serial.println("[ERROR] ADS1115 not detected. Check SDA, SCL, VDD and GND.");
    }
}


// ==================================================
// CONTINUITY MEASUREMENT - ADS1115 A1
// 3.3 V -> 1 kOhm -> sense node -> test probes -> GND
// Closed circuit: approximately 0 V; open circuit: approximately 3.3 V.
// ==================================================

bool readADS1115SingleEndedVoltage(uint8_t channel, float &voltage) {
    if (!adsFound || channel > 3) return false;

    // MUX: 100=A0, 101=A1, 110=A2, 111=A3 (single-ended to GND).
    // PGA +/-4.096 V, single-shot mode, 128 samples/second.
    const uint16_t muxBits = (uint16_t)(0x04 + channel) << 12;
    const uint16_t config =
        0x8000 | muxBits | 0x0200 | 0x0100 | 0x0080 | 0x0003;

    Wire.beginTransmission(adsAddress);
    Wire.write(0x01);
    Wire.write((uint8_t)(config >> 8));
    Wire.write((uint8_t)(config & 0xFF));
    if (Wire.endTransmission() != 0) return false;

    delay(10);

    Wire.beginTransmission(adsAddress);
    Wire.write(0x00);
    if (Wire.endTransmission(false) != 0) return false;
    if (Wire.requestFrom((int)adsAddress, 2) != 2) return false;

    const int16_t raw = (int16_t)(
        ((uint16_t)Wire.read() << 8) | (uint16_t)Wire.read()
    );

    voltage = raw * 0.000125f;
    if (voltage < 0.0f) voltage = 0.0f;
    return true;
}

bool readADS1115A0Voltage(float &voltage) {
    return readADS1115SingleEndedVoltage(0, voltage);
}

bool readADS1115A1Voltage(float &voltage) {
    return readADS1115SingleEndedVoltage(1, voltage);
}

bool readADS1115A2Voltage(float &voltage) {
    return readADS1115SingleEndedVoltage(2, voltage);
}

bool readADS1115A3Voltage(float &voltage) {
    return readADS1115SingleEndedVoltage(3, voltage);
}

// Calibrate the A2 divider's open-circuit voltage at startup.
// IMPORTANT: Leave both resistance probes disconnected during power-up.
bool calibrateResistanceReference() {
    if (!adsFound) {
        Serial.println("[CAL][SKIP] Resistance calibration: ADS1115 unavailable.");
        return false;
    }

    const uint8_t sampleCount = 20;
    float totalVoltage = 0.0f;

    Serial.println("[CAL] Resistance reference: disconnect both probes.");

    for (uint8_t i = 0; i < sampleCount; i++) {
        float sampleVoltage = 0.0f;
        if (!readADS1115A2Voltage(sampleVoltage)) {
            Serial.println("[CAL][ERROR] A2 read failed; using default reference (3.300 V).");
            return false;
        }
        totalVoltage += sampleVoltage;
    }

    const float averageVoltage = totalVoltage / sampleCount;

    // Reject implausible readings rather than storing a bad calibration.
    if (averageVoltage < 2.5f || averageVoltage > 3.6f) {
        Serial.printf("[CAL][ERROR] A2 reference %.3f V is out of range; calibration rejected.\n",
                      averageVoltage);
        return false;
    }

    resistanceSupplyVolts = averageVoltage;
    Serial.printf("[CAL][OK] Resistance reference calibrated: %.3f V\n",
                  resistanceSupplyVolts);
    return true;
}

void updateVoltageMeasurement() {
    // Average eight A3 samples to reduce display jitter.
    const uint8_t sampleCount = 8;
    float totalNodeVoltage = 0.0f;

    for (uint8_t i = 0; i < sampleCount; i++) {
        float sampleVoltage = 0.0f;
        if (!readADS1115A3Voltage(sampleVoltage)) {
            voltageAdcValid = false;
            Serial.println("[ERROR][VOLT] ADS1115 A3 read failed.");
            return;
        }
        totalNodeVoltage += sampleVoltage;
    }

    voltageAdcNodeVoltage = totalNodeVoltage / sampleCount;
    measuredInputVoltage = voltageAdcNodeVoltage * VOLTAGE_DIVIDER_RATIO;
    voltageAdcValid = true;

    if ((uint32_t)(millis() - lastMeasurementLog) >= MEASUREMENT_LOG_INTERVAL_MS) {
        lastMeasurementLog = millis();
        Serial.printf("[VOLT] A3 node: %.3f V | Input: %.2f V\n",
                      voltageAdcNodeVoltage, measuredInputVoltage);
    }
}

void updateContinuityMeasurement() {
    // Average four A1 samples for a steadier OPEN/CLOSED decision.
    constexpr uint8_t SAMPLE_COUNT = 4;
    float totalVoltage = 0.0f;

    for (uint8_t i = 0; i < SAMPLE_COUNT; i++) {
        float sampleVoltage = 0.0f;
        if (!readADS1115A1Voltage(sampleVoltage)) {
            continuityAdcValid = false;
            Serial.println("[ERROR][CONT] ADS1115 A1 read failed.");
            return;
        }
        totalVoltage += sampleVoltage;
    }

    continuityVoltage = totalVoltage / SAMPLE_COUNT;
    continuityClosed = (continuityVoltage < CONTINUITY_THRESHOLD_V);
    continuityAdcValid = true;

    if ((uint32_t)(millis() - lastMeasurementLog) >= MEASUREMENT_LOG_INTERVAL_MS) {
        lastMeasurementLog = millis();
        Serial.printf("[CONT] A1: %.3f V | State: %s\n",
                      continuityVoltage,
                      continuityClosed ? "CLOSED" : "OPEN");
    }
}

void updateResistanceMeasurement() {
    // Average eight A2 samples to improve resistance stability.
    constexpr uint8_t SAMPLE_COUNT = 8;
    float totalVoltage = 0.0f;

    for (uint8_t i = 0; i < SAMPLE_COUNT; i++) {
        float sampleVoltage = 0.0f;
        if (!readADS1115A2Voltage(sampleVoltage)) {
            resistanceAdcValid = false;
            Serial.println("[ERROR][RES] ADS1115 A2 read failed.");
            return;
        }
        totalVoltage += sampleVoltage;
    }

    resistanceVoltage = totalVoltage / SAMPLE_COUNT;

    // Near 3.3 V, the unknown resistance is effectively open.
    const float openThreshold = resistanceSupplyVolts - RESISTANCE_OPEN_MARGIN_V;
    if (resistanceVoltage >= openThreshold) {
        resistanceOpen = true;
        measuredResistanceOhms = INFINITY;
    } else {
        const float denominator = resistanceSupplyVolts - resistanceVoltage;
        if (denominator <= 0.001f) {
            resistanceOpen = true;
            measuredResistanceOhms = INFINITY;
        } else {
            // Rx = RREF * Vout / (Vcalibrated_open - Vout).
            measuredResistanceOhms =
                RESISTANCE_REFERENCE_OHMS * resistanceVoltage / denominator;
            resistanceOpen = false;
        }
    }

    resistanceAdcValid = true;

    if ((uint32_t)(millis() - lastMeasurementLog) >= MEASUREMENT_LOG_INTERVAL_MS) {
        lastMeasurementLog = millis();
        if (resistanceOpen) {
            Serial.printf("[RES] A2: %.3f V | Result: OPEN\n", resistanceVoltage);
        } else if (measuredResistanceOhms >= 1000000.0f) {
            Serial.printf("[RES] A2: %.3f V | Result: %.3f MOhm\n",
                          resistanceVoltage, measuredResistanceOhms / 1000000.0f);
        } else if (measuredResistanceOhms >= 1000.0f) {
            Serial.printf("[RES] A2: %.3f V | Result: %.3f kOhm\n",
                          resistanceVoltage, measuredResistanceOhms / 1000.0f);
        } else {
            Serial.printf("[RES] A2: %.3f V | Result: %.2f Ohm\n",
                          resistanceVoltage, measuredResistanceOhms);
        }
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
        Serial.println("[BLE] Dashboard connected.");
    }
    void onDisconnect(BLEServer*) override {
        bleClientConnected = false;
        Serial.println("[BLE] Dashboard disconnected. Advertising restarted.");
        BLEDevice::startAdvertising();
    }
};

// Capture the current measurement once so OLED and BLE use the same held sample.
void captureCurrentMeasurementForHold() {
    switch (currentMode) {
        case MODE_VOLTAGE:
            heldInputVoltage = measuredInputVoltage;
            heldVoltageAdcValid = voltageAdcValid;
            break;
        case MODE_RESISTANCE:
            heldResistanceOhms = measuredResistanceOhms;
            heldResistanceAdcValid = resistanceAdcValid;
            heldResistanceOpen = resistanceOpen;
            break;
        case MODE_CONTINUITY:
            heldContinuityClosed = continuityClosed;
            heldContinuityAdcValid = continuityAdcValid;
            break;
        case MODE_TEMPERATURE:
            heldTemperature = liveTemperature;
            break;
        default:
            break;
    }
}

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
                Serial.printf("[BLE] Mode command -> %s\n", getModeName(currentMode));
            }
        } else if (command.indexOf("\"action\":\"SET_HOLD\"") >= 0) {
            if (isMeasurementMode(currentMode)) {
                const bool requestedHold = command.indexOf("\"value\":true") >= 0;
                if (requestedHold != holdEnabled) {
                    if (requestedHold) captureCurrentMeasurementForHold();
                    holdEnabled = requestedHold;
                    bleStateChanged = true;
                    Serial.printf("[BLE] %s hold -> %s\n",
                                  getModeName(currentMode), holdEnabled ? "ON" : "OFF");
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
    Serial.println("[BLE] Ready | Device: VOLTEX | Read/Write/Notify enabled");
}

void notifyBLEMeasurements() {
    const uint32_t now = millis();
    if (!measurementCharacteristic || !bleClientConnected ||
        (uint32_t)(now - lastBleNotify) < BLE_NOTIFY_INTERVAL_MS) return;
    lastBleNotify = now;

    char payload[280];
    char voltageField[20];
    const bool voltageValidForPacket =
        currentMode == MODE_VOLTAGE &&
        (holdEnabled ? heldVoltageAdcValid : voltageAdcValid);
    const float voltageValueForPacket =
        holdEnabled ? heldInputVoltage : measuredInputVoltage;

    if (voltageValidForPacket) {
        snprintf(voltageField, sizeof(voltageField), "%.3f", voltageValueForPacket);
    } else {
        snprintf(voltageField, sizeof(voltageField), "null");
    }

    char temperatureField[20];
    if (currentMode == MODE_TEMPERATURE) {
        const float value = holdEnabled ? heldTemperature : liveTemperature;
        snprintf(temperatureField, sizeof(temperatureField), "%.2f", value);
    } else {
        snprintf(temperatureField, sizeof(temperatureField), "null");
    }

    char continuityField[8];
    const bool continuityValidForPacket =
        currentMode == MODE_CONTINUITY &&
        (holdEnabled ? heldContinuityAdcValid : continuityAdcValid);
    const bool continuityValueForPacket =
        holdEnabled ? heldContinuityClosed : continuityClosed;

    if (continuityValidForPacket) {
        snprintf(continuityField, sizeof(continuityField), "%s",
                 continuityValueForPacket ? "true" : "false");
    } else {
        snprintf(continuityField, sizeof(continuityField), "null");
    }

    char resistanceField[24];
    const bool resistanceValidForPacket =
        currentMode == MODE_RESISTANCE &&
        (holdEnabled ? heldResistanceAdcValid : resistanceAdcValid);
    const bool resistanceOpenForPacket =
        holdEnabled ? heldResistanceOpen : resistanceOpen;
    const float resistanceValueForPacket =
        holdEnabled ? heldResistanceOhms : measuredResistanceOhms;

    if (resistanceValidForPacket && !resistanceOpenForPacket) {
        snprintf(resistanceField, sizeof(resistanceField), "%.2f",
                 resistanceValueForPacket);
    } else {
        snprintf(resistanceField, sizeof(resistanceField), "null");
    }

    const char* resistanceOpenField =
        resistanceValidForPacket
            ? (resistanceOpenForPacket ? "true" : "false")
            : "null";

    // Continuity state is reported from the ADS1115 A1 measurement.
    snprintf(payload, sizeof(payload),
        "{\"mode\":\"%s\",\"voltageV\":%s,\"resistanceOhm\":%s,\"resistanceOpen\":%s,\"continuityClosed\":%s,\"temperatureC\":%s,\"holdEnabled\":%s,\"adsFound\":%s,\"timestampMs\":%lu}",
        currentMode == MODE_STANDBY ? "STANDBY" :
        currentMode == MODE_VOLTAGE ? "V_DC" :
        currentMode == MODE_RESISTANCE ? "RESISTANCE" :
        currentMode == MODE_CONTINUITY ? "CONTINUITY" :
        currentMode == MODE_TEMPERATURE ? "TEMPERATURE" : "OFF",
        voltageField,
        resistanceField,
        resistanceOpenField,
        continuityField,
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

bool readLM35Celsius(float &temperatureC) {
    // Read LM35 output through ADS1115 A0 (not ESP32 GPIO34).
    constexpr uint8_t SAMPLE_COUNT = 8;
    float totalVoltage = 0.0f;

    for (uint8_t i = 0; i < SAMPLE_COUNT; i++) {
        float sampleVoltage = 0.0f;
        if (!readADS1115A0Voltage(sampleVoltage)) {
            Serial.println("[ERROR][TEMP] LM35 read failed on ADS1115 A0.");
            return false;
        }
        totalVoltage += sampleVoltage;
    }

    const float averageVoltage = totalVoltage / SAMPLE_COUNT;
    const float milliVolts = averageVoltage * 1000.0f;

    // LM35: approximately 10 mV per degree Celsius.
    temperatureC = milliVolts / 10.0f;
    return true;
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

void drawHoldStatus() {
    oled.setFont(u8g2_font_5x8_tf);
    drawCentered(holdEnabled ? "HOLD ON" : "LIVE", 61);
}

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

        case MODE_VOLTAGE: {
            oled.setFont(u8g2_font_6x10_tf);
            drawCentered("DC VOLTAGE", 26);

            // Keep all four measurement values at the same size and baseline.
            oled.setFont(u8g2_font_helvB14_tf);
            const bool valid = holdEnabled ? heldVoltageAdcValid : voltageAdcValid;
            const float value = holdEnabled ? heldInputVoltage : measuredInputVoltage;
            if (!valid) {
                drawCentered("ADC ERROR", 48);
            } else {
                snprintf(reading, sizeof(reading), "%.2f V", value);
                drawCentered(reading, 48);
            }
            drawHoldStatus();
            break;
        }

        case MODE_RESISTANCE: {
            oled.setFont(u8g2_font_6x10_tf);
            drawCentered("RESISTANCE", 26);

            oled.setFont(u8g2_font_helvB14_tf);
            const bool valid = holdEnabled ? heldResistanceAdcValid : resistanceAdcValid;
            const bool isOpen = holdEnabled ? heldResistanceOpen : resistanceOpen;
            const float value = holdEnabled ? heldResistanceOhms : measuredResistanceOhms;
            if (!valid) {
                drawCentered("ADC ERROR", 48);
            } else if (isOpen) {
                drawCentered("0.0 Ohm", 48);
            } else if (value >= 1000000.0f) {
                snprintf(reading, sizeof(reading), "%.2f MOhm", value / 1000000.0f);
                drawCentered(reading, 48);
            } else if (value >= 1000.0f) {
                snprintf(reading, sizeof(reading), "%.2f kOhm", value / 1000.0f);
                drawCentered(reading, 48);
            } else {
                snprintf(reading, sizeof(reading), "%.1f Ohm", value);
                drawCentered(reading, 48);
            }
            drawHoldStatus();
            break;
        }

        case MODE_CONTINUITY: {
            oled.setFont(u8g2_font_6x10_tf);
            drawCentered("CONTINUITY", 26);

            oled.setFont(u8g2_font_helvB14_tf);
            const bool valid = holdEnabled ? heldContinuityAdcValid : continuityAdcValid;
            const bool closed = holdEnabled ? heldContinuityClosed : continuityClosed;
            if (!valid) {
                drawCentered("ADC ERROR", 48);
            } else {
                drawCentered(closed ? "CLOSED" : "OPEN", 48);
            }
            drawHoldStatus();
            break;
        }

        case MODE_TEMPERATURE: {
            float temperature =
                holdEnabled ? heldTemperature : liveTemperature;

            snprintf(reading, sizeof(reading), "%.1f C", temperature);

            oled.setFont(u8g2_font_6x10_tf);
            drawCentered("TEMPERATURE", 26);

            oled.setFont(u8g2_font_helvB14_tf);
            drawCentered(reading, 48);

            drawHoldStatus();
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


    Wire.begin(SDA_PIN, SCL_PIN);
    Wire.setClock(100000);

    // Common OLED address: 0x3C
    oled.setI2CAddress(0x3C << 1);
    oled.begin();

    startupAnimation();
    detectADS1115();

    // Keep resistance probes disconnected during this one-time startup calibration.
    calibrateResistanceReference();

    setupBLE();

    if (readLM35Celsius(liveTemperature)) {
        heldTemperature = liveTemperature;
    } else {
        liveTemperature = 0.0f;
        heldTemperature = 0.0f;
    }

    offScreenPage = 0;
    lastOffScreenChange = millis();
    drawModeScreen();

    Serial.println();
    Serial.println("==============================================");
    Serial.println("              VOLTEX MULTIMETER              ");
    Serial.println("==============================================");
    Serial.println("[BOOT] Firmware initialization complete.");
    Serial.println("[PIN ] MODE       : GPIO 25");
    Serial.println("[PIN ] HOLD       : GPIO 26");
    Serial.println("[ADC ] LM35       : ADS1115 A0");
    Serial.println("[ADC ] Continuity : ADS1115 A1");
    Serial.println("[ADC ] Resistance : ADS1115 A2");
    Serial.println("[ADC ] Voltage    : ADS1115 A3 (divider x13)");
    Serial.printf("[SYS ] Current mode: %s\n", getModeName(currentMode));
    Serial.println("----------------------------------------------");
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
            if (readLM35Celsius(liveTemperature)) {
                heldTemperature = liveTemperature;
            }
        }
        drawModeScreen();
        lastDisplayUpdate = millis();
    }

    // MODE button: short press cycles modes; 3-second hold enters OFF.
    pollModeButton();

    // HOLD button: freeze/resume the same measurement snapshot on OLED and BLE.
    if (wasPressed(holdButton)) {
        if (isMeasurementMode(currentMode)) {
            if (!holdEnabled) captureCurrentMeasurementForHold();
            holdEnabled = !holdEnabled;
            bleStateChanged = true;

            Serial.printf("[HOLD] %s -> %s\n", getModeName(currentMode),
                          holdEnabled ? "HOLD ON" : "LIVE");
            drawModeScreen();
            lastDisplayUpdate = millis();
        } else {
            Serial.println("[HOLD] Ignored: select a measurement mode first.");
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
        if (readLM35Celsius(liveTemperature)) {
            if ((uint32_t)(millis() - lastMeasurementLog) >= MEASUREMENT_LOG_INTERVAL_MS) {
                lastMeasurementLog = millis();
                Serial.printf("[TEMP] A0: %.1f C\n", liveTemperature);
            }
            drawModeScreen();
            lastDisplayUpdate = millis();
        }
    }

    // Sample DC voltage input on ADS1115 A3 every 100 ms in voltage mode.
    if (currentMode == MODE_VOLTAGE && !holdEnabled &&
        (uint32_t)(now - lastVoltageRead) >= VOLTAGE_SAMPLE_INTERVAL_MS) {
        lastVoltageRead = now;
        updateVoltageMeasurement();
        drawModeScreen();
        lastDisplayUpdate = millis();
    }

    // Sample continuity input on ADS1115 A1 every 100 ms while in that mode.
    if (currentMode == MODE_CONTINUITY && !holdEnabled &&
        (uint32_t)(now - lastContinuityRead) >= CONTINUITY_SAMPLE_INTERVAL_MS) {
        lastContinuityRead = now;
        updateContinuityMeasurement();
        drawModeScreen();
        lastDisplayUpdate = millis();
    }

    // Sample resistance input on ADS1115 A2 every 100 ms in resistance mode.
    if (currentMode == MODE_RESISTANCE && !holdEnabled &&
        (uint32_t)(now - lastResistanceRead) >= RESISTANCE_SAMPLE_INTERVAL_MS) {
        lastResistanceRead = now;
        updateResistanceMeasurement();
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
