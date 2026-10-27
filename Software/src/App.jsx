
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { BlockMath } from "react-katex";
import "katex/dist/katex.min.css";
import "./index.css";

const MODES = {
  STANDBY: { label: "STANDBY", color: "#9ca3af", angle: -90 },
  OFF: { label: "OFF", color: "#374151", angle: -90 },
  V_DC: { label: "V DC", color: "#4ade80", angle: -18 },
  RESISTANCE: { label: "RESISTANCE", color: "#d946ef", angle: 54 },
  CONTINUITY: { label: "CONTINUITY", color: "#facc15", angle: 126 },
  TEMPERATURE: { label: "TEMPERATURE", color: "#f97316", angle: 198 },
};

const VOLTEX_BLE_SERVICE_UUID = "12345678-1234-1234-1234-1234567890ab";
const VOLTEX_BLE_CHARACTERISTIC_UUID = "12345678-1234-1234-1234-1234567890ac";

function readHardwareValue(mode, packet) {
  if (!packet) return null;
  switch (mode) {
    case "V_DC": return Number.isFinite(packet.voltageV) ? packet.voltageV : null;
    case "RESISTANCE": return Number.isFinite(packet.resistanceOhm) ? packet.resistanceOhm : null;
    case "CONTINUITY": return typeof packet.continuityClosed === "boolean" ? (packet.continuityClosed ? 1 : 0) : null;
    case "TEMPERATURE": return Number.isFinite(packet.temperatureC) ? packet.temperatureC : null;
    default: return null;
  }
}

const STAT_METRICS = [
  {
    name: "Arithmetic Mean",
    latex: String.raw`\bar{x} = \frac{\sum_{i=1}^{n} x_i}{n}`,
    calculate: (values, avg) => avg,
  },
  {
    name: "Average Deviation",
    latex: String.raw`\mathrm{AD} = \frac{\sum_{i=1}^{n}|x_i-\bar{x}|}{n}`,
    calculate: (values, avg) =>
      values.reduce((sum, value) => sum + Math.abs(value - avg), 0) /
      values.length,
  },
  {
    name: "Standard Deviation",
    latex: String.raw`\sigma = \sqrt{\frac{\sum_{i=1}^{n}(x_i-\bar{x})^2}{n}}`,
    calculate: (values, avg) =>
      Math.sqrt(
        values.reduce((sum, value) => sum + (value - avg) ** 2, 0) /
          values.length,
      ),
  },
  {
    name: "Variance",
    latex: String.raw`\sigma^2 = \frac{\sum_{i=1}^{n}(x_i-\bar{x})^2}{n}`,
    calculate: (values, avg) =>
      values.reduce((sum, value) => sum + (value - avg) ** 2, 0) /
      values.length,
  },
  {
    name: "Probable Error",
    latex: String.raw`r = 0.6745 \times \sigma`,
    calculate: (values, avg) => {
      const variance =
        values.reduce((sum, value) => sum + (value - avg) ** 2, 0) /
        values.length;
      return 0.6745 * Math.sqrt(variance);
    },
  },
  {
    name: "Mean Probable Error",
    latex: String.raw`r_{\bar{x}} = \frac{0.6745\sigma}{\sqrt{n}}`,
    calculate: (values, avg) => {
      const variance =
        values.reduce((sum, value) => sum + (value - avg) ** 2, 0) /
        values.length;
      return (0.6745 * Math.sqrt(variance)) / Math.sqrt(values.length);
    },
  },
  {
    name: "Std. Deviation of Mean",
    latex: String.raw`\sigma_{\bar{x}} = \frac{\sigma}{\sqrt{n}}`,
    calculate: (values, avg) => {
      const variance =
        values.reduce((sum, value) => sum + (value - avg) ** 2, 0) /
        values.length;
      return Math.sqrt(variance) / Math.sqrt(values.length);
    },
  },
  {
    name: "Minimum Range of Error",
    latex: String.raw`E_{\min} = \bar{x} - x_{\min}`,
    calculate: (values, avg) => avg - Math.min(...values),
  },
  {
    name: "Maximum Range of Error",
    latex: String.raw`E_{\max} = x_{\max} - \bar{x}`,
    calculate: (values, avg) => Math.max(...values) - avg,
  },
];

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatNumber(value, digits = 4) {
  if (!Number.isFinite(value)) return "—";
  return Number(value.toPrecision(digits)).toString();
}

function getMeasurement(mode, reading) {
  if (!Number.isFinite(reading)) return { value: "—", unit: "" };
  if (mode === "V_DC") {
    if (Math.abs(reading) > 0 && Math.abs(reading) < 1) {
      return { value: (reading * 1000).toFixed(1), unit: "mV" };
    }
    return { value: reading.toFixed(3), unit: "V" };
  }

  if (mode === "RESISTANCE") {
    const absolute = Math.abs(reading);
    if (absolute >= 1_000_000) {
      return { value: (reading / 1_000_000).toFixed(2), unit: "MΩ" };
    }
    if (absolute >= 1_000) {
      return { value: (reading / 1_000).toFixed(2), unit: "kΩ" };
    }
    return { value: reading.toFixed(1), unit: "Ω" };
  }

  if (mode === "TEMPERATURE") {
    return { value: reading.toFixed(1), unit: "°C" };
  }

  return { value: "—", unit: "" };
}

function simulateReading(mode) {
  switch (mode) {
    case "V_DC":
      return 0.045 + Math.random() * 0.008;
    case "RESISTANCE":
      return 12_500 + Math.random() * 250;
    case "TEMPERATURE":
      return 25 + Math.sin(Date.now() / 1500) * 2 + Math.random() * 0.4;
    case "CONTINUITY":
      return Math.random() > 0.25 ? 1 : 0;
    default:
      return 0;
  }
}

function DisplayScreen({ mode, reading, continuityClosed, powered, demoOn = false, shuttingDown = false, shutdownProgress = 0, hardwareConnected = false, shutdownDialOnly = false, holdEnabled = false, middleView = "DIAL" }) {
  const config = MODES[mode];
  const measurement = getMeasurement(mode, reading);
  const isContinuity = mode === "CONTINUITY";
  const inputUnavailable = mode !== "STANDBY" && hardwareConnected && powered && !shuttingDown && !demoOn && !Number.isFinite(reading);
  // N/A is reserved for the unsupported Error Analysis state in Continuity/Standby.
  // Missing measurement inputs in actual measurement modes use NO DATA in that mode's colour.
  const analysisUnavailable = middleView === "ERROR_ANALYSIS" && (mode === "CONTINUITY" || mode === "STANDBY");
  const displayUnavailable = inputUnavailable || analysisUnavailable;
  const color = powered ? config.color : "#4b5563";
  const displayColor = analysisUnavailable ? "#ef4444" : color;

  let mainText = mode === "STANDBY" ? "READY" : measurement.value;
  let unit = measurement.unit;

  if (mode === "STANDBY" && !demoOn && !shuttingDown) {
    mainText = "READY";
    unit = "";
  }

  if (displayUnavailable) {
    mainText = analysisUnavailable ? "N/A" : "NO DATA";
    unit = "";
  } else if (!powered || (shuttingDown && shutdownProgress >= 5)) {
    mainText = "- - - -";
    unit = "";
  } else if (shuttingDown && !shutdownDialOnly) {
    mainText = isContinuity ? String(Math.round(reading)) : demoOn ? String(Math.round(reading)) : measurement.value;
    unit = isContinuity || demoOn ? "" : measurement.unit;
  } else if (demoOn) {
    mainText = String(Math.round(reading));
    unit = "";
  } else if (isContinuity) {
    mainText = hardwareConnected && !Number.isFinite(reading) ? "N/A" : continuityClosed ? "CLOSE" : "OPEN";
    unit = Number.isFinite(reading) || !hardwareConnected ? "circuit" : "";
  }

  return (
    <section
      className={`lcd-screen ${powered ? "lcd-on" : "lcd-off"}`}
      style={{
        "--mode-color": displayColor,
        "--mode-glow": powered ? `${displayColor}75` : "transparent",
      }}
      aria-label="Measurement display"
    >
      <div className="lcd-scanlines" aria-hidden="true" />
      <div className="lcd-glare" aria-hidden="true" />
      <div className="lcd-topline">
        {holdEnabled && powered && !shuttingDown && (
          <span
            className="lcd-hold-indicator"
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              color: color,
              fontWeight: 700,
              letterSpacing: "0.12em",
              textShadow: `0 0 8px ${color}80`,
            }}
            aria-live="polite"
          >
            <span
              aria-hidden="true"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 10,
                lineHeight: 1,
                letterSpacing: 0,
                color,
                textShadow: `0 0 8px ${color}90`,
              }}
            >
              ⏸
            </span>
            <span>HOLD</span>
          </span>
        )}
        <span
          className="status-dot"
          style={analysisUnavailable ? { background: "#ef4444", boxShadow: "0 0 8px #ef444480" } : undefined}
        />
        <span style={analysisUnavailable ? { color: "#ef4444", textShadow: "0 0 8px #ef444480" } : undefined}>
          SYSTEM {powered && !shuttingDown ? "ONLINE" : "OFFLINE"}
        </span>
      </div>

      <div className="lcd-reading">
        <div className="lcd-value-row">
          <span
            className={`lcd-value ${isContinuity ? "lcd-continuity" : ""}`}
            style={{
              color: powered ? displayColor : "#374151",
              textShadow: powered
                ? `0 0 8px ${displayColor}90, 0 0 20px ${displayColor}85, 0 0 42px ${displayColor}55`
                : "none",
            }}
          >
            {mainText}
          </span>
          {unit && (
            <span className="lcd-unit" style={{ color: displayColor }}>
              {unit}
            </span>
          )}
        </div>

        {powered && !shuttingDown && <div className="lcd-baseline animate-pulse" />}
      </div>

      <div className="lcd-bottomline">
        <span style={displayUnavailable ? { color: analysisUnavailable ? "#ef4444" : color, textShadow: analysisUnavailable ? "0 0 6px #ef444450" : "none" } : undefined}>
          {!powered || shuttingDown ? "STANDBY" : demoOn ? "POWER ON SELF TEST" : displayUnavailable ? "INPUT UNAVAILABLE" : config.label}
        </span>
        <span>{!powered || shuttingDown ? "NO SIGNAL" : demoOn ? "SWEEP / READY" : mode === "STANDBY" ? "WAITING FOR MODE" : hardwareConnected ? "LIVE HARDWARE" : "SIMULATED"}</span>
      </div>
    </section>
  );
}

function SelectorDial({ mode, onSelect, powered, demoOn = false, demoValue = 0, shuttingDown = false, shutdownProgress = 0, shutdownAngle = 0 }) {
  const center = 150;
  const radius = 91;
  const labelRadius = 123;
  const arcHalfAngle = 29;
  const order = ["STANDBY", "V_DC", "RESISTANCE", "CONTINUITY", "TEMPERATURE"];

  const point = (r, degrees) => {
    const radians = (degrees * Math.PI) / 180;
    return {
      x: center + r * Math.cos(radians),
      y: center + r * Math.sin(radians),
    };
  };

  const arcPath = (angle) => {
    const start = point(radius, angle - arcHalfAngle);
    const end = point(radius, angle + arcHalfAngle);
    return `M ${start.x} ${start.y} A ${radius} ${radius} 0 0 1 ${end.x} ${end.y}`;
  };

  const needleAngle = shuttingDown ? shutdownAngle : demoOn ? (demoValue / 9999) * 360 : MODES[mode].angle + 90;
  const activeColor = powered ? MODES[mode].color : "#4b5563";

  return (
    <div className="dial-wrap">
      <svg
        className="selector-svg"
        viewBox="0 0 300 300"
        role="group"
        aria-label="Measurement selector"
        style={{ pointerEvents: mode === "OFF" ? "none" : "auto" }}
      >
        <defs>
          {order.map((key) => (
            <filter
              key={key}
              id={`glow-${key}`}
              x="-100%"
              y="-100%"
              width="300%"
              height="300%"
            >
              <feGaussianBlur stdDeviation="5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          ))}
        </defs>

        {order.map((key) => {
          const config = MODES[key];
          const demoAngle = (demoValue / 9999) * 360 - 90;
          const angleDistance = Math.abs((((demoAngle - config.angle) + 540) % 360) - 180);
          const segmentIndex = order.indexOf(key);
          const extinguished = shuttingDown && segmentIndex >= order.length - Math.floor(shutdownProgress);
          const selected = demoOn ? angleDistance < 36 : mode === key;
          const stroke = powered && !extinguished ? config.color : "#374151";
          const labelPoint = point(labelRadius, config.angle);
          const label =
            key === "V_DC"
              ? "V="
              : key === "RESISTANCE"
                ? "Ω"
                : key === "CONTINUITY"
                  ? "•)))"
                  : key === "TEMPERATURE"
                    ? "°C"
                    : key === "STANDBY" ? (mode === "OFF" ? "OFF" : mode === "STANDBY" ? "STBY" : "ON") : "OFF";

          return (
            <g
              key={key}
              className={`dial-segment ${shuttingDown && extinguished ? "dial-segment-extinguished" : ""}`}
              role="button"
              tabIndex={0}
              aria-label={`Select ${config.label}`}
              onClick={() => { if (key === "STANDBY") onSelect("STANDBY"); else if (powered) onSelect(key); }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  if (key === "STANDBY") onSelect("STANDBY"); else if (powered) onSelect(key);
                }
              }}
            >
              <path
                d={arcPath(config.angle)}
                fill="none"
                stroke={stroke}
                strokeWidth={selected ? 12 : 6}
                strokeLinecap="round"
                opacity={extinguished ? 0.12 : selected ? 1 : powered ? 0.65 : 0.45}
                filter={selected && powered && !extinguished ? `url(#glow-${key})` : undefined}
              />
              <text
                x={labelPoint.x}
                y={labelPoint.y}
                fill={extinguished ? "#374151" : selected && powered ? config.color : powered ? "#9ca3af" : "#4b5563"}
                fontSize={key === "CONTINUITY" ? 12 : 13}
                fontWeight={selected ? 800 : 600}
                textAnchor="middle"
                dominantBaseline="middle"
                className="dial-label"
              >
                {label}
              </text>
            </g>
          );
        })}

        <circle cx={center} cy={center} r="47" fill="#111827" stroke="#293548" strokeWidth="2" />
        <circle cx={center} cy={center} r="36" fill="#0b1120" stroke="#1f2937" strokeWidth="1" />

        <g
          style={{
            transformOrigin: `${center}px ${center}px`,
            transform: `rotate(${needleAngle}deg)`,
            transition: "transform 600ms cubic-bezier(0.34, 1.56, 0.64, 1)",
          }}
        >
          <path
            d={`M ${center} ${center - 6} L ${center - 5} ${center - 43} L ${center} ${center - 54} L ${center + 5} ${center - 43} L ${center} ${center - 6}`}
            fill={activeColor}
            opacity={powered ? 1 : 0.45}
            filter={powered ? `url(#glow-${mode})` : undefined}
          />
        </g>

        <circle
          cx={center}
          cy={center}
          r="8"
          fill={powered ? activeColor : "#374151"}
          stroke="#111827"
          strokeWidth="3"
        />
        <circle cx={center} cy={center} r="3" fill="#e5e7eb" opacity={powered ? 0.9 : 0.2} />
      </svg>
    </div>
  );
}

/* Error and statistics cards: hover/tap swaps the value with rendered KaTeX. */
function MetricCard({ name, value, latex, color = "#ff7f50", compact = false }) {
  const [showFormula, setShowFormula] = useState(false);
  const touchToggle = useRef(false);

  const toggleFormula = () => {
    setShowFormula((previous) => !previous);
  };

  return (
    <article
      className={`metric-card ${compact ? "metric-card-compact" : ""} ${
        showFormula ? "metric-card-formula" : ""
      }`}
      style={{ "--metric-color": color }}
      role="button"
      tabIndex={0}
      aria-label={`${name}: ${value}. Activate to ${showFormula ? "show value" : "show formula"}.`}
      aria-pressed={showFormula}
      onMouseEnter={() => {
        if (!touchToggle.current) setShowFormula(true);
      }}
      onMouseLeave={() => {
        if (!touchToggle.current) setShowFormula(false);
      }}
      onTouchStart={() => {
        touchToggle.current = true;
      }}
      onClick={toggleFormula}
      onFocus={() => setShowFormula(true)}
      onBlur={() => {
        if (!touchToggle.current) setShowFormula(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggleFormula();
        }
      }}
    >
      <span className="metric-name">{name}</span>

      <div className="metric-swap">
        <strong
          className={`metric-value metric-swap-face ${
            showFormula ? "metric-face-hidden" : "metric-face-visible"
          }`}
          aria-hidden={showFormula}
        >
          {value}
        </strong>

        <div
          className={`metric-formula metric-swap-face ${
            showFormula ? "metric-face-visible" : "metric-face-hidden"
          }`}
          aria-hidden={!showFormula}
        >
          {latex ? <BlockMath math={latex} /> : <span>No formula available</span>}
        </div>
      </div>
    </article>
  );
}

function ErrorAnalysis({ mode, readingValue, onExit, onDisplayModeChange, onRequestHardwareMode, isPaused, onTogglePause, hardwareConnected = false, hardwarePacket = null }) {
  // Use the shared app-level pause state so both the physical HOLD button
  // and this dashboard button update the same label and captured reading.
  const toggleCapture = () => onTogglePause?.();
  // Pick the correct tab on the very first render. Initializing to VOLTAGE and
  // correcting it in an effect caused a visible Voltage → Temperature flicker.
  const initialAnalysisTab = mode === "RESISTANCE"
    ? "RESISTANCE"
    : mode === "TEMPERATURE"
      ? "TEMPERATURE"
      : "VOLTAGE";
  const initialStatsMode = mode === "RESISTANCE" || mode === "TEMPERATURE"
    ? mode
    : "VOLTAGE";
  const [tab, setTab] = useState(initialAnalysisTab);
  const [statsMode, setStatsMode] = useState(initialStatsMode);
  const [referenceVoltage, setReferenceVoltage] = useState("00.00");
  const [referenceResistance, setReferenceResistance] = useState("00.00");
  const [referenceTemperature, setReferenceTemperature] = useState("00.00");
  const [tolerance, setTolerance] = useState("5");
  const [isLoggingData, setIsLoggingData] = useState(false);
  const [logProgress, setLogProgress] = useState(0);
  const [loggedReadings, setLoggedReadings] = useState([]);
  const logStartRef = useRef(null);
  const sampleTimerRef = useRef(null);
  const stopTimerRef = useRef(null);
  const samplesRef = useRef([]);
  const hardwarePacketRef = useRef(hardwarePacket);
  hardwarePacketRef.current = hardwarePacket;
  const selectedStatsMode = statsMode === "VOLTAGE" ? "V_DC" : statsMode;

  // Keep the visible Error Analysis tab aligned with mode changes made on the
  // physical ESP32 button. This effect only changes the tab; it does not send
  // a command back to the hardware.
  useEffect(() => {
    // Keep Statistics selected while its parameter changes the hardware mode.
    // Outside Statistics, follow physical/dashboard measurement-mode changes.
    if (tab !== "STATISTICS") {
      if (mode === "V_DC") setTab("VOLTAGE");
      else if (mode === "RESISTANCE") setTab("RESISTANCE");
      else if (mode === "TEMPERATURE") setTab("TEMPERATURE");
    }

    if (mode === "V_DC") setStatsMode("VOLTAGE");
    else if (mode === "RESISTANCE" || mode === "TEMPERATURE") setStatsMode(mode);
  }, [mode]);

  useEffect(() => {
    const displayMode = tab === "VOLTAGE"
      ? "V_DC"
      : tab === "RESISTANCE"
        ? "RESISTANCE"
        : tab === "TEMPERATURE"
          ? "TEMPERATURE"
          : selectedStatsMode;
    onDisplayModeChange(displayMode);
  }, [tab, selectedStatsMode, onDisplayModeChange]);

  const measuredVoltage = mode === "V_DC" ? readingValue : hardwareConnected ? null : 0.05;
  const measuredResistance = mode === "RESISTANCE" && Number.isFinite(readingValue) ? readingValue / 1000 : hardwareConnected ? null : 12.5;
  const measuredTemperature = mode === "TEMPERATURE" && Number.isFinite(readingValue) ? readingValue : hardwareConnected ? null : 25 + Math.sin(Date.now() / 1500) * 2;

  const voltageRef = Number(referenceVoltage);
  const voltageError = Number.isFinite(measuredVoltage) ? measuredVoltage - voltageRef : null;
  const voltageAbsError = voltageError === null ? null : Math.abs(voltageError);
  const voltageRelative =
    Number.isFinite(voltageRef) && voltageRef !== 0
      && voltageAbsError !== null
      ? (voltageAbsError / Math.abs(voltageRef)) * 100
      : null;
  const voltageAccuracy =
    voltageRelative !== null ? Math.max(0, 100 - voltageRelative) : null;

  const resistanceRef = Number(referenceResistance);
  const toleranceNumber = Number(tolerance);
  const resistanceAbsError = Number.isFinite(measuredResistance) ? Math.abs(measuredResistance - resistanceRef) : null;
  const resistanceRelative =
    Number.isFinite(resistanceRef) && resistanceRef !== 0
      && resistanceAbsError !== null
      ? (resistanceAbsError / Math.abs(resistanceRef)) * 100
      : null;
  const allowedTolerance = Math.abs(resistanceRef * (toleranceNumber / 100));
  const withinTolerance = resistanceAbsError !== null && resistanceAbsError <= allowedTolerance;

  const temperatureRef = Number(referenceTemperature);
  const temperatureAbsError = Number.isFinite(measuredTemperature)
    ? Math.abs(measuredTemperature - temperatureRef)
    : null;
  const temperatureRelative =
    Number.isFinite(temperatureRef) && temperatureRef !== 0 && temperatureAbsError !== null
      ? (temperatureAbsError / Math.abs(temperatureRef)) * 100
      : null;
  const temperatureAccuracy =
    temperatureRelative !== null ? Math.max(0, 100 - temperatureRelative) : null;

  const stats = useMemo(() => {
    const values = loggedReadings;
    if (!values.length) return [];
    const average = mean(values);
    return STAT_METRICS.map((metric) => ({
      name: metric.name,
      latex: metric.latex,
      value: formatNumber(metric.calculate(values, average)),
    }));
  }, [loggedReadings]);

  const deviations = useMemo(() => {
    if (!loggedReadings.length) return [];
    const average = mean(loggedReadings);
    return loggedReadings.map((value, index) => ({
      sample: index + 1,
      value,
      deviation: value - average,
    }));
  }, [loggedReadings]);

  const stopLog = useCallback(() => {
    clearInterval(sampleTimerRef.current);
    clearTimeout(stopTimerRef.current);
    sampleTimerRef.current = null;
    stopTimerRef.current = null;
    setIsLoggingData(false);
  }, []);

  useEffect(() => () => stopLog(), [stopLog]);

  const startLog = () => {
    if (isLoggingData) return;
    if (hardwareConnected && !Number.isFinite(readHardwareValue(statsMode === "VOLTAGE" ? "V_DC" : statsMode, hardwarePacket))) return;

    clearInterval(sampleTimerRef.current);
    clearTimeout(stopTimerRef.current);

    samplesRef.current = [];
    setLoggedReadings([]);
    setLogProgress(0);
    setIsLoggingData(true);
    logStartRef.current = Date.now();

    const captureSample = () => {
      if (samplesRef.current.length >= 30) return;

      const sampleMode =
        statsMode === "VOLTAGE" ? "V_DC" : statsMode;
      const value = hardwareConnected
        ? readHardwareValue(sampleMode, hardwarePacketRef.current)
        : simulateReading(sampleMode);
      if (!Number.isFinite(value)) {
        setIsLoggingData(false);
        clearInterval(sampleTimerRef.current);
        clearTimeout(stopTimerRef.current);
        sampleTimerRef.current = null;
        stopTimerRef.current = null;
        return;
      }

      samplesRef.current = [...samplesRef.current, value];
      setLoggedReadings(samplesRef.current);

      const elapsed = Date.now() - logStartRef.current;
      setLogProgress(Math.min(100, (elapsed / 15000) * 100));

      if (samplesRef.current.length >= 30) {
        clearInterval(sampleTimerRef.current);
        clearTimeout(stopTimerRef.current);
        sampleTimerRef.current = null;
        stopTimerRef.current = null;
        setLogProgress(100);
        setIsLoggingData(false);
      }
    };

    captureSample();
    sampleTimerRef.current = setInterval(captureSample, 500);

    stopTimerRef.current = setTimeout(() => {
      clearInterval(sampleTimerRef.current);
      sampleTimerRef.current = null;
      setLogProgress(100);
      setIsLoggingData(false);
    }, 15000);
  };

  const supportedAnalysisMode = ["V_DC", "RESISTANCE", "TEMPERATURE"].includes(mode);

  if (!supportedAnalysisMode) {
    return (
      <section className="analysis-panel">
        <div className="analysis-scroll">
          <div className="analysis-heading">
            <div>
              <span className="eyebrow">DIAGNOSTICS / CALIBRATION</span>
              <h2>Error Analysis</h2>
            </div>
            <span className="analysis-status">UNAVAILABLE</span>
          </div>
          <div className="statistics-placeholder">
            <span className="placeholder-icon">—</span>
            <span>No Error Analysis for current mode</span>
            <small>{mode === "CONTINUITY"
              ? "Continuity checks circuit open/closed state rather than measurement error."
              : "Select Voltage, Resistance, or Temperature mode to run error analysis and statistics."}</small>
          </div>
        </div>
        <button type="button" className="exit-button" onClick={onExit}>
          ← Back to Multimeter
        </button>
      </section>
    );
  }

  return (
    <section className="analysis-panel">
      <div className="analysis-scroll">
        <div className="analysis-heading">
          <div>
            <span className="eyebrow">DIAGNOSTICS / CALIBRATION</span>
            <h2>Error Analysis</h2>
          </div>
          <span className="analysis-status">LAB MODE</span>
        </div>

        <div className="analysis-tabs">
          {[
            { id: "VOLTAGE", label: "Voltage Error", color: "#4ade80" },
            { id: "RESISTANCE", label: "Resistance Error", color: "#d946ef" },
            { id: "TEMPERATURE", label: "Temperature Error", color: "#f97316" },
            { id: "STATISTICS", label: "Statistics", color: "#06b6d4" },
          ].map((item) => (
            <button
              key={item.id}
              type="button"
              className={`analysis-tab ${tab === item.id ? "analysis-tab-active" : ""}`}
              style={{ "--tab-color": item.color }}
              onClick={() => {
                setTab(item.id);
                const requestedMode = item.id === "VOLTAGE" ? "V_DC" : item.id;
                if (["V_DC", "RESISTANCE", "TEMPERATURE"].includes(requestedMode)) {
                  onRequestHardwareMode?.(requestedMode);
                }
              }}
            >
              {item.label}
            </button>
          ))}
        </div>

        {tab === "VOLTAGE" && (
          <div className="analysis-content">
            <div>
              <label className="field-label" htmlFor="reference-voltage">
                Reference voltage (V)
              </label>
              <input
                id="reference-voltage"
                className="analysis-input"
                type="number"
                step="any"
                value={referenceVoltage}
                onChange={(event) => setReferenceVoltage(event.target.value)}
              />
            </div>

            <div className="metrics-grid">
              <MetricCard
                name="Measured value"
                value={`${formatNumber(measuredVoltage)} V`}
                latex={String.raw`V_m = \text{measured voltage}`}
                color="#4ade80"
              />
              <MetricCard
                name="Absolute error"
                value={`${formatNumber(voltageAbsError)} V`}
                latex={String.raw`E_a = |V_m - V_r|`}
                color="#4ade80"
              />
              <MetricCard
                name="Relative error"
                value={voltageRelative === null ? "—" : `${formatNumber(voltageRelative)}%`}
                latex={String.raw`E_r = \frac{|V_m-V_r|}{|V_r|}\times 100\%`}
                color="#4ade80"
              />
              <MetricCard
                name="Accuracy estimate"
                value={voltageAccuracy === null ? "—" : `${formatNumber(voltageAccuracy)}%`}
                latex={String.raw`\text{Accuracy} = 100\% - E_r`}
                color="#4ade80"
              />
            </div>
            <div className="capture-reading-row">
              <button type="button" className={`capture-reading-button ${isPaused ? "is-resuming" : ""}`} onClick={toggleCapture}>
                {isPaused ? "▶ Resume Readings" : "■ Stop & Capture Reading"}
              </button>
            </div>
            <p className="analysis-note">
              {isPaused ? "Reading held on screen; error values use this captured sample." : "Reference and measured values are simulated. Stop readings to hold one sample for error checking."}
            </p>
          </div>
        )}

        {tab === "RESISTANCE" && (
          <div className="analysis-content">
            <div className="field-row">
              <div>
                <label className="field-label" htmlFor="reference-resistance">
                  Reference resistance (kΩ)
                </label>
                <input
                  id="reference-resistance"
                  className="analysis-input"
                  type="number"
                  step="any"
                  value={referenceResistance}
                  onChange={(event) => setReferenceResistance(event.target.value)}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="tolerance">
                  Tolerance (%)
                </label>
                <input
                  id="tolerance"
                  className="analysis-input"
                  type="number"
                  min="0"
                  step="any"
                  value={tolerance}
                  onChange={(event) => setTolerance(event.target.value)}
                />
              </div>
            </div>

            <div className="metrics-grid">
              <MetricCard
                name="Measured value"
                value={`${formatNumber(measuredResistance)} kΩ`}
                latex={String.raw`R_m = \frac{\text{measured }\Omega}{1000}`}
                color="#d946ef"
              />
              <MetricCard
                name="Absolute error"
                value={`${formatNumber(resistanceAbsError)} kΩ`}
                latex={String.raw`E_a = |R_m - R_r|`}
                color="#d946ef"
              />
              <MetricCard
                name="Relative error"
                value={resistanceRelative === null ? "—" : `${formatNumber(resistanceRelative)}%`}
                latex={String.raw`E_r = \frac{|R_m-R_r|}{|R_r|}\times 100\%`}
                color="#d946ef"
              />
              <MetricCard
                name="Tolerance status"
                value={
                  Number.isFinite(allowedTolerance) && resistanceRef !== 0 && toleranceNumber >= 0
                    ? withinTolerance
                      ? "WITHIN"
                      : "OUTSIDE"
                    : "—"
                }
                latex={String.raw`|R_m-R_r| \leq \frac{R_r \times T}{100}`}
                color="#d946ef"
              />
            </div>
            <div className="capture-reading-row">
              <button type="button" className={`capture-reading-button ${isPaused ? "is-resuming" : ""}`} onClick={toggleCapture}>
                {isPaused ? "▶ Resume Readings" : "■ Stop & Capture Reading"}
              </button>
            </div>

            <p className="analysis-note">
              {isPaused ? "Reading held on screen; error values use this captured sample." : "Resistance is expressed in kΩ. Stop readings to hold one sample; tolerance status compares absolute error against the selected tolerance band."}
            </p>
          </div>
        )}

        {tab === "TEMPERATURE" && (
          <div className="analysis-content">
            <div>
              <label className="field-label" htmlFor="reference-temperature">
                Reference temperature (°C)
              </label>
              <input
                id="reference-temperature"
                className="analysis-input"
                type="number"
                step="any"
                value={referenceTemperature}
                onChange={(event) => setReferenceTemperature(event.target.value)}
              />
            </div>

            <div className="metrics-grid">
              <MetricCard
                name="Measured value"
                value={`${formatNumber(measuredTemperature)} °C`}
                latex={String.raw`T_m = \text{measured temperature}`}
                color="#f97316"
              />
              <MetricCard
                name="Absolute error"
                value={temperatureAbsError === null ? "—" : `${formatNumber(temperatureAbsError)} °C`}
                latex={String.raw`E_a = |T_m - T_r|`}
                color="#f97316"
              />
              <MetricCard
                name="Relative error"
                value={temperatureRelative === null ? "—" : `${formatNumber(temperatureRelative)}%`}
                latex={String.raw`E_r = \frac{|T_m-T_r|}{|T_r|}\times 100\%`}
                color="#f97316"
              />
              <MetricCard
                name="Accuracy estimate"
                value={temperatureAccuracy === null ? "—" : `${formatNumber(temperatureAccuracy)}%`}
                latex={String.raw`\text{Accuracy} = 100\% - E_r`}
                color="#f97316"
              />
            </div>
            <div className="capture-reading-row">
              <button type="button" className={`capture-reading-button ${isPaused ? "is-resuming" : ""}`} onClick={toggleCapture}>
                {isPaused ? "▶ Resume Readings" : "■ Stop & Capture Reading"}
              </button>
            </div>
            <p className="analysis-note">
              {isPaused
                ? "Reading held on screen; temperature error values use this captured sample."
                : hardwareConnected
                  ? "Compare the live temperature reading with a reference thermometer. Stop readings to capture one sample for error checking."
                  : "Temperature is simulated in demo mode. Stop readings to hold one sample; use a reference thermometer value for meaningful calibration."}
            </p>
          </div>
        )}

        {tab === "STATISTICS" && (
          <div className="analysis-content statistics-content">
            <div className="stats-mode-field">
              <label className="field-label" htmlFor="stats-mode">Measurement parameter</label>
              <select
                id="stats-mode"
                className="analysis-input stats-mode-select"
                value={statsMode}
                onChange={(event) => {
                  const nextStatsMode = event.target.value;
                  setStatsMode(nextStatsMode);
                  onRequestHardwareMode?.(nextStatsMode === "VOLTAGE" ? "V_DC" : nextStatsMode);
                }}
                disabled={isLoggingData}
              >
                <option value="VOLTAGE">Voltage (V)</option>
                <option value="RESISTANCE">Resistance (Ω)</option>
                <option value="TEMPERATURE">Temperature (°C)</option>
              </select>
            </div>
            <div className="log-summary">
              <div>
                <span className="field-label">15-SECOND DATA CAPTURE</span>
                <strong>{loggedReadings.length}/30 <span>samples</span></strong>
              </div>
              <button
                type="button"
                className="primary-action cyan-action"
                onClick={startLog}
                disabled={isLoggingData || (hardwareConnected && !Number.isFinite(readHardwareValue(selectedStatsMode, hardwarePacket)))}
              >
                {isLoggingData ? "Logging…" : "Start 15s Data Log"}
              </button>
            </div>

            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${logProgress}%` }} />
            </div>

            <p className="analysis-note">
              {hardwareConnected && !Number.isFinite(readHardwareValue(selectedStatsMode, hardwarePacket))
                ? "This measurement is not available from the connected firmware yet. Voltage, resistance and continuity acquisition must be implemented before logging them."
                : isLoggingData
                ? `Capturing readings… ${Math.round(logProgress)}%`
                : logProgress === 100
                  ? "Capture complete · collected samples shown below"
                  : "One sample every 500 ms. The 9 metrics and sample list appear after capture."}
            </p>

            {logProgress === 100 && loggedReadings.length === 30 ? (
              <>
                <div className="metrics-grid stats-grid">
                  {stats.map((metric) => (
                    <MetricCard
                      key={metric.name}
                      name={metric.name}
                      value={metric.value}
                      latex={metric.latex}
                      color="#06b6d4"
                      compact
                    />
                  ))}
                </div>

                <div className="sample-list-heading">
                  <h3>Recorded Samples</h3>
                  <span>30 READINGS</span>
                </div>

                <div className="sample-table">
                  <div className="sample-row sample-row-header">
                    <span>NO.</span>
                    <span>VALUE</span>
                    <span>DEVIATION</span>
                  </div>
                  {deviations.map((sample) => (
                    <div className="sample-row" key={sample.sample}>
                      <span className="sample-index">
                        {String(sample.sample).padStart(2, "0")}
                      </span>
                      <span>{formatNumber(sample.value, 6)}</span>
                      <span className={sample.deviation < 0 ? "deviation-negative" : "deviation-positive"}>
                        {sample.deviation > 0 ? "+" : ""}
                        {formatNumber(sample.deviation, 5)}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="statistics-placeholder">
                <span className="placeholder-icon">Σ</span>
                <span>STATISTICS WILL APPEAR HERE</span>
                <small>Complete the 15-second capture to unlock all 9 metrics and 30 sample rows.</small>
              </div>
            )}
          </div>
        )}
      </div>

      <button type="button" className="exit-button" onClick={onExit}>
        ← Exit Error Analysis
      </button>
    </section>
  );
}

function LiveGraph({ mode, graphData, color, powered, paused, onTogglePause }) {
  const isContinuity = mode === "CONTINUITY";

  const domain = useMemo(() => {
    if (isContinuity) return [-0.1, 1.1];
    if (!graphData.length) return ["auto", "auto"];

    const values = graphData.map((point) => point.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const padding = Math.max((max - min) * 0.25, Math.abs(max) * 0.03, 0.01);
    return [min - padding, max + padding];
  }, [graphData, isContinuity]);

  const currentUnit = getMeasurement(mode, graphData.at(-1)?.value ?? 0).unit;
  // Size the Y-axis gutter to the actual tick-label width. Small values use
  // less space; long values (e.g. resistance in scientific notation) get more.
  const yAxisWidth = useMemo(() => {
    const labels = domain.map((value) => Number(value).toPrecision(3));
    const longestLabel = Math.max(1, ...labels.map((label) => label.length));
    return Math.min(88, Math.max(38, longestLabel * 6 + 12));
  }, [domain]);

  return (
    <section className="graph-panel">
      <div className="graph-heading">
        <div>
          <span className="eyebrow">LIVE TELEMETRY</span>
          <h2>Signal Monitor</h2>
        </div>
        <div className="graph-heading-actions">
          <span className={`live-indicator ${powered && !paused ? "is-live" : ""}`}>
            <span /> {paused ? "PAUSED" : powered ? "LIVE" : "STANDBY"}
          </span>
          <button
            type="button"
            className="graph-play-pause"
            onClick={onTogglePause}
            disabled={!powered}
            aria-label={paused ? "Resume plot" : "Pause plot"}
            aria-pressed={paused}
            title={paused ? "Resume plot" : "Pause plot"}
            style={{ "--plot-color": color }}
          >
            {paused ? (
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor" stroke="none" /></svg>
            ) : (
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5h3v14H8zM15 5h3v14h-3z" fill="currentColor" stroke="none" /></svg>
            )}
          </button>
        </div>
      </div>

      <div className="graph-legend">
        <span
          className="legend-line"
          style={{ background: color, boxShadow: `0 0 10px ${color}` }}
        />
        <span>{isContinuity ? "Circuit state" : MODES[mode].label}</span>
        <span className="legend-unit">{isContinuity ? "0 / 1" : currentUnit}</span>
      </div>

      <div className="chart-container">
        {powered && graphData.length > 1 ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={graphData} margin={{ top: 10, right: 8, bottom: 2, left: 0 }}>
              <CartesianGrid stroke="#263244" strokeDasharray="3 5" vertical />
              <XAxis
                dataKey="time"
                tick={{ fill: "#64748b", fontSize: 9, fontFamily: "monospace" }}
                tickLine={false}
                axisLine={{ stroke: "#334155" }}
                tickFormatter={(value) => `${value}s`}
                minTickGap={20}
                height={24}
              />
              <YAxis
                domain={domain}
                tick={{ fill: "#64748b", fontSize: 9, fontFamily: "monospace" }}
                tickLine={false}
                axisLine={{ stroke: "#334155" }}
                width={yAxisWidth}
                tickMargin={4}
                tickFormatter={(value) => Number(value).toPrecision(3)}
              />
              <Tooltip
                contentStyle={{
                  background: "#0b1120",
                  border: `1px solid ${color}66`,
                  borderRadius: 8,
                  color: "#e5e7eb",
                  fontSize: 11,
                }}
                labelFormatter={(value) => `Time: ${value}s`}
                formatter={(value) => [
                  Number(value).toPrecision(4),
                  isContinuity ? "Circuit" : "Reading",
                ]}
              />
              <Line
                type={isContinuity ? "stepAfter" : "monotone"}
                dataKey="value"
                stroke={color}
                strokeWidth={2.5}
                dot={false}
                isAnimationActive={false}
                activeDot={{ r: 4, fill: color, stroke: "#fff", strokeWidth: 1 }}
                style={{ filter: `drop-shadow(0 0 5px ${color}90)` }}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="chart-empty">
            <svg
              className="chart-empty-icon"
              viewBox="0 0 24 24"
              width="32"
              height="32"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden="true"
            >
              <path
                d="M2 12h3l3-7 5 14 3-7h6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span>{powered ? "Waiting for samples…" : "POWER ON TO VISUALIZE"}</span>
            <small>New measurement history begins at zero when the mode changes.</small>
          </div>
        )}
      </div>

      <div className="graph-footer">
        <span>TIME BASE: 0.5 s</span>
        <span>{graphData.length} POINTS</span>
      </div>
    </section>
  );
}

function ModeButton({ mode, selected, onClick, disabled = false, powerOn = false, powerLabel }) {
  const config = MODES[mode];
  const color = mode === "STANDBY" || mode === "OFF" ? "#9ca3af" : config.color;
  const label =
    mode === "V_DC"
      ? "V DC"
      : mode === "RESISTANCE"
        ? "Ω"
        : mode === "CONTINUITY"
          ? "•)))"
          : mode === "TEMPERATURE"
            ? "°C"
            : (powerLabel || (powerOn && !selected ? "ON" : "STBY"));

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`mode-button ${selected ? "mode-selected" : ""} ${disabled ? "mode-disabled" : ""}`}
      style={{ "--button-color": color }}
      aria-pressed={selected}
    >
      <span className="mode-button-label">{label}</span>
      <span className="mode-button-subtitle">{mode === "STANDBY" ? (powerLabel === "OFF" ? "POWER OFF" : powerLabel === "STBY" ? "STANDBY" : powerOn && !selected ? "POWER" : config.label) : config.label}</span>
    </button>
  );
}

export default function App() {
  const [currentMode, setCurrentMode] = useState("OFF");
  const [powerOn, setPowerOn] = useState(false);
  const [demoValue, setDemoValue] = useState(0);
  const [demoSweep, setDemoSweep] = useState(false);
  const [shuttingDown, setShuttingDown] = useState(false);
  const [shutdownProgress, setShutdownProgress] = useState(0);
  const [shutdownAngle, setShutdownAngle] = useState(0);
  const [shutdownReading, setShutdownReading] = useState(0);
  const [shutdownDialOnly, setShutdownDialOnly] = useState(false);
  const shutdownTimerRef = useRef(null);
  const startupTimerRef = useRef(null);
  const shuttingDownRef = useRef(false);
  const readingValueRef = useRef(0);
  const powerOnRef = useRef(false);
  const demoValueRef = useRef(0);
  const [readingValue, setReadingValue] = useState(0);
  const [analysisDisplayMode, setAnalysisDisplayMode] = useState("V_DC");
  const [analysisReadingValue, setAnalysisReadingValue] = useState(0.05);
  const [analysisPaused, setAnalysisPaused] = useState(false);
  const [middleView, setMiddleView] = useState("DIAL");
  const [continuityClosed, setContinuityClosed] = useState(false);
  const [toneEnabled, setToneEnabled] = useState(true);
  const [graphData, setGraphData] = useState([]);
  const [graphPaused, setGraphPaused] = useState(false);
  const [magicSmokeOpen, setMagicSmokeOpen] = useState(false);
  const [rgbOverclock, setRgbOverclock] = useState(false);
  const [hardwareConnected, setHardwareConnected] = useState(false);
  const [hardwareStatus, setHardwareStatus] = useState("DISCONNECTED");
  const [hardwarePacket, setHardwarePacket] = useState(null);
  const bleRef = useRef({ device: null, characteristic: null, onValue: null, onDisconnect: null });
  const hardwareModeRef = useRef(null);
  const hardwarePacketRef = useRef(hardwarePacket);
  hardwarePacketRef.current = hardwarePacket;
  readingValueRef.current = readingValue;
  powerOnRef.current = powerOn;
  demoValueRef.current = demoValue;
  shuttingDownRef.current = shuttingDown;

  const headerClickRef = useRef([]);
  const konamiRef = useRef([]);
  const currentModeRef = useRef(currentMode);
  const continuityClosedRef = useRef(continuityClosed);
  const toneEnabledRef = useRef(toneEnabled);
  currentModeRef.current = currentMode;
  continuityClosedRef.current = continuityClosed;
  toneEnabledRef.current = toneEnabled;

  const graphStartRef = useRef(Date.now());
  const graphElapsedRef = useRef(0);
  const audioRef = useRef({
    context: null,
    oscillator: null,
    gain: null,
    stopTimer: null,
    requestId: 0,
  });

  const powered = powerOn && currentMode !== "OFF";
  // The sweep is time-limited; once complete, STANDBY keeps the needle at 12 o'clock.
  const demoOn = demoSweep;
  const activeColor = !powered
    ? "#4b5563"
    : demoOn
      ? "#4ade80"
    : rgbOverclock
      ? "var(--rgb-accent, #22d3ee)"
      : MODES[currentMode].color;

  const sendBleCommand = useCallback(async (command) => {
    const characteristic = bleRef.current.characteristic;
    if (!characteristic || !bleRef.current.device?.gatt?.connected) return false;
    try {
      const bytes = new TextEncoder().encode(JSON.stringify({ type: "command", ...command }));
      if (typeof characteristic.writeValueWithResponse === "function") {
        await characteristic.writeValueWithResponse(bytes);
      } else if (typeof characteristic.writeValueWithoutResponse === "function") {
        await characteristic.writeValueWithoutResponse(bytes);
      } else {
        await characteristic.writeValue(bytes);
      }
      return true;
    } catch (error) {
      console.error("VOLTEX BLE command failed:", error);
      setHardwareStatus("COMMAND FAILED");
      return false;
    }
  }, []);

  const startStartupAnimation = useCallback(() => {
    // Starting animation is explicitly tied to OFF -> STANDBY, never to BLE connect.
    clearInterval(startupTimerRef.current);
    clearInterval(shutdownTimerRef.current);
    startupTimerRef.current = null;
    shutdownTimerRef.current = null;
    shuttingDownRef.current = false;
    setShuttingDown(false);
    setShutdownProgress(0);
    currentModeRef.current = "STANDBY";
    setCurrentMode("STANDBY");
    setPowerOn(true);
    setDemoSweep(true);
    setDemoValue(0);

    const started = Date.now();
    const duration = 2400;
    startupTimerRef.current = setInterval(() => {
      const progress = Math.min((Date.now() - started) / duration, 1);
      const sweep = progress <= 0.5 ? progress * 2 : (1 - progress) * 2;
      setDemoValue(Math.round(sweep * 9999));

      if (progress >= 1) {
        clearInterval(startupTimerRef.current);
        startupTimerRef.current = null;
        setDemoValue(0);
        setDemoSweep(false);
        // Leave the device in STANDBY after the sweep completes.
        currentModeRef.current = "STANDBY";
        setCurrentMode("STANDBY");
        setPowerOn(true);
      }
    }, 30);
  }, []);

  const startHardwareShutdownAnimation = useCallback(() => {
    if (shuttingDownRef.current) return;

    const fromMode = currentModeRef.current;
    const dialOnly = fromMode === "STANDBY";
    shuttingDownRef.current = true;
    clearInterval(startupTimerRef.current);
    startupTimerRef.current = null;
    setDemoSweep(false);
    setShuttingDown(true);
    setShutdownDialOnly(dialOnly);
    setShutdownProgress(0);

    const startReading = Number.isFinite(readingValueRef.current)
      ? readingValueRef.current
      : demoValueRef.current;
    setShutdownReading(startReading);

    // STANDBY already has its needle at 12 o'clock: only extinguish dial
    // segments sequentially. Measurement modes keep the full shutdown sweep.
    const startAngle = dialOnly ? 0 : (MODES[fromMode] || MODES.OFF).angle + 90;
    setShutdownAngle(startAngle);
    const started = Date.now();
    const duration = dialOnly ? 700 : 1500;

    clearInterval(shutdownTimerRef.current);
    shutdownTimerRef.current = setInterval(() => {
      const progress = Math.min((Date.now() - started) / duration, 1);
      setShutdownProgress(progress * 5);
      if (!dialOnly) {
        setShutdownReading(startReading * (1 - progress));
        setShutdownAngle(startAngle * (1 - progress));
      }

      if (progress >= 1) {
        clearInterval(shutdownTimerRef.current);
        shutdownTimerRef.current = null;
        setShuttingDown(false);
        shuttingDownRef.current = false;
        setShutdownDialOnly(false);
        setPowerOn(false);
        setCurrentMode("OFF");
        currentModeRef.current = "OFF";
        setReadingValue(0);
        setDemoValue(0);
        setShutdownProgress(0);
        setShutdownReading(0);
        setContinuityClosed(false);
        setToneEnabled(true);
        toneEnabledRef.current = true;
        setMiddleView("DIAL");
        setGraphData([]);
        graphStartRef.current = Date.now();
      }
    }, 24);
  }, []);

  const disconnectHardware = useCallback(() => {
    const ble = bleRef.current;
    try {
      if (ble.characteristic && ble.onValue) ble.characteristic.removeEventListener("characteristicvaluechanged", ble.onValue);
      if (ble.device && ble.onDisconnect) ble.device.removeEventListener("gattserverdisconnected", ble.onDisconnect);
      if (ble.device?.gatt?.connected) ble.device.gatt.disconnect();
    } catch (error) {
      console.warn("BLE disconnect cleanup:", error);
    }
    bleRef.current = { device: null, characteristic: null, onValue: null, onDisconnect: null };
    hardwareModeRef.current = null;
    setHardwareConnected(false);
    setHardwareStatus("DISCONNECTED");
    setHardwarePacket(null);
  }, []);

  const connectHardware = useCallback(async () => {
    if (!navigator.bluetooth) {
      setHardwareStatus("USE CHROME / HTTPS");
      return;
    }
    try {
      setHardwareStatus("CONNECTING…");
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ name: "VOLTEX" }],
        optionalServices: [VOLTEX_BLE_SERVICE_UUID],
      });
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(VOLTEX_BLE_SERVICE_UUID);
      const characteristic = await service.getCharacteristic(VOLTEX_BLE_CHARACTERISTIC_UUID);
      const onValue = (event) => {
        try {
          const text = new TextDecoder().decode(event.target.value);
          const packet = JSON.parse(text);
          const previousHardwareHold = hardwarePacketRef.current?.holdEnabled;
          setHardwarePacket(packet);
          if (typeof packet.holdEnabled === "boolean" && packet.holdEnabled !== previousHardwareHold) {
            // The ESP32 is the source of truth for HOLD. When HOLD engages,
            // capture the exact value carried in that same BLE packet so the
            // dashboard never freezes the preceding browser-side reading.
            if (packet.holdEnabled && packet.mode === "TEMPERATURE" && Number.isFinite(packet.temperatureC)) {
              setAnalysisReadingValue(packet.temperatureC);
              setReadingValue(packet.temperatureC);
            }
            setAnalysisPaused(packet.holdEnabled);
          }
          setHardwareConnected(true);
          setHardwareStatus("CONNECTED · VOLTEX");

          const incomingMode = ["STANDBY", "OFF", "V_DC", "RESISTANCE", "CONTINUITY", "TEMPERATURE"].includes(packet.mode) ? packet.mode : null;
          if (incomingMode) {
            const previousHardwareMode = hardwareModeRef.current;
            const uiWasActive = powerOnRef.current && currentModeRef.current !== "OFF";
            const modeChanged = previousHardwareMode !== incomingMode;
            hardwareModeRef.current = incomingMode;

            // Keep Error Analysis aligned with mode changes made on the physical MODE button.
            if (modeChanged && ["V_DC", "RESISTANCE", "TEMPERATURE"].includes(incomingMode)) {
              setAnalysisDisplayMode(incomingMode);
            }

            if (modeChanged) {
              if (incomingMode === "OFF") {
                // Animate only for a real transition into OFF, not the first packet from an already-off device.
                if (uiWasActive || shuttingDownRef.current || (previousHardwareMode !== null && currentModeRef.current !== "OFF")) {
                  startHardwareShutdownAnimation();
                } else {
                  currentModeRef.current = "OFF";
                  setCurrentMode("OFF");
                  setPowerOn(false);
                  setShuttingDown(false);
                  setShutdownDialOnly(false);
                }
              } else {
                if (shuttingDownRef.current) {
                  clearInterval(shutdownTimerRef.current);
                  shutdownTimerRef.current = null;
                  setShuttingDown(false);
                  shuttingDownRef.current = false;
                }

                // A physical MODE-button press can wake the ESP32 from OFF to STANDBY.
                // Run the dashboard startup animation for that hardware-originated transition too.
                if (incomingMode === "STANDBY" && previousHardwareMode === "OFF") {
                  startStartupAnimation();
                } else {
                  currentModeRef.current = incomingMode;
                  setCurrentMode(incomingMode);
                  setPowerOn(incomingMode !== "OFF");
                }
              }
            }
          }

          const valueMode = incomingMode || currentModeRef.current;
          const incomingValue = readHardwareValue(valueMode, packet);
          if (!shuttingDownRef.current) setReadingValue(incomingValue);
          if (typeof packet.continuityClosed === "boolean") {
            continuityClosedRef.current = packet.continuityClosed;
            setContinuityClosed(packet.continuityClosed);
          }
        } catch (error) {
          console.warn("Invalid VOLTEX BLE packet:", error);
        }
      };
      const onDisconnect = () => {
        setHardwareConnected(false);
        setHardwareStatus("DISCONNECTED");
        setHardwarePacket(null);
        setReadingValue(null);
        hardwareModeRef.current = null;
        currentModeRef.current = "OFF";
        setCurrentMode("OFF");
        setPowerOn(false);
      };
      bleRef.current = { device, characteristic, onValue, onDisconnect };
      device.addEventListener("gattserverdisconnected", onDisconnect);
      characteristic.addEventListener("characteristicvaluechanged", onValue);
      await characteristic.startNotifications();
      setHardwareConnected(true);
      setHardwareStatus("CONNECTED · VOLTEX");
    } catch (error) {
      console.error("VOLTEX BLE connection failed:", error);
      setHardwareStatus(error?.name === "NotFoundError" ? "NOT SELECTED" : "CONNECTION FAILED");
      setHardwareConnected(false);
    }
  }, [startHardwareShutdownAnimation, startStartupAnimation]);

  useEffect(() => () => {
    clearInterval(startupTimerRef.current);
    clearInterval(shutdownTimerRef.current);
    const ble = bleRef.current;
    try {
      if (ble.characteristic && ble.onValue) ble.characteristic.removeEventListener("characteristicvaluechanged", ble.onValue);
      if (ble.device?.gatt?.connected) ble.device.gatt.disconnect();
    } catch { /* browser may already have closed the BLE session */ }
  }, []);

  // Initial page state stays OFF. Startup animation begins only when the OFF button is pressed.

  const stopTone = useCallback(() => {
    const audio = audioRef.current;
    // Invalidate any startTone call still waiting for AudioContext.resume().
    audio.requestId += 1;
    if (!audio.context || !audio.oscillator || !audio.gain) return;

    const now = audio.context.currentTime;

    try {
      audio.gain.gain.cancelScheduledValues(now);
      audio.gain.gain.setValueAtTime(audio.gain.gain.value, now);
      audio.gain.gain.linearRampToValueAtTime(0, now + 0.05);
      clearTimeout(audio.stopTimer);

      audio.stopTimer = setTimeout(() => {
        try {
          audio.oscillator?.stop();
        } catch {
          // Oscillator may already have stopped.
        }
        audio.oscillator = null;
        audio.gain = null;
        audio.stopTimer = null;
      }, 70);
    } catch {
      audio.oscillator = null;
      audio.gain = null;
      audio.stopTimer = null;
    }
  }, []);

  const startTone = useCallback(async () => {
    const audio = audioRef.current;
    const requestId = ++audio.requestId;
    if (audio.oscillator) {
      // If the circuit is re-closed during the 50 ms fade-out, cancel the pending stop
      // and bring the same continuous oscillator back to full volume.
      if (audio.stopTimer && audio.context && audio.gain) {
        clearTimeout(audio.stopTimer);
        audio.stopTimer = null;
        const now = audio.context.currentTime;
        audio.gain.gain.cancelScheduledValues(now);
        audio.gain.gain.setValueAtTime(audio.gain.gain.value, now);
        audio.gain.gain.linearRampToValueAtTime(1.0, now + 0.02);
      }
      return;
    }

    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;

      const context = audio.context || new AudioContextClass();
      audio.context = context;

      if (context.state === "suspended") await context.resume();
      // If the user reopened the circuit or changed mode while resume() was pending,
      // don't start a tone for a state that is no longer active.
      if (
        requestId !== audio.requestId ||
        currentModeRef.current !== "CONTINUITY" ||
        continuityClosedRef.current !== true ||
        toneEnabledRef.current !== true
      ) return;

      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const now = context.currentTime;

      oscillator.type = "triangle";
      oscillator.frequency.setValueAtTime(1200, now);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(1.0, now + 0.02);

      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(now);

      audio.oscillator = oscillator;
      audio.gain = gain;
    } catch (error) {
      console.warn("Continuity audio could not start:", error);
    }
  }, []);

  const selectMode = useCallback(
    (nextMode) => {
      if (nextMode === "OFF") {
        stopTone();
        if (hardwareConnected) void sendBleCommand({ action: "SET_MODE", mode: "OFF" });
        startHardwareShutdownAnimation();
        return;
      }
      stopTone();
      currentModeRef.current = nextMode;
      continuityClosedRef.current = false;
      toneEnabledRef.current = true;
      setCurrentMode(nextMode);
      setPowerOn(true);
      setDemoValue(0);
      setDemoSweep(false);
      setReadingValue(nextMode === "STANDBY" ? 0 : simulateReading(nextMode));
      setContinuityClosed(false);
      setToneEnabled(true);
      setAnalysisPaused(false);
      setGraphData([]);
      graphStartRef.current = Date.now();
      if (hardwareConnected) void sendBleCommand({ action: "SET_MODE", mode: nextMode });
      if (nextMode === "STANDBY") startStartupAnimation();
    },
    [stopTone, hardwareConnected, sendBleCommand, startHardwareShutdownAnimation, startStartupAnimation],
  );

  const togglePower = () => {
    if (currentMode !== "OFF") {
      stopTone();
      if (hardwareConnected) void sendBleCommand({ action: "SET_MODE", mode: "OFF" });
      startHardwareShutdownAnimation();
      setContinuityClosed(false);
      setToneEnabled(true);
      setMiddleView("DIAL");
      setGraphData([]);
      return;
    }
    // OFF button: run startup animation, then remain in STANDBY.
    setMiddleView("DIAL");
    if (hardwareConnected) void sendBleCommand({ action: "SET_MODE", mode: "STANDBY" });
    startStartupAnimation();
  };

  const toggleContinuity = async () => {
    const nextClosed = !continuityClosed;
    continuityClosedRef.current = nextClosed;
    setContinuityClosed(nextClosed);

    if (nextClosed && currentMode === "CONTINUITY" && toneEnabled) {
      await startTone();
    } else {
      stopTone();
    }
  };

  const toggleTone = async () => {
    const nextEnabled = !toneEnabled;
    toneEnabledRef.current = nextEnabled;
    setToneEnabled(nextEnabled);
    if (nextEnabled && currentMode === "CONTINUITY" && continuityClosed) {
      await startTone();
    } else {
      stopTone();
    }
  };

  useEffect(() => {
    if (currentMode !== "CONTINUITY" || !powered || !continuityClosed || !toneEnabled) {
      stopTone();
    }
  }, [currentMode, powered, continuityClosed, toneEnabled, stopTone]);

  useEffect(() => {
    if (hardwareConnected) return undefined;
    if (!powered) {
      setReadingValue(0);
      return undefined;
    }

    const interval = setInterval(() => {
      setReadingValue(
        currentMode === "CONTINUITY"
          ? continuityClosed
            ? 1
            : 0
          : simulateReading(currentMode),
      );
    }, 500);

    return () => clearInterval(interval);
  }, [currentMode, continuityClosed, powered, hardwareConnected]);

  // Start a fresh trace only when the measurement context changes, not when
  // the user pauses or resumes the plot.
  useEffect(() => {
    setGraphData([]);
    graphStartRef.current = Date.now();
    graphElapsedRef.current = 0;
    setGraphPaused(false);
  }, [currentMode, middleView, powered, continuityClosed]);

  useEffect(() => {
    if (!powered || middleView !== "GRAPH" || graphPaused) return undefined;

    const interval = setInterval(() => {
      const elapsed = (Date.now() - graphStartRef.current) / 1000;
      const value = hardwareConnected
        ? readHardwareValue(currentMode, hardwarePacketRef.current)
        : currentMode === "CONTINUITY"
          ? continuityClosed ? 1 : 0
          : simulateReading(currentMode);
      if (!Number.isFinite(value)) return;

      setGraphData((previous) =>
        [...previous, { time: Number(elapsed.toFixed(1)), value }].slice(-120),
      );
    }, 500);

    return () => clearInterval(interval);
  }, [currentMode, middleView, powered, continuityClosed, graphPaused, hardwareConnected]);

  useEffect(() => {
    // While paused, keep the captured sample stable even as BLE packets arrive.
    if (hardwareConnected && !analysisPaused) {
      setAnalysisReadingValue(readHardwareValue(analysisDisplayMode, hardwarePacket));
    }
  }, [hardwareConnected, hardwarePacket, analysisDisplayMode, analysisPaused]);

  useEffect(() => {
    if (hardwareConnected || middleView !== "ERROR_ANALYSIS" || analysisPaused) return undefined;
    setAnalysisReadingValue(simulateReading(analysisDisplayMode));
    const interval = setInterval(() => {
      setAnalysisReadingValue(simulateReading(analysisDisplayMode));
    }, 500);
    return () => clearInterval(interval);
  }, [middleView, analysisDisplayMode, analysisPaused, hardwareConnected]);

  useEffect(() => {
    const sequence = [
      "ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown",
      "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a",
    ];

    const handleKeyDown = (event) => {
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      konamiRef.current = [...konamiRef.current, key].slice(-sequence.length);
      if (sequence.every((item, index) => konamiRef.current[index] === item)) {
        setRgbOverclock(true);
        konamiRef.current = [];
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleHeaderClick = () => {
    const now = Date.now();
    headerClickRef.current = [...headerClickRef.current.filter((time) => now - time < 1800), now];
    if (headerClickRef.current.length >= 5) {
      setMagicSmokeOpen(true);
      headerClickRef.current = [];
    }
  };

  useEffect(
    () => () => {
      clearTimeout(audioRef.current.stopTimer);
      clearInterval(startupTimerRef.current);
      clearInterval(shutdownTimerRef.current);
      try {
        audioRef.current.oscillator?.stop();
        audioRef.current.context?.close();
      } catch {
        // Browser may already have released audio resources.
      }
    },
    [],
  );

  const openErrorAnalysis = () => {
    if (!powered) return;
    stopTone();
    setAnalysisPaused(false);
    // Start analysis in the active hardware mode. Unsupported modes render an
    // explicit unavailable state rather than defaulting to Voltage Error.
    setAnalysisDisplayMode(currentMode);
    setMiddleView("ERROR_ANALYSIS");
  };

  const openGraph = () => {
    if (!powered) return;
    setMiddleView("GRAPH");
    setGraphData([]);
    graphStartRef.current = Date.now();
  };

  return (
    <main className="app-root">
      <div className={`device-shell ${!powered ? "device-off" : ""} ${rgbOverclock ? "rgb-overclock" : ""}`}>
        <>
        <header className="device-header">
          <h1 onClick={handleHeaderClick} className="voltex-title">V O L T E X</h1>
          <p>DIGITAL MULTIMETER</p>
          <div className="header-rule">
            <span />
            <span />
            <span />
          </div>
        </header>

        <div className="hardware-connect-row">
          <span className={`hardware-status ${hardwareConnected ? "hardware-status-connected" : ""}`}>
            <span className="hardware-status-dot" />
            {hardwareConnected ? "BLE CONNECTED" : hardwareStatus}
          </span>
          <button type="button" className="hardware-connect-button" onClick={hardwareConnected ? disconnectHardware : connectHardware}>
            {hardwareConnected ? "DISCONNECT" : "CONNECT BLE"}
          </button>
        </div>

        <DisplayScreen
          // Keep the physical mode on the main display when Error Analysis is unavailable
          // for Continuity/Standby; otherwise show the selected analysis parameter.
          mode={middleView === "ERROR_ANALYSIS" && !["CONTINUITY", "STANDBY", "OFF"].includes(currentMode) ? analysisDisplayMode : currentMode}
          reading={shuttingDown ? shutdownReading : middleView === "ERROR_ANALYSIS" ? analysisReadingValue : demoOn ? demoValue : readingValue}
          continuityClosed={continuityClosed}
          powered={middleView === "ERROR_ANALYSIS" || powered}
          demoOn={middleView !== "ERROR_ANALYSIS" && demoOn}
          shuttingDown={shuttingDown}
          shutdownProgress={shutdownProgress}
          shutdownDialOnly={shutdownDialOnly}
          hardwareConnected={hardwareConnected}
          holdEnabled={analysisPaused || hardwarePacket?.holdEnabled === true}
          middleView={middleView}
        />

        {middleView === "DIAL" && (
          <div className="dial-view">
            <SelectorDial mode={currentMode} onSelect={(mode) => selectMode(mode)} powered={powered} demoOn={demoOn} demoValue={demoValue} shuttingDown={shuttingDown} shutdownProgress={shutdownProgress} shutdownAngle={shutdownAngle} />

            {currentMode === "CONTINUITY" && (
              <div className="continuity-controls">
                <button
                  type="button"
                  className={`tone-toggle ${toneEnabled ? "tone-enabled" : "tone-disabled"}`}
                  onClick={toggleTone}
                  aria-label={toneEnabled ? "Turn continuity tone off" : "Turn continuity tone on"}
                  aria-pressed={toneEnabled}
                  title={toneEnabled ? "Tone enabled" : "Tone muted"}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
                    {!toneEnabled && <path d="M4 4 20 20" />}
                  </svg>
                </button>
                <button
                  type="button"
                  className={`continuity-toggle ${continuityClosed ? "circuit-closed" : ""}`}
                  onClick={toggleContinuity}
                  aria-pressed={continuityClosed}
                >
                  <span className="circuit-light" />
                  {continuityClosed ? "CLOSE CIRCUIT" : "OPEN CIRCUIT"}
                </button>
              </div>
            )}
          </div>
        )}

        {middleView === "ERROR_ANALYSIS" && (
          <ErrorAnalysis
            mode={currentMode}
            readingValue={analysisReadingValue}
            isPaused={analysisPaused}
            onTogglePause={() => {
              if (hardwareConnected && currentMode === "TEMPERATURE") {
                // Ask the ESP32 to toggle HOLD and wait for its authoritative
                // BLE packet before freezing the dashboard value.
                const currentlyHeld = hardwarePacketRef.current?.holdEnabled === true;
                void sendBleCommand({ action: "SET_HOLD", value: !currentlyHeld });
              } else {
                setAnalysisPaused((paused) => !paused);
              }
            }}
            onDisplayModeChange={setAnalysisDisplayMode}
            onRequestHardwareMode={(nextMode) => {
              setAnalysisDisplayMode(nextMode);
              if (hardwareConnected && hardwarePacketRef.current?.mode !== nextMode) {
                void sendBleCommand({ action: "SET_MODE", mode: nextMode });
              }
            }}
            onExit={() => { setAnalysisPaused(false); setMiddleView("DIAL"); }}
            hardwareConnected={hardwareConnected}
            hardwarePacket={hardwarePacket}
          />
        )}

        {middleView === "GRAPH" && (
          <div className="graph-view">
            <LiveGraph
              mode={currentMode}
              graphData={graphData}
              color={activeColor}
              powered={powered}
              paused={graphPaused}
              onTogglePause={() => {
                if (graphPaused) {
                  graphStartRef.current = Date.now() - graphElapsedRef.current * 1000;
                  setGraphPaused(false);
                } else {
                  graphElapsedRef.current = (Date.now() - graphStartRef.current) / 1000;
                  setGraphPaused(true);
                }
              }}
            />
          </div>
        )}

        {(middleView === "DIAL" || middleView === "GRAPH") && (
          <section className="controls-section">
            <div className="mode-grid">
              {["STANDBY", "V_DC", "RESISTANCE", "CONTINUITY", "TEMPERATURE"].map((mode) => (
                <ModeButton
                  key={mode}
                  mode={mode}
                  selected={currentMode === mode}
                  powerOn={powerOn}
                  disabled={currentMode === "OFF" && mode !== "STANDBY"}
                  powerLabel={mode === "STANDBY" ? (currentMode === "OFF" ? "OFF" : currentMode === "STANDBY" ? "STBY" : "ON") : undefined}
                  onClick={() => mode === "STANDBY" ? togglePower() : selectMode(mode)}
                />
              ))}

              <button
                type="button"
                className="mode-button error-mode-button"
                onClick={openErrorAnalysis}
                disabled={!powered}
              >
                <span className="mode-button-label">Σ</span>
                <span className="mode-button-subtitle">ERROR ANALYSIS</span>
              </button>
            </div>

            <button
              type="button"
              className="visualize-button"
              disabled={!powered || currentMode === "OFF" || currentMode === "STANDBY"}
              onClick={() => {
                if (middleView === "GRAPH") {
                  setMiddleView("DIAL");
                } else {
                  openGraph();
                }
              }}
            >
              <svg
                viewBox="0 0 24 24"
                width="19"
                height="19"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                aria-hidden="true"
              >
                <path
                  d="M2 12h3l3-7 5 14 3-7h6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span>{middleView === "GRAPH" ? "Exit Visualization" : "Visualize Readings (Real-Time)"}</span>
              <span className="visualize-arrow">{middleView === "GRAPH" ? "↙" : "↗"}</span>
            </button>
          </section>
        )}

        <footer className="device-footer">
          <span style={{ fontWeight: 800, letterSpacing: "0.16em", textAlign: "center", display: "block", width: "100%" }}>
            POWERED BY <strong>ESP32</strong> &amp; <strong>CHAI</strong> ☕
          </span>
        </footer>

        {magicSmokeOpen && (
          <div className="magic-smoke-backdrop" role="presentation" onClick={() => setMagicSmokeOpen(false)}>
            <section
              className="magic-smoke-modal"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="magic-smoke-title"
              onClick={(event) => event.stopPropagation()}
            >
              <span className="magic-smoke-icon" aria-hidden="true">⚠</span>
              <h2 id="magic-smoke-title">SYSTEM ALERT</h2>
              <p>WARNING: Magic Smoke Containment Level at 98% - System Stable</p>
              <button type="button" onClick={() => setMagicSmokeOpen(false)}>ACKNOWLEDGE</button>
            </section>
          </div>
        )}
        </>
      </div>
    </main>
  );
}