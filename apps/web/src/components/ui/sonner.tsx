import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { CSSProperties } from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";
// Its sheet as CSS of the app's own: the build cuts the <style> sonner would write, which
// the Content Security Policy refuses (vite.config.ts, #36).
import "sonner/dist/styles.css";
import { useT } from "@/i18n/hooks.ts";
import { useThemeMode } from "@/theme/use-theme-mode.ts";

// shadcn's sonner wrapper, with our theme store in place of next-themes and translated
// labels for screen readers.
const Toaster = ({ ...props }: ToasterProps) => {
  const [mode] = useThemeMode();
  const t = useT();

  return (
    <Sonner
      theme={mode}
      className="toaster group"
      containerAriaLabel={t("common.notifications")}
      toastOptions={{ closeButtonAriaLabel: t("common.close") }}
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
