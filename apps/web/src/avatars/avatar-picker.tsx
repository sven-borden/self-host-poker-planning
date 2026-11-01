import { AVATAR_IDS, type AvatarId } from "@pp/domain";
import { CheckIcon } from "lucide-react";
import { type Ref, useEffect, useId, useRef } from "react";
import { useT } from "../i18n/hooks.ts";
import { Avatar, type AvatarLook, initials } from "../table/avatar.tsx";

interface OptionProps {
  option: AvatarId | null;
  label: string;
  look: AvatarLook;
  group: string;
  checked: boolean;
  onPick: () => void;
  id: string;
  ref?: Ref<HTMLInputElement> | undefined;
}

/**
 * One choice: a native radio, hidden but focusable, so the arrow keys, Tab and a screen
 * reader work as in any radio group. The pick wears a brass outline and a check; the
 * keyboard focus is an ink outline further out, so the two never look alike. Only the pick
 * has idle life: 25 faces blinking at once would be anything but calm.
 */
function Option({ option, label, look, group, checked, onPick, id, ref }: OptionProps) {
  return (
    <label
      data-avatar-option={option ?? "initials"}
      title={label}
      className="relative grid size-11 cursor-pointer place-items-center justify-self-center rounded-full outline-offset-1 outline-ink has-focus-visible:outline-2"
    >
      <input
        ref={ref}
        type="radio"
        name={group}
        value={option ?? ""}
        checked={checked}
        onChange={onPick}
        aria-label={label}
        className="sr-only"
      />
      <Avatar
        id={id}
        name={look.initials}
        size={36}
        look={look}
        still={!checked}
        className={checked ? "outline-2 outline-offset-1 outline-brass" : undefined}
      />
      {checked ? (
        <span
          aria-hidden="true"
          data-avatar-picked
          className="absolute right-0 bottom-0 grid size-4 place-items-center rounded-full bg-spruce text-on-spruce ring-2 ring-surface"
        >
          <CheckIcon width={10} height={10} strokeWidth={3.5} />
        </span>
      ) : null}
    </label>
  );
}

export interface AvatarPickerProps {
  value: AvatarId | null;
  onChange: (avatar: AvatarId | null) => void;
  /** The person, so each choice shows on their own colour with their own initials. */
  id: string;
  name: string;
  colour: number;
  /** Moves the focus to the current choice (a panel that opened on a button's press). */
  focusOnMount?: boolean | undefined;
}

/** Choosing only moves the choice: the form around it saves, so arrow keys send nothing. */
export function AvatarPicker({
  value,
  onChange,
  id,
  name,
  colour,
  focusOnMount,
}: AvatarPickerProps) {
  const t = useT();
  const group = useId();
  const current = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusOnMount) current.current?.focus();
  }, [focusOnMount]);
  const letters = initials(name);

  return (
    <fieldset data-avatar-picker className="min-w-0">
      <legend className="font-medium">{t("avatar.label")}</legend>
      <p className="mb-2 text-sm text-ink-2">{t("avatar.hint")}</p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(2.75rem,1fr))] gap-1">
        {[null, ...AVATAR_IDS].map((option) => (
          <Option
            key={option ?? "initials"}
            ref={option === value ? current : undefined}
            option={option}
            label={t(option === null ? "avatar.initials" : `avatar.${option}`)}
            look={{ initials: letters, colour, ...(option === null ? {} : { art: option }) }}
            group={group}
            checked={option === value}
            onPick={() => onChange(option)}
            id={id}
          />
        ))}
      </div>
    </fieldset>
  );
}
