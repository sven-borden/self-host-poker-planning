import {
  cleanDomain,
  cleanTenant,
  MAX_RESTRICTION_ENTRIES,
  type Restriction,
  restrictionRefusal,
} from "@pp/domain";
import { OctagonXIcon, TriangleAlertIcon, UsersRoundIcon } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { useT } from "../i18n/hooks.ts";
import { signInProviders } from "../identity/sign-in.ts";
import { fetchRoomRestriction, type RoomRestrictionInfo } from "../rooms/api.ts";
import { useIdentityStore } from "../stores/identity-store.ts";
import { useRoomStore } from "../stores/room-store.ts";
import type { ControlProps } from "./settings-panel.tsx";

const FIELD_CLASS =
  "w-full min-w-0 resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-line/30";

const entries = (text: string) => text.split(/[\s,;]+/).filter((entry) => entry !== "");

/**
 * An entry as the rule holds it: an international name in its `xn--` form, as the server makes
 * it. Anything else stays as typed, for `cleanDomain` to refuse: `new URL` would quietly take
 * the host out of an address or a link.
 */
function asciiDomain(entry: string): string {
  if (!/[^\p{ASCII}]/u.test(entry) || /[/\\@:?#%[\]]/.test(entry)) return entry;
  try {
    return new URL(`https://${entry}`).hostname;
  } catch {
    return entry;
  }
}

/** What is wrong with what the PO typed, in words, or a rule (null: remove it). */
function parseRule(
  t: ReturnType<typeof useT>,
  domainText: string,
  tenantText: string,
): { rule: Restriction | null } | { problem: string } {
  const domains = entries(domainText).map(asciiDomain);
  const tenants = entries(tenantText);
  const badDomain = domains.find((entry) => cleanDomain(entry) === null);
  if (badDomain !== undefined) {
    return { problem: t("restriction.badDomain", { entry: badDomain }) };
  }
  const badTenant = tenants.find((entry) => cleanTenant(entry) === null);
  if (badTenant !== undefined) {
    return { problem: t("restriction.badTenant", { entry: badTenant }) };
  }
  if (domains.length > MAX_RESTRICTION_ENTRIES || tenants.length > MAX_RESTRICTION_ENTRIES) {
    return { problem: t("restriction.tooMany", { max: MAX_RESTRICTION_ENTRIES }) };
  }
  return { rule: domains.length + tenants.length === 0 ? null : { domains, tenants } };
}

/**
 * The PO's "Who can join" row (#50, ADR-028), a `block` control that plugs in by #25's contract:
 * `change` carries the rule through `updateSettings`, so the panel does its pending state and
 * its rollback, and the server judges it. A list per provider this install has, one entry a
 * line, and each list also while the rule still holds entries the install can no longer
 * check, so the PO can take them out. A rule the PO does not meet asks first: the PO stays,
 * and may not have meant it. The panel reads how many people here would not pass, never who.
 */
export function RestrictionSetting({
  room,
  settings,
  change,
  pending,
  id,
  describedBy,
}: ControlProps) {
  const t = useT();
  const code = useRoomStore((state) => state.code);
  const signedIn = useIdentityStore((state) => state.provider !== null);
  const rule = settings.restriction;
  const [providers] = useState(signInProviders);
  const google = providers.includes("google");
  const microsoft = providers.includes("microsoft");
  const stored = {
    domains: rule?.domains.join("\n") ?? "",
    tenants: rule?.tenants?.join("\n") ?? "",
  };
  const [domains, setDomains] = useState(stored.domains);
  const [tenants, setTenants] = useState(stored.tenants);
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState<Restriction | null>(null);
  const [info, setInfo] = useState<RoomRestrictionInfo | null>(null);
  const ids = {
    domains: useId(),
    tenants: useId(),
    domainsHint: useId(),
    tenantsHint: useId(),
    problem: useId(),
  };
  const problemId = problem === null ? "" : ids.problem;
  const showDomains = google || stored.domains !== "";
  const showTenants = microsoft || stored.tenants !== "";

  // The row follows the room: what the PO typed gives way to what the server stored.
  useEffect(() => {
    setDomains(stored.domains);
    setTenants(stored.tenants);
  }, [stored.domains, stored.tenants]);

  // Asked again when the rule or the people change; a read that fails shows no count.
  const people = room.participants.map((person) => person.id).join(" ");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `people` and the rule ask again.
  useEffect(() => {
    if (code === null || !signedIn) return;
    let current = true;
    fetchRoomRestriction(code).then(
      (read) => current && setInfo(read),
      () => current && setInfo(null),
    );
    return () => {
      current = false;
    };
  }, [code, signedIn, people, stored.domains, stored.tenants]);

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setAsking(null);
    const parsed = parseRule(t, domains, tenants);
    if ("problem" in parsed) {
      setProblem(parsed.problem);
      return;
    }
    setProblem(null);
    const next = parsed.rule;
    // No answer about the PO's own account: asked, as a rule that shuts them out might.
    if (next && restrictionRefusal(next, info?.own ?? null, { google, microsoft }) !== null) {
      setAsking(next);
      return;
    }
    change({ restriction: next });
  }

  if (!signedIn && rule === undefined) {
    return (
      <p id={id} data-restriction-sign-in className="m-0 text-sm">
        {t("restriction.signInFirst")}
      </p>
    );
  }
  const outsiders = rule === undefined ? 0 : (info?.outsiders ?? 0);
  return (
    <form
      id={id}
      data-restriction-setting
      className="flex flex-col gap-3"
      onSubmit={save}
      noValidate
      aria-busy={pending || undefined}
    >
      {showDomains ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.domains} className="text-sm font-medium">
            {t("restriction.domainsLabel")}
          </label>
          <textarea
            id={ids.domains}
            data-restriction-domains
            value={domains}
            onChange={(event) => setDomains(event.target.value)}
            aria-describedby={`${describedBy} ${ids.domainsHint} ${problemId}`}
            rows={2}
            autoComplete="off"
            spellCheck={false}
            className={FIELD_CLASS}
          />
          <p id={ids.domainsHint} className="m-0 text-sm text-ink-2">
            {t("restriction.domainsHint")}
          </p>
          {google ? null : <Warning>{t("restriction.googleGone")}</Warning>}
        </div>
      ) : null}
      {showTenants ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.tenants} className="text-sm font-medium">
            {t("restriction.tenantsLabel")}
          </label>
          <textarea
            id={ids.tenants}
            data-restriction-tenants
            value={tenants}
            onChange={(event) => setTenants(event.target.value)}
            aria-describedby={`${describedBy} ${ids.tenantsHint} ${problemId}`}
            rows={2}
            autoComplete="off"
            spellCheck={false}
            className={FIELD_CLASS}
          />
          <p id={ids.tenantsHint} className="m-0 text-sm text-ink-2">
            {t("restriction.tenantsHint")}
          </p>
          {microsoft ? null : <Warning>{t("restriction.microsoftGone")}</Warning>}
        </div>
      ) : null}
      {outsiders > 0 ? (
        <p data-restriction-outsiders className="m-0 flex items-start gap-2 text-sm">
          <UsersRoundIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-2" />
          {t("restriction.outsiders", { count: outsiders })}
        </p>
      ) : null}
      {problem !== null ? (
        <p
          id={ids.problem}
          role="alert"
          data-restriction-problem
          className="m-0 flex items-start gap-2 text-sm wrap-anywhere"
        >
          <OctagonXIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-bad" />
          {problem}
        </p>
      ) : null}
      {asking !== null ? (
        <div data-restriction-ask className="flex flex-col gap-2">
          <p role="alert" className="m-0 flex items-start gap-2 text-sm">
            <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-2" />
            {t("restriction.askFirst")}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={() => {
                change({ restriction: asking });
                setAsking(null);
              }}
            >
              {t("restriction.askConfirm")}
            </Button>
            <Button type="button" variant="outline" onClick={() => setAsking(null)}>
              {t("password.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            aria-disabled={pending || undefined}
            className="aria-disabled:opacity-60"
          >
            {t("restriction.save")}
          </Button>
          {rule !== undefined ? (
            <Button
              type="button"
              variant="outline"
              aria-disabled={pending || undefined}
              className="aria-disabled:opacity-60"
              onClick={() => {
                if (!pending) change({ restriction: null });
              }}
            >
              {t("restriction.remove")}
            </Button>
          ) : null}
        </div>
      )}
    </form>
  );
}

function Warning({ children }: { children: string }) {
  return (
    <p data-restriction-gone className="m-0 flex items-start gap-2 text-sm">
      <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-2" />
      {children}
    </p>
  );
}
