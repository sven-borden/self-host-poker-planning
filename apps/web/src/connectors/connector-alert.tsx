import { OctagonXIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../lib/utils.ts";

/** A refusal, drawn as the room's own are: the mark says it is one, whatever the words say. */
export function ConnectorAlert({ className, children, ...props }: ComponentProps<"p">) {
  return (
    <p role="alert" className={cn("m-0 flex items-start gap-2 text-sm", className)} {...props}>
      <OctagonXIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-bad" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}
