import { MAX_PASSWORD_LENGTH } from "@pp/domain";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { type ComponentProps, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { useT } from "../i18n/hooks.ts";

/**
 * Each code point is at most two UTF-16 units: the browser may then never cut a password
 * the server would take (128 characters, `MAX_PASSWORD_LENGTH`), which counts them.
 */
export const PASSWORD_INPUT_MAX_UNITS = MAX_PASSWORD_LENGTH * 2;

type PasswordInputProps = Omit<ComponentProps<"input">, "type"> & {
  /** `new-password` for the PO's field, `current-password` for the joiner's. */
  autoComplete: "new-password" | "current-password";
};

/**
 * A room password's field (#31), with a 44 px "Show password" toggle inside its right end
 * (`aria-pressed`, its name constant), so a password typed on a phone can be checked
 * before it is sent.
 */
export function PasswordInput({ className, ref, ...props }: PasswordInputProps) {
  const t = useT();
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input
        ref={ref}
        type={shown ? "text" : "password"}
        maxLength={PASSWORD_INPUT_MAX_UNITS}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className={`pr-12 ${className ?? ""}`}
        {...props}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        data-password-toggle
        aria-pressed={shown}
        className="absolute top-0 right-0 rounded-l-none"
        onClick={() => setShown((now) => !now)}
      >
        {shown ? <EyeOffIcon aria-hidden /> : <EyeIcon aria-hidden />}
        <span className="sr-only">{t("password.show")}</span>
      </Button>
    </div>
  );
}
