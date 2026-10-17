import { LayoutGrid } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { useAppStore } from "../store/app-store";
import { useI18n } from "../i18n";
import { DEFAULT_READING_PRESET_ID, READING_PRESETS, type ReadingPreset } from "./reading-mode";

// ---------------------------------------------------------------------------
// 閱讀模式排版預設 (2026-10-02): one-click layout presets. The buttons draw
// proportional SVG glyphs derived from the SAME cols/rows templates the grid
// uses, so a sketch always matches the real layout (the 2fr left column in
// `4-left-big-tri` reads wider). Glyphs stay language-neutral (no i18n).
//
// 2026-10-03 maintainer: the picker no longer floats alone at the dock's top-left —
// it sits in the top bar right next to the reading-mode (BookOpen) toggle and
// only shows while reading mode is on. The BookOpen toggle itself stays a pure
// enter/exit switch (e2e contract).
// ---------------------------------------------------------------------------

const GLYPH_UNIT = 8;
const GLYPH_GAP = 2;

/** Parse a `"Nfr Nfr …"` template into track unit counts (non-fr → 1). */
function glyphTrackUnits(template: string): number[] {
  return template.trim().split(/\s+/).map((track) => {
    const match = /^(\d+(?:\.\d+)?)fr$/.exec(track);
    return match ? Number(match[1]) : 1;
  });
}

/** Leading offset of 0-based `track` in units, including the gaps before it. */
function glyphTrackOffset(units: number[], track: number): number {
  let offset = 0;
  for (let index = 0; index < track; index += 1) {
    offset += (units[index] ?? 1) * GLYPH_UNIT + GLYPH_GAP;
  }
  return offset;
}

/** Size of `span` tracks starting at 0-based `track`, internal gaps included. */
function glyphTrackSize(units: number[], track: number, span: number): number {
  let size = 0;
  for (let index = track; index < track + span; index += 1) {
    if (index > track) size += GLYPH_GAP;
    size += (units[index] ?? 1) * GLYPH_UNIT;
  }
  return size;
}

function ReadingPresetGlyph({ preset }: { preset: ReadingPreset }): React.JSX.Element {
  const colUnits = glyphTrackUnits(preset.cols);
  const rowUnits = glyphTrackUnits(preset.rows);
  const width = glyphTrackOffset(colUnits, colUnits.length) - GLYPH_GAP;
  const height = glyphTrackOffset(rowUnits, rowUnits.length) - GLYPH_GAP;
  return (
    <svg
      className="reading-preset-glyph"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      {preset.boxes.map((box, index) => (
        <rect
          key={index}
          x={glyphTrackOffset(colUnits, box.col - 1)}
          y={glyphTrackOffset(rowUnits, box.row - 1)}
          width={glyphTrackSize(colUnits, box.col - 1, box.colSpan)}
          height={glyphTrackSize(rowUnits, box.row - 1, box.rowSpan)}
          rx={1.5}
          fill="currentColor"
        />
      ))}
    </svg>
  );
}

/** Layout button + preset popover; renders nothing outside reading mode. */
export function ReadingPresetPicker(): React.JSX.Element | null {
  const readingModeActive = useAppStore((state) => state.readingModeActive);
  const readingPickerOpen = useAppStore((state) => state.readingPickerOpen);
  const setReadingPickerOpen = useAppStore((state) => state.setReadingPickerOpen);
  const toggleReadingMode = useAppStore((state) => state.toggleReadingMode);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const readingPreset = useAppStore((state) => state.settings?.readingPreset);
  const tileCount = useAppStore((state) => state.dockLayout.tiles.length);
  const { t } = useI18n();

  const preset = useMemo(
    () =>
      READING_PRESETS.find((candidate) => candidate.id === readingPreset)
      ?? READING_PRESETS.find((candidate) => candidate.id === DEFAULT_READING_PRESET_ID)!,
    [readingPreset],
  );

  // Closes on pick, on exit, and on a click truly outside the picker.
  const pickerToggleRef = useRef<HTMLButtonElement | null>(null);
  const pickerPopoverRef = useRef<HTMLDivElement | null>(null);
  const open = readingModeActive && readingPickerOpen;
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (pickerToggleRef.current?.contains(target) || pickerPopoverRef.current?.contains(target)) return;
      setReadingPickerOpen(false);
    };
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setReadingPickerOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeydown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeydown);
    };
  }, [open, setReadingPickerOpen]);

  if (!readingModeActive) return null;

  return (
    <div className="reading-picker-anchor">
      <button
        ref={pickerToggleRef}
        type="button"
        className={`icon-button reading-picker-toggle${open ? " active" : ""}`}
        data-action-id="reading.picker.toggle"
        data-reading-picker-toggle="true"
        title={t("reading.picker.layout")}
        aria-label={t("reading.picker.layout")}
        aria-expanded={open}
        onClick={(event) => {
          if (event.detail > 1) return;
          setReadingPickerOpen(!readingPickerOpen);
        }}
      >
        <LayoutGrid size={16} />
      </button>
      {open && (
        <div ref={pickerPopoverRef} className="reading-picker-popover" data-reading-picker-popover="true">
          {READING_PRESETS.map((candidate) => {
            const beyond = candidate.boxes.length > tileCount;
            return (
              <button
                key={candidate.id}
                type="button"
                className={[
                  "reading-preset-button",
                  candidate.id === preset.id ? "active" : "",
                  beyond ? "deemph" : "",
                ].filter(Boolean).join(" ")}
                data-action-id="reading.preset.select"
                data-reading-preset={candidate.id}
                aria-pressed={candidate.id === preset.id}
                title={candidate.label}
                onClick={(event) => {
                  if (event.detail > 1) return; // 雙擊＝兩次 click（2026-09-22 鐵律）: event.detail>1
                  void updateSettings({ readingPreset: candidate.id });
                  setReadingPickerOpen(false);
                }}
              >
                <ReadingPresetGlyph preset={candidate} />
              </button>
            );
          })}
          <button
            type="button"
            className="reading-picker-exit"
            data-action-id="reading.mode.toggle"
            data-reading-picker-exit="true"
            title={t("reading.picker.exit")}
            onClick={(event) => {
              if (event.detail > 1) return;
              setReadingPickerOpen(false);
              toggleReadingMode();
            }}
          >
            {t("reading.picker.exit")}
          </button>
        </div>
      )}
    </div>
  );
}
