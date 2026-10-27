import { LanguagesIcon } from "lucide-react";
import { useLanguage, useT } from "../../i18n/hooks.ts";
import { loadLanguage } from "../../i18n/i18n.ts";
import { isLanguage, LANGUAGE_NAMES, LANGUAGES } from "../../i18n/language.ts";
import { Button } from "../ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.tsx";

/**
 * English, Français, Deutsch: each named in itself and marked with its `lang`, so a reader
 * finds theirs whatever the page speaks. The choice is saved; every string changes at once,
 * without a reload. Opening the menu fetches the other catalogs, so a pick shows at once;
 * a pick whose catalog cannot be fetched shows a toast that asks for a reload.
 * On phones the trigger is the icon alone, like the theme toggle.
 */
export function LanguageSwitcher() {
  const t = useT();
  const [language, setLanguage] = useLanguage();
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) {
          for (const option of LANGUAGES) {
            // A failed prefetch is retried when the person picks that language.
            loadLanguage(option).catch(() => {});
          }
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="px-3 has-[>svg]:px-3 phone:w-11 phone:px-0 phone:has-[>svg]:px-0"
          aria-label={t("language.current", { language: LANGUAGE_NAMES[language] })}
        >
          <LanguagesIcon aria-hidden="true" />
          <span lang={language} className="phone:hidden">
            {LANGUAGE_NAMES[language]}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        <DropdownMenuLabel>{t("language.label")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          aria-label={t("language.label")}
          value={language}
          onValueChange={(value) => {
            if (isLanguage(value)) {
              // On a failed fetch the page stays in its language and says so: after a
              // redeploy the old chunk is gone, and only a reload fetches the new one.
              // The toaster is a lazy chunk, so the toast is too.
              setLanguage(value).catch(() => {
                void import("sonner").then(({ toast }) => {
                  toast.error(t("language.loadFailed"), { id: "language-load-failed" });
                });
              });
            }
          }}
        >
          {LANGUAGES.map((option) => (
            <DropdownMenuRadioItem key={option} value={option} lang={option} className="min-h-11">
              {LANGUAGE_NAMES[option]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
