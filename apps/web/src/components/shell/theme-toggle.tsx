import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useT } from "../../i18n/hooks.ts";
import { isThemeMode, THEME_MODES, type ThemeMode } from "../../theme/theme.ts";
import { useThemeMode } from "../../theme/use-theme-mode.ts";
import { Button } from "../ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.tsx";

const ICONS: Record<ThemeMode, typeof SunIcon> = {
  light: SunIcon,
  dark: MoonIcon,
  system: MonitorIcon,
};

/** Light, dark or system. The choice is saved and applied before first paint next time. */
export function ThemeToggle() {
  const t = useT();
  const [mode, setMode] = useThemeMode();
  const CurrentIcon = ICONS[mode];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("theme.current", { mode: t(`theme.${mode}`) })}
        >
          <CurrentIcon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        <DropdownMenuLabel>{t("theme.label")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          aria-label={t("theme.label")}
          value={mode}
          onValueChange={(value) => {
            if (isThemeMode(value)) {
              setMode(value);
            }
          }}
        >
          {THEME_MODES.map((option) => {
            const Icon = ICONS[option];
            return (
              <DropdownMenuRadioItem key={option} value={option} className="min-h-11">
                <Icon aria-hidden="true" />
                {t(`theme.${option}`)}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
