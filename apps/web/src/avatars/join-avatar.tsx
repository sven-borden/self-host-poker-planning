import type { AvatarId } from "@pp/domain";
import { ChevronDownIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { useT } from "../i18n/hooks.ts";
import { cn } from "../lib/utils.ts";
import { useIdentityStore } from "../stores/identity-store.ts";
import { Avatar, avatarColour, initials } from "../table/avatar.tsx";
import { AvatarPicker } from "./avatar-picker.tsx";
import { loadAvatarArt } from "./use-art.ts";

export interface JoinAvatarProps {
  value: AvatarId | null;
  onChange: (avatar: AvatarId | null) => void;
  /** The name as typed, for the initials. */
  name: string;
}

/**
 * The join form's avatar (#42), a lazy chunk: the person as the table will show them, and
 * a disclosure with the picker. Closed by default: most people came to vote, and the form
 * stays one screen on a phone.
 */
export function JoinAvatar({ value, onChange, name }: JoinAvatarProps) {
  const t = useT();
  const panel = useId();
  const [open, setOpen] = useState(false);
  const id = useIdentityStore((state) => state.userId) ?? "";
  const colour = avatarColour(id);

  useEffect(() => {
    void loadAvatarArt();
  }, []);

  return (
    <div data-join-avatar className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Avatar
          id={id}
          name={name}
          size={36}
          look={{ initials: initials(name), colour, ...(value === null ? {} : { art: value }) }}
        />
        <Button
          type="button"
          variant="outline"
          aria-expanded={open}
          aria-controls={panel}
          onClick={() => setOpen(!open)}
        >
          {t(value === null ? "avatar.choose" : "avatar.change")}
          <ChevronDownIcon
            aria-hidden
            className={cn("size-4 transition-transform", open && "rotate-180")}
          />
        </Button>
      </div>
      <div id={panel} hidden={!open}>
        {open ? (
          <AvatarPicker value={value} onChange={onChange} id={id} name={name} colour={colour} />
        ) : null}
      </div>
    </div>
  );
}
