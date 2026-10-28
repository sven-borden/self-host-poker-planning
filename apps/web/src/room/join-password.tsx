import { LockIcon } from "lucide-react";
import { type ReactNode, type Ref, useEffect } from "react";
import { errorMessage } from "../i18n/errors.ts";
import { useT } from "../i18n/hooks.ts";
import type { LockReason } from "../stores/room-store.ts";
import { PasswordInput } from "./password-input.tsx";

interface JoinPasswordProps {
  ids: { password: string; lock: string; error: string };
  inputRef: Ref<HTMLInputElement>;
  value: string;
  onChange: (value: string) => void;
  /** Why the room asks: it has a password, or the PO changed it. */
  reason: LockReason;
  /** The refusal said under the field, when the password was refused. */
  alert: ReactNode;
  /** Called once the field is in the page, so the form can move the focus to it. */
  onReady: () => void;
}

/**
 * The join form's password block (#31): the field, its "Show password" toggle and the
 * line that says why it is asked. A lazy chunk of its own: most rooms have no password,
 * and the room page prefetches it as soon as the room's header says it has one.
 */
export function JoinPassword({
  ids,
  inputRef,
  value,
  onChange,
  reason,
  alert,
  onReady,
}: JoinPasswordProps) {
  const t = useT();
  useEffect(() => {
    onReady();
  }, [onReady]);
  return (
    <div className="flex flex-col gap-2" data-join-password>
      <label htmlFor={ids.password} className="font-medium">
        {t("password.label")}
      </label>
      <PasswordInput
        ref={inputRef}
        id={ids.password}
        name="password"
        autoComplete="current-password"
        enterKeyHint="go"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={alert ? true : undefined}
        aria-describedby={alert ? `${ids.error} ${ids.lock}` : ids.lock}
      />
      <p id={ids.lock} className="m-0 flex items-start gap-2 text-sm text-ink-2">
        <LockIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
        {reason === "changed" ? t("password.changed") : errorMessage(t, "password_required")}
      </p>
      {alert}
    </div>
  );
}
