import { useEffect, useMemo, useState } from "react";
import type { SpreadsheetModel } from "@shared/types";
import type { ArtifactViewerProps } from "../registry";

export function SpreadsheetViewer({ preview }: ArtifactViewerProps): React.JSX.Element | null {
  const [model, setModel] = useState<SpreadsheetModel | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [error, setError] = useState("");
  const spreadsheet = preview.kind === "spreadsheet" ? preview : null;

  useEffect(() => {
    let active = true;
    if (!spreadsheet) return () => { active = false; };
    void window.aiTerminal.readArtifactWorkbook({ token: spreadsheet.workbookToken })
      .then((value) => active && setModel(value))
      .catch((reason: unknown) => active && setError(reason instanceof Error ? reason.message : String(reason)));
    return () => { active = false; };
  }, [spreadsheet]);

  const sheet = model?.sheets[sheetIndex] ?? model?.sheets[0];
  const cells = useMemo(() => new Map((sheet?.cells ?? []).map((cell) => [`${cell.row}:${cell.column}`, cell.value])), [sheet]);
  if (!spreadsheet) return null;
  if (error) return <div className="artifact-viewer-state">{error}</div>;
  if (!model || !sheet) return <div className="artifact-viewer-state">Loading workbook…</div>;

  return (
    <div className="spreadsheet-viewer">
      <div className="spreadsheet-tabs" role="tablist" aria-label="Workbook sheets">
        {model.sheets.map((item) => (
          <button
            data-action-id="artifact.spreadsheet.sheet.select"
            key={item.index}
            role="tab"
            aria-selected={item.index === sheet.index}
            className={item.index === sheet.index ? "active" : ""}
            onClick={() => setSheetIndex(item.index)}
          >{item.name}</button>
        ))}
      </div>
      {model.limited || sheet.truncated ? <p className="artifact-viewer-notice">Preview limited to the first {sheet.rowCount} rows × {sheet.columnCount} columns.</p> : null}
      <div className="spreadsheet-grid-wrap">
        <table className="spreadsheet-grid">
          <thead><tr><th>#</th>{Array.from({ length: sheet.columnCount }, (_, column) => <th key={column}>{columnLabel(column)}</th>)}</tr></thead>
          <tbody>
            {Array.from({ length: sheet.rowCount }, (_, row) => (
              <tr key={row}>
                <th>{row + 1}</th>
                {Array.from({ length: sheet.columnCount }, (_, column) => <td key={column}>{formatCell(cells.get(`${row}:${column}`))}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function columnLabel(column: number): string {
  let value = column + 1;
  let label = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}

function formatCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value);
}
