import { Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { filterByQuery, scanRuntimeActions, type RuntimeActionEntry } from "../action-registry";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ open, onClose }: CommandPaletteProps): React.JSX.Element | null {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [pendingConfirm, setPendingConfirm] = useState<RuntimeActionEntry | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Scan on each open so the registry reflects the currently mounted DOM
  // (actions live in dialogs/menus that mount and unmount). Re-scan when query
  // changes is unnecessary — the action set only depends on what's mounted.
  const actions = useMemo<RuntimeActionEntry[]>(() => (open ? scanRuntimeActions() : []), [open]);
  const matches = useMemo(() => filterByQuery(actions, query), [actions, query]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (pendingConfirm) setPendingConfirm(null);
        else onClose();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const items = listRef.current?.querySelectorAll<HTMLElement>('[data-palette-item="true"]');
        if (!items || items.length === 0) return;
        const index = Array.from(items).findIndex((item) => item === document.activeElement);
        const next = event.key === "ArrowDown"
          ? items[(index + 1) % items.length] ?? items[0]!
          : items[(index - 1 + items.length) % items.length] ?? items[0]!;
        next.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    // Focus the search input after the palette mounts.
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      window.cancelAnimationFrame(id);
    };
  }, [onClose, pendingConfirm]);

  if (!open) return null;

  const handleSelect = (entry: RuntimeActionEntry): void => {
    if (entry.requiresConfirm && pendingConfirm?.actionId !== entry.actionId) {
      // First selection of a destructive/external action enters inline confirm.
      setPendingConfirm(entry);
      return;
    }
    const invoked = entry.invoke();
    if (invoked) onClose();
  };

  return (
    <div
      data-action-id="palette.backdrop.dismiss"
      className="wizard-backdrop"
      onClick={() => onClose()}
    >
      <section
        data-action-id="palette.dialog.consume"
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label={t("palette.dialog.aria")}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <Search size={16} />
          <input
            ref={inputRef}
            data-action-id="palette.search.change"
            className="command-palette-input"
            type="text"
            placeholder={t("palette.search.placeholder")}
            aria-label={t("palette.search.aria")}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPendingConfirm(null);
            }}
          />
          <button
            data-action-id="palette.close"
            className="icon-button"
            aria-label={t("palette.close.aria")}
            onClick={() => onClose()}
          >
            <X size={18} />
          </button>
        </header>
        <div className="command-palette-list" ref={listRef}>
          {matches.length === 0 ? (
            <div className="command-palette-empty">{t("palette.empty")}</div>
          ) : (
            matches.slice(0, 50).map((entry) => {
              const confirming = pendingConfirm?.actionId === entry.actionId;
              return (
                <button
                  key={entry.actionId}
                  data-action-id="palette.item.select"
                  data-palette-item="true"
                  className={`command-palette-item ${confirming ? "confirming" : ""} risk-${entry.risk}`}
                  type="button"
                  onClick={() => handleSelect(entry)}
                >
                  <span className="command-palette-item-label">{entry.label || entry.actionId}</span>
                  <span className="command-palette-item-meta">
                    {confirming ? t("palette.confirm") : entry.actionId}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}
