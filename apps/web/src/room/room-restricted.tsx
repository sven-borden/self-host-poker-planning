import { RULE_SESSION_MAX_AGE_DAYS } from "@pp/domain";
import type { SignInProvider } from "@pp/protocol";
import { Link } from "@tanstack/react-router";
import { ShieldCheckIcon } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { buttonVariants } from "../components/ui/button.tsx";
import { useFormat, useT } from "../i18n/hooks.ts";
import type { TFunction } from "../i18n/i18n.ts";
import { SignInRow } from "../identity/sign-in-row.tsx";
import { useIdentityStore } from "../stores/identity-store.ts";
import type { RoomRefusal } from "../stores/room-store.ts";

/** Why this account did not pass, by what it is: a domain rule and a Microsoft sign-in differ. */
function reasonFor(
  t: TFunction,
  { code, domains, organisation }: RoomRefusal,
  provider: SignInProvider | null,
): string {
  if (code === "sign_in_required") return t("restriction.guest");
  if (code === "restriction_unavailable") return t("restriction.unavailable");
  if (code === "session_too_old") {
    return t("restriction.sessionTooOld", { days: RULE_SESSION_MAX_AGE_DAYS });
  }
  if (provider === "microsoft") {
    return t(organisation ? "restriction.otherOrganisation" : "restriction.microsoftDomain");
  }
  if (provider === "google") {
    return t(domains.length > 0 ? "restriction.otherDomain" : "restriction.needsMicrosoft");
  }
  return t("restriction.otherAccount");
}

/**
 * The room's rule refused this person (#50, ADR-028): no room behind it, no name, no people. It
 * says what would pass, a tenant only as "your organisation", and why this account did not. The
 * sign-in buttons are the providers that can work: a wrong account signs out here, which reloads
 * this page as a guest, and signs in again from it, so the room stays the return path. Said
 * and focused once, like the room-full screen.
 */
export function RoomRestricted({ refusal }: { refusal: RoomRefusal }) {
  const t = useT();
  const format = useFormat();
  const provider = useIdentityStore((state) => state.provider);
  const heading = useId();
  const ref = useRef<HTMLElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const { domains, organisation } = refusal;
  const allowed = format.anyOf(domains);
  const needs =
    domains.length > 0 && organisation
      ? t("restriction.needsBoth", { domains: allowed })
      : domains.length > 0
        ? t("restriction.needsDomains", { domains: allowed })
        : organisation
          ? t("restriction.needsOrganisation")
          : null;
  const only: SignInProvider[] = [
    ...(domains.length > 0 ? (["google"] as const) : []),
    ...(organisation ? (["microsoft"] as const) : []),
  ];
  return (
    <section
      ref={ref}
      tabIndex={-1}
      aria-labelledby={heading}
      data-room-restricted={refusal.code}
      className="max-w-xl rounded-xl border border-line bg-surface p-5 outline-none sm:p-7"
    >
      <h2 id={heading} className="flex items-start gap-2 text-2xl font-[760] [font-stretch:110%]">
        <ShieldCheckIcon aria-hidden className="mt-1 size-6 shrink-0 text-ink-2" />
        {t("restriction.title")}
      </h2>
      {needs !== null ? <p className="mt-2 text-ink-2 wrap-anywhere">{needs}</p> : null}
      <p role="status" data-room-refusal className="mt-2">
        {reasonFor(t, refusal, provider)}
      </p>
      {only.length > 0 ? (
        <SignInRow only={only} className="mt-6 border-t border-line pt-5" />
      ) : null}
      <Link to="/" className={buttonVariants({ variant: "outline", className: "mt-6" })}>
        {t("room.backHome")}
      </Link>
    </section>
  );
}
