# ⚡ VOLTEX — Smart Digital Multimeter

**An ESP32-based smart digital multimeter with a web dashboard for measurement monitoring, error analysis, and signal visualization.**

VOLTEX is an electronics and embedded-systems project that combines a custom digital multimeter interface with microcontroller-based measurements and interactive web visualization.

The project aims to bridge physical electronics instrumentation with modern web technologies, enabling users to monitor measurements, analyze errors, visualize signals, and maintain measurement logs through a responsive dashboard.

> **Development status:** The web interface currently uses simulated readings. ESP32 and ADC hardware integration is planned as part of the project.
m
## ✨ Key Features

- **Interactive Multimeter Interface** — A digital multimeter-inspired display with a rotary dial, measurement indicators, and animated transitions.
- **Multiple Measurement Modes** — DC voltage, resistance, continuity, and temperature interfaces.
- **Measurement Error Analysis** — Compare measured values against reference values and calculate measurement errors.
- **Live Signal Visualization** — Interactive graphs for visualizing measurement data and simulated waveforms.
- **Measurement Logging** — A foundation for recording and reviewing measurement readings.
- **Automatic Unit Scaling** — Display values using appropriate units, including mV, V, Ω, kΩ, and MΩ.
- **Continuity Testing Interface** — Simulated circuit continuity with an audible indicator.
- **Responsive Dashboard** — A dark-themed interface designed for clear measurement presentation.
- **Hardware Integration Roadmap** — Planned ESP32-based data acquisition and communication between the multimeter and web dashboard.

## 🛠️ Technology Stack

| Technology | Purpose |
|---|---|
| React | Interactive user interface |
| Vite | Development server and build tooling |
| Tailwind CSS | Styling and responsive layout |
| Recharts | Measurement and signal graphs |
| JavaScript | UI logic and measurement visualization |
| ESP32 | Planned embedded measurement controller |
| ADS1115 | Planned high-resolution ADC integration |

## 🏗️ System Architecture

The planned system connects the measurement hardware to the web interface through an ESP32-based data acquisition layer.

```text
        Electrical Input
               │
               ▼
    Measurement & Protection
         Circuitry
               │
               ▼
        ADC / Sensors
               │
               ▼
            ESP32
               │
       Wi-Fi Data Transfer
               │
               ▼
       VOLTEX Web Dashboard
               │
      ┌────────┼─────────┐
      ▼        ▼         ▼
   Readings  Error     Signal
             Analysis  Graphs
```

*This diagram represents the intended architecture. The physical measurement circuit, communication layer, and web integration are still under development.*

## 🎛️ Measurement Modes

| Mode | Intended functionality |
|---|---|
| **DC Voltage (V DC)** | Measure DC voltage within the supported hardware range. |
| **Resistance (Ω)** | Estimate resistance using a suitable measurement circuit. |
| **Continuity** | Detect electrical continuity and provide an audible indication. |
| **Temperature (°C)** | Display temperature readings when a compatible sensor is integrated. |
| **Error Analysis** | Compare measurements with reference values and analyze errors. |
| **Signal Monitor** | Visualize sampled measurement data and supported waveforms. |

Actual measurement capabilities and ranges will depend on the final hardware design, protection circuitry, calibration, and firmware implementation.

## 🚀 Run Locally

### Prerequisites

- [Node.js](https://nodejs.org/)
- npm

### Installation

Clone the repository and enter the project directory:

```bash
git clone <YOUR_REPOSITORY_URL>
cd <YOUR_PROJECT_FOLDER>
npm install
```

Start the development server:

```bash
npm run dev
```

Open the local URL shown in your terminal, usually `http://localhost:5173`.

### Production Build

Build the application:

```bash
npm run build
```

Preview the production build:

```bash
npm run preview
```

## 🔌 Hardware Integration Plan

The planned hardware platform includes:

- **ESP32 DevKit V1** — Measurement control, data processing, and wireless communication.
- **ADS1115 ADC** — High-resolution analog-to-digital conversion for supported measurement circuits.
- **ST7789 SPI TFT display** — Local measurement display.
- **Measurement and protection circuitry** — Input conditioning, current sensing, resistance measurement, and suitable protection.
- **Physical rotary selector** — Selection between OFF, voltage, current, and resistance modes, subject to the finalized circuit design.
- **Test probes** — Shared measurement probes with mode-appropriate input routing.

The hardware design will be validated before real measurements are enabled. AC measurement, current measurement, continuity detection, and temperature measurement may require additional components and dedicated circuits.

### Planned Data Flow

1. The measurement circuit conditions the input signal.
2. The ADC and any required sensors acquire measurement data.
3. The ESP32 processes the readings and applies calibration and scaling.
4. The ESP32 transmits supported data to the web dashboard.
5. VOLTEX displays readings, graphs, logs, and error analysis.

## 🗺️ Development Roadmap

- [x] Build the interactive multimeter dashboard.
- [x] Implement simulated measurement modes.
- [x] Add measurement error analysis.
- [x] Add interactive signal visualization.
- [ ] Finalize and validate the measurement hardware.
- [ ] Integrate the ESP32 and ADS1115.
- [ ] Develop embedded firmware and calibration logic.
- [ ] Establish communication between the ESP32 and web dashboard.
- [ ] Display real hardware measurements in the interface.
- [ ] Add persistent measurement logs and CSV export.
- [ ] Validate accuracy, repeatability, and input protection.

## ⚠️ Current Status and Safety

**The current application is a software simulation, not a functioning measuring instrument.**

- All current readings, graph samples, and logged values are simulated.
- No ESP32 or ADS1115 hardware is currently connected to the dashboard.
- The displayed values must not be treated as actual electrical measurements.
- Do not connect the prototype to mains voltage or other hazardous electrical sources.
- Hardware measurements should only be enabled after appropriate circuit design, protection, testing, and calibration.

The continuity simulation uses a **1200 Hz triangle-wave oscillator at gain 1.0**. Lower your system volume before testing the audio indicator.

## 🤝 Contributions

Suggestions, bug reports, and improvements are welcome. Feel free to fork the repository and submit a pull request.

## 📄 License

A license has not yet been selected. Add a `LICENSE` file when the project's distribution and reuse terms have been decided.

---

**VOLTEX** — *From physical measurements to intelligent visualization.* ⚡