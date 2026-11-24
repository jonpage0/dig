import React, { useEffect, useRef, useState } from "react";
import { Input } from "@base-ui/react/input";
import { Select } from "@base-ui/react/select";
import { Switch } from "@base-ui/react/switch";
import type { SettingsFieldSchema } from "../../core/api-types.ts";

export type SaveSettingFn = (key: string, value: unknown) => Promise<void>;

interface SettingControlProps {
  readonly settingKey: string;
  readonly schema: SettingsFieldSchema;
  readonly value: unknown;
  readonly onSave: SaveSettingFn;
  readonly label?: string;
  readonly description?: string;
  readonly placeholder?: string;
  readonly allowEmptyZero?: boolean;
  readonly integerOnly?: boolean;
  readonly compact?: boolean;
}

function toDisplay(type: SettingsFieldSchema["type"], value: unknown, allowEmptyZero: boolean): string | boolean {
  if (type === "boolean") return value === true;
  if (value === null || value === undefined) return "";
  if (type === "number" && allowEmptyZero && value === 0) return "";
  return String(value);
}

function validateValue(
  schema: SettingsFieldSchema,
  raw: string | boolean,
  allowEmptyZero: boolean,
  integerOnly: boolean,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string } {
  if (schema.type === "boolean") {
    return { ok: true, value: raw === true };
  }
  if (schema.type === "number") {
    const trimmed = String(raw).trim();
    if (trimmed === "") {
      if (allowEmptyZero) return { ok: true, value: 0 };
      return { ok: false, error: "Enter a number." };
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      return { ok: false, error: "Enter a valid number." };
    }
    if (integerOnly && !Number.isInteger(parsed)) {
      return { ok: false, error: "Enter a whole number." };
    }
    const min = schema.minimum ?? 0;
    if (parsed < min) {
      return { ok: false, error: `Enter ${min} or more.` };
    }
    return { ok: true, value: parsed };
  }
  const trimmed = String(raw).trim();
  if (schema.enum && !schema.enum.includes(trimmed)) {
    return { ok: false, error: "Choose one of the available options." };
  }
  if (!trimmed) {
    return { ok: false, error: "Value cannot be empty." };
  }
  return { ok: true, value: trimmed };
}

export function SettingControl({
  settingKey,
  schema,
  value,
  onSave,
  label,
  description,
  placeholder,
  allowEmptyZero = false,
  integerOnly = false,
  compact = false,
}: SettingControlProps) {
  const isBoolean = schema.type === "boolean";
  const isEnum = !isBoolean && Array.isArray(schema.enum) && schema.enum.length > 0;
  const isTextLike = !isBoolean && !isEnum;

  const [draft, setDraft] = useState<string | boolean>(() =>
    toDisplay(schema.type, value, allowEmptyZero),
  );
  const [status, setStatus] = useState<"" | "saving" | "saved" | "error">("");
  const [statusText, setStatusText] = useState("");

  const stateRef = useRef({
    draft: toDisplay(schema.type, value, allowEmptyZero),
    saved: value,
    pending: 0,
    editSeq: 0,
    queue: Promise.resolve(),
    mounted: true,
  });

  useEffect(() => {
    stateRef.current.mounted = true;
    return () => {
      stateRef.current.mounted = false;
    };
  }, []);

  useEffect(() => {
    const cur = stateRef.current;
    if (cur.pending > 0) return;
    const prevDisplay = toDisplay(schema.type, cur.saved, allowEmptyZero);
    const dirty = isTextLike && cur.draft !== prevDisplay;
    cur.saved = value;
    if (!dirty) {
      const nextDisplay = toDisplay(schema.type, value, allowEmptyZero);
      cur.draft = nextDisplay;
      setDraft(nextDisplay);
    }
  }, [value, schema.type, allowEmptyZero, isTextLike]);

  const updateDraft = (next: string | boolean) => {
    stateRef.current.draft = next;
    stateRef.current.editSeq += 1;
    setDraft(next);
    if (status === "error") {
      setStatus("");
      setStatusText("");
    }
  };

  const commit = (raw: string | boolean) => {
    const checked = validateValue(schema, raw, allowEmptyZero, integerOnly);
    if (!checked.ok) {
      setStatus("error");
      setStatusText(checked.error);
      return;
    }

    const cur = stateRef.current;
    const normalizedSaved =
      schema.type === "number" && (cur.saved === null || cur.saved === undefined)
        ? 0
        : cur.saved;
    if (checked.value === normalizedSaved) {
      if (cur.pending === 0) {
        setStatus("");
        setStatusText("");
      }
      return;
    }

    const editAt = cur.editSeq;
    cur.pending += 1;
    setStatus("saving");
    setStatusText("Saving…");

    cur.queue = cur.queue.then(async () => {
      try {
        await onSave(settingKey, checked.value);
        cur.saved = checked.value;
        if (cur.mounted) {
          if (cur.editSeq === editAt) {
            const nextDisplay = toDisplay(schema.type, checked.value, allowEmptyZero);
            cur.draft = nextDisplay;
            setDraft(nextDisplay);
          }
          setStatus("saved");
          setStatusText("Saved");
        }
      } catch (err: unknown) {
        if (cur.mounted) {
          if (cur.editSeq === editAt) {
            const reverted = toDisplay(schema.type, cur.saved, allowEmptyZero);
            cur.draft = reverted;
            setDraft(reverted);
          }
          setStatus("error");
          setStatusText(err instanceof Error ? err.message : "Could not save setting.");
        }
      } finally {
        cur.pending -= 1;
      }
    });
  };

  const inputId = `setting-${settingKey}`;
  const titleText = label ?? schema.title ?? settingKey;
  const helpText = description ?? schema.description;

  const feedback = statusText ? (
    <span
      role="status"
      aria-live="polite"
      className={
        status === "error"
          ? "text-xs text-destructive"
          : status === "saved"
            ? "text-xs text-[var(--success)]"
            : "text-xs text-muted-foreground"
      }
    >
      {statusText}
    </span>
  ) : null;

  let control: React.ReactNode;
  if (isBoolean) {
    control = (
      <div className="flex items-center gap-2.5">
        <Switch.Root
          id={inputId}
          name={settingKey}
          aria-label={titleText}
          checked={draft === true}
          onCheckedChange={(next) => {
            updateDraft(next);
            commit(next);
          }}
          className="dig-switch"
        >
          <Switch.Thumb className="dig-switch-thumb" />
        </Switch.Root>
        <span className="text-xs font-medium text-muted-foreground">
          {draft === true ? "On" : "Off"}
        </span>
      </div>
    );
  } else if (isEnum && schema.enum) {
    const items = schema.enum.map((opt) => ({ value: opt, label: opt }));
    control = (
      <Select.Root
        name={settingKey}
        value={String(draft)}
        items={items}
        onValueChange={(next) => {
          if (next === null) return;
          updateDraft(String(next));
          commit(String(next));
        }}
      >
        <Select.Trigger id={inputId} aria-label={titleText} className="dig-select-trigger">
          <Select.Value />
          <Select.Icon aria-hidden="true" className="text-muted-foreground">
            ⌄
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Positioner sideOffset={4} alignItemWithTrigger={false} className="dig-select-positioner">
            <Select.Popup className="dig-select-popup">
              <Select.List>
                {schema.enum.map((opt) => (
                  <Select.Item key={opt} value={opt} className="dig-select-item">
                    <Select.ItemText>{opt}</Select.ItemText>
                    <Select.ItemIndicator aria-hidden="true">✓</Select.ItemIndicator>
                  </Select.Item>
                ))}
              </Select.List>
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </Select.Root>
    );
  } else {
    const isNum = schema.type === "number";
    control = (
      <Input
        id={inputId}
        name={settingKey}
        type={isNum ? "number" : "text"}
        value={String(draft)}
        placeholder={placeholder}
        min={schema.minimum ?? (isNum ? 0 : undefined)}
        step={isNum ? (integerOnly ? 1 : "any") : undefined}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={status === "error" || undefined}
        className="dig-input max-w-xs"
        onValueChange={(next) => updateDraft(next)}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(e.currentTarget.value);
          }
        }}
      />
    );
  }

  if (compact) {
    return (
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={inputId} className="text-xs font-medium text-foreground">
            {titleText}
          </label>
          {feedback}
        </div>
        {control}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0 flex-1 space-y-0.5">
        <label htmlFor={inputId} className="block text-sm font-medium text-foreground">
          {titleText}
        </label>
        {helpText && <p className="m-0 text-xs leading-relaxed text-muted-foreground">{helpText}</p>}
      </div>
      <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
        {control}
        {feedback}
      </div>
    </div>
  );
}
