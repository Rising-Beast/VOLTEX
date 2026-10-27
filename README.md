# ⚡ VOLTEX --- Smart Digital Multimeter

**A smart ESP32-based digital multimeter with an embedded display,
measurement firmware, and a responsive web dashboard for live readings,
error analysis, statistics, and signal visualization.**

VOLTEX is an Electronics and Telecommunication Engineering project that
brings together embedded systems, measurement instrumentation, and web
development. The project is organized as a single repository containing
the dashboard software and ESP32 hardware firmware.

> **Project status:** The dashboard and ESP32 firmware are developed as
> separate parts of the same project. Features that depend on the final
> measurement circuitry, calibration, and communication integration
> should be treated as hardware-dependent until verified on the
> assembled instrument.

------------------------------------------------------------------------

## 📚 Table of Contents

-   [Project Overview](#-project-overview)
-   [Features](#-features)
-   [Technology Stack](#️-technology-stack)
-   [Repository Structure](#-repository-structure)
-   [System Architecture](#-system-architecture)
-   [Measurement Modes](#-measurement-modes)
-   [Dashboard](#-dashboard)
-   [Hardware](#-hardware)
-   [Communication](#-communication)
-   [Run the Software](#-run-the-software)
-   [Build and Upload Firmware](#-build-and-upload-firmware)
-   [Configuration and
    Troubleshooting](#️-configuration-and-troubleshooting)
-   [Development Roadmap](#️-development-roadmap)
-   [Safety and Limitations](#️-safety-and-limitations)
-   [Contributors](#-contributors)
-   [License](#-license)

## 🔎 Project Overview

Traditional multimeters show readings on a local display. VOLTEX aims to
complement that physical interface with a dashboard that can display
readings, visualize changes over time, and help users understand
measurement error and statistics.

The project has two independently buildable parts:

-   **`hardware/`** --- ESP32 firmware and PlatformIO configuration for
    the physical instrument.
-   **`software/`** --- React-based dashboard, including the interface
    and data visualization.

Keeping these projects in one repository makes it easier to version the
firmware and dashboard together while preserving their separate
dependencies and build processes.

## ✨ Features

### Measurement interface

-   Multimeter-inspired display and mode selection.
-   DC voltage, resistance, continuity, and temperature modes, subject
    to the implemented measurement circuits and sensors.
-   Automatic unit scaling for supported readings (for example, mV/V and
    Ω/kΩ/MΩ).
-   Local embedded display for showing readings on the device.

### Dashboard and analysis

-   Responsive dark-themed VOLTEX dashboard.
-   Measurement error analysis using a reference value and a measured
    value.
-   Absolute and relative error calculations and an accuracy estimate
    where applicable.
-   Live graph view for measurement samples.
-   Timed data logging and statistical analysis interface.
-   Continuity interface with an audible indication.
-   Measurement indicators and mode-specific visual styling.

### Embedded system and connectivity

-   ESP32-based firmware.
-   Physical controls for selecting or operating device functions,
    according to the current hardware wiring.
-   Wireless communication between the ESP32 and dashboard where
    supported by the active firmware and browser/device.
-   A shared project structure for software and firmware development.

> **Important:** The dashboard's visual features do not by themselves
> verify the accuracy of the physical instrument. Real measurement
> performance depends on the analog front-end, component tolerances, ADC
> configuration, calibration, firmware, and protection circuitry.

## 🛠️ Technology Stack

  -----------------------------------------------------------------------
  Technology / component              Role
  ----------------------------------- -----------------------------------
  React                               Dashboard UI and interactive state

  Vite                                Front-end development server and
                                      production build

  Tailwind CSS                        Dashboard styling and responsive
                                      layout

  JavaScript                          Dashboard logic and data handling

  Recharts                            Graphs and measurement
                                      visualization, if enabled in the
                                      current software

  ESP32 DevKit                        Embedded controller and wireless
                                      connectivity

  PlatformIO                          Firmware build, library management,
                                      and upload workflow

  C/C++                               ESP32 firmware

  Embedded display                    Displays readings locally; exact
                                      display module depends on the
                                      current hardware build

  Measurement front-end and sensors   Condition input signals and acquire
                                      readings; exact circuits determine
                                      supported ranges
  -----------------------------------------------------------------------

## 📁 Repository Structure

``` text
VOLTEX/
├── software/                 # React + Vite dashboard
│   ├── public/               # Static assets
│   ├── src/                  # React components, styles, and logic
│   ├── index.html
│   ├── package.json
│   ├── package-lock.json
│   ├── vite.config.js
│   └── ...                   # Other front-end configuration
│
├── hardware/                 # ESP32 firmware project
│   ├── include/              # Project header files (if used)
│   ├── lib/                  # Project-specific libraries (if used)
│   ├── src/
│   │   └── main.cpp          # Firmware entry point
│   ├── test/                 # Firmware tests (if used)
│   ├── platformio.ini        # PlatformIO configuration
│   └── .gitignore            # Hardware-specific ignore rules
│
├── .gitignore                # Root ignore rules for both projects
└── README.md                 # Project documentation
```

`node_modules/` and `hardware/.pio/` are generated locally and should
not be committed. Keep the software and hardware dependencies separate.

## 🏗️ System Architecture

``` text
 Electrical input / test probes
              │
              ▼
   Input selection and protection
              │
              ▼
 Measurement circuitry / sensors
              │
              ▼
     ESP32 firmware processing
        ┌─────┴──────────┐
        ▼                ▼
 Local display     Wireless link
                         │
                         ▼
                 VOLTEX dashboard
                  ┌──────┼──────┐
                  ▼      ▼      ▼
               Reading  Graph  Analysis
                       and logs
```

This is a high-level conceptual diagram. The exact analog circuitry,
sensors, display interface, and communication protocol must match the
current source code and assembled hardware.

## 🎛️ Measurement Modes

  -----------------------------------------------------------------------
  Mode                    Intended purpose        Important qualification
  ----------------------- ----------------------- -----------------------
  **DC Voltage (V DC)**   Display a DC voltage    Range and accuracy
                          measurement             depend on the
                                                  divider/front-end, ADC,
                                                  calibration, and
                                                  protection

  **Resistance (Ω)**      Estimate resistance     Requires a suitable
                                                  measurement circuit;
                                                  test only de-energized
                                                  circuits

  **Continuity**          Indicate whether a      Threshold, response
                          circuit path is         time, and buzzer
                          electrically continuous behavior depend on the
                                                  implemented circuit and
                                                  firmware

  **Temperature (°C)**    Display temperature     Readings depend on the
                          from a compatible       sensor, its wiring, and
                          sensor                  calibration

  **Error Analysis**      Compare a reading with  Meaningful only when
                          a reference value       the reference and
                                                  measured quantities use
                                                  compatible units and
                                                  conditions

  **Statistics / Data     Analyze a set of        Results are only as
  Log**                   collected samples       reliable as the samples
                                                  and acquisition timing

  **Graph**               Visualize readings over The graph may show
                          time                    simulated or live data
                                                  depending on the active
                                                  data source
  -----------------------------------------------------------------------

Do not assume every mode or range is fully calibrated just because it
appears in the UI. Confirm the implemented circuitry and firmware before
using it for measurements.

## 🖥️ Dashboard

The dashboard is located in `software/` and uses React with Vite.

### Dashboard capabilities

-   Mode-aware measurement display.
-   Visual feedback for the active measurement mode.
-   Error analysis view for comparing readings with reference values.
-   Graph view for plotting measurement samples.
-   Timed data logging and statistics interface.
-   Continuity feedback and audible indication where enabled.
-   Responsive layout intended for desktop and mobile browsers.

### Error analysis

The error analysis view is intended to compare a measured value against
a reference value. Typical calculations are:

-   **Absolute error:** `|measured value − reference value|`
-   **Relative error:** `absolute error / |reference value| × 100%`
-   **Accuracy estimate:** `100% − relative error (%)`

Relative error is undefined when the reference value is zero. These
calculations also require the measured and reference values to use the
same units and represent the same quantity. An accuracy estimate is not
a substitute for instrument calibration or a traceable uncertainty
analysis.

### Simulated and live data

When the dashboard is running without an active hardware data
connection, readings may be simulated. Check the current software's data
source and connection status before treating a displayed number as a
physical measurement.

## 🔌 Hardware

The firmware project is located in `hardware/`.

### Core platform

-   **ESP32 DevKit** --- Runs the firmware, handles supported
    measurement processing, updates the local display, and provides
    wireless connectivity.
-   **Local display** --- Presents the current reading and device state.
    Confirm the exact display model and pin mapping from the current
    wiring and source code.
-   **Physical controls** --- Buttons and/or a selector operate the
    functions supported by the assembled version.
-   **Measurement circuitry** --- Input conditioning, sensing, and
    protection must be designed for each measurement mode.
-   **Test probes and connectors** --- Must be wired to the correct
    protected input path for the selected mode.

### Measurement circuit considerations

A multimeter is more than a microcontroller and an ADC. Voltage
measurement requires an appropriately rated input divider and
protection. Resistance measurement requires a defined excitation and
measurement path. Continuity needs a suitable threshold and
current-limited test circuit. Current measurement requires a properly
rated sensing path and protection. Temperature requires a compatible
sensor and suitable signal conditioning.

The exact component list, pin mapping, ranges, and ratings should be
documented from the final verified schematic rather than inferred from
the dashboard.

## 📡 Communication

VOLTEX is designed to connect its embedded instrument to the dashboard
wirelessly when supported by the active firmware and browser/device.

For a Bluetooth Low Energy (BLE) implementation: 1. The ESP32 firmware
initializes the BLE service and characteristics. 2. The dashboard
requests a connection using a browser/device that supports the required
Web Bluetooth APIs. 3. The firmware sends measurement updates and can
receive supported dashboard commands. 4. The dashboard updates its
reading and interface from received data. 5. Device-side controls should
update the dashboard when the firmware publishes the corresponding state
or reading.

**Compatibility note:** Web Bluetooth support varies by browser,
operating system, and security context. A deployed website generally
needs HTTPS, except for permitted local development contexts. Hosting
the dashboard does not upload firmware to the ESP32; firmware is built
and uploaded separately through PlatformIO.

The precise UUIDs, message format, update rate, reconnection behavior,
and supported commands should be documented from the current firmware
and dashboard code.

## 🚀 Run the Software

### Prerequisites

-   [Node.js](https://nodejs.org/) with npm
-   Git (recommended)
-   A modern browser

### Install dependencies

From the repository root:

``` bash
cd software
npm install
```

### Start the development server

``` bash
npm run dev
```

Open the local URL printed by Vite in the terminal (commonly
`http://localhost:5173`).

### Create a production build

``` bash
npm run build
```

### Preview the production build

``` bash
npm run preview
```

The generated front-end build is written to `software/dist/`. This
folder is a build artifact and should not be committed.

## 🧰 Build and Upload Firmware

### Prerequisites

-   [Visual Studio Code](https://code.visualstudio.com/)
-   PlatformIO IDE extension, or a working PlatformIO Core installation
-   Compatible ESP32 board and USB data cable

### Build the firmware

From the repository root:

``` bash
cd hardware
pio run
```

Alternatively, open the `hardware/` folder as a PlatformIO project in VS
Code and use the PlatformIO **Build** action.

### Upload to the ESP32

1.  Connect the ESP32 using a suitable USB data cable.
2.  Confirm the board and upload settings in `hardware/platformio.ini`.
3.  Build the project.
4.  Use PlatformIO's **Upload** action, or run:

``` bash
pio run --target upload
```

5.  If needed, open PlatformIO's Serial Monitor and select the baud rate
    configured by the firmware.

The correct board, libraries, pins, and serial settings are defined by
the actual `platformio.ini` and source code. Do not copy pin assignments
from a generic example without checking the hardware.

## ⚙️ Configuration and Troubleshooting

### Keep the projects independent

-   Run npm commands from `software/`.
-   Run PlatformIO commands from `hardware/`.
-   Keep `software/package.json` and `software/package-lock.json`
    together.
-   Keep `hardware/platformio.ini` with the firmware source.
-   Do not commit `software/node_modules/` or `hardware/.pio/`.

### Dashboard does not connect to the ESP32

-   Confirm the firmware is running and the wireless service is
    initialized.
-   Check browser and operating-system support for the selected
    communication API.
-   Confirm the dashboard's service/characteristic identifiers match the
    firmware.
-   Check browser permissions and connection status.
-   Use the browser's developer console and the ESP32 serial monitor to
    inspect errors.

### Firmware fails to build or upload

-   Open the `hardware/` directory as the PlatformIO project.
-   Check the board and framework in `platformio.ini`.
-   Confirm the USB cable supports data.
-   Check that the correct serial port is selected and no other
    application is using it.
-   Review compiler and upload output before changing libraries or pin
    assignments.

### Local display and dashboard disagree

-   Check whether both displays are using the latest measurement sample.
-   Verify that the firmware publishes an updated value after a button
    action or new measurement.
-   Check units, rounding, update timing, and message parsing on both
    sides.
-   Avoid hard-coding readings; use the actual measurement data path.

## 🗺️ Development Roadmap

Update these checkboxes as each item is tested on the actual project.

-   [x] Create a React/Vite dashboard foundation.
-   [x] Develop the VOLTEX visual interface and measurement views.
-   [x] Add error-analysis and graph/statistics UI.
-   [x] Establish a separate PlatformIO firmware project.
-   [ ] Verify all measurement circuits against the final schematic.
-   [ ] Validate input protection and component ratings for every mode.
-   [ ] Calibrate voltage, resistance, current, and temperature
    measurements as applicable.
-   [x] Verify BLE connection, data format, and two-way command
    handling.
-   [x] Verify that device-side controls and dashboard-side controls
    remain synchronized.
-   [x] Test update latency and behavior after disconnect/reconnect.
-   [ ] Validate repeatability against suitable reference instruments.
-   [ ] Document final pin mapping, component values, ranges, and
    calibration procedure.
-   [ ] Add persistent data export or other planned features if
    implemented.

## ⚠️ Safety and Limitations

VOLTEX is an educational prototype, not a certified commercial
multimeter.

-   **Never connect an unverified prototype to mains electricity.**
-   Use only low-voltage, current-limited test sources appropriate to
    the verified circuit.
-   Resistance and continuity tests must only be performed on
    de-energized circuits.
-   Never exceed the verified voltage, current, power, or input ratings
    of any component.
-   A fuse alone does not make an input safe; protection depends on the
    full circuit design, component ratings, layout, and enclosure.
-   Do not assume the instrument is isolated or CAT-rated unless it has
    been designed and tested to the relevant requirements.
-   Simulated values, uncalibrated readings, and UI accuracy
    calculations must not be used for safety-critical decisions.

## 🤝 Contributors

Add the project team members and their roles here, for example:

-   **Hardware and firmware:** `Rudra Prasad, Sai Ayushman`
-   **Dashboard and software:** `Sai Ayushman`
-   **Testing and documentation:** `Rudra Prasad, Sai Ayushman`
-   **Financial support:** `Group-2 ETC 5th Sem (2026)`


## 📄 License

No license is specified here. Choose a license that reflects how the
team wants the code and documentation to be reused, then add the
corresponding `LICENSE` file to the repository. Until then, do not
assume others have permission to redistribute or reuse the project.

------------------------------------------------------------------------

**VOLTEX** --- *From physical measurements to intelligent
visualization.* ⚡
