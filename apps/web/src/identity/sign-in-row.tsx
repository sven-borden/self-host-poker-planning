import type { SignInProvider } from "@pp/protocol";
import { Link } from "@tanstack/react-router";
import { OctagonXIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, buttonVariants } from "../components/ui/button.tsx";
import { useT } from "../i18n/hooks.ts";
import { cn } from "../lib/utils.ts";
import { codeOf, failureMessage } from "../room/failure.ts";
import { isSignedIn, useIdentityStore } from "../stores/identity-store.ts";
import googleLogo from "./google.svg";
import { signOut, startSignIn } from "./identity.ts";
import microsoftLogo from "./microsoft.svg";
import { signInProviders } from "./sign-in.ts";

const PROVIDERS = {
  google: { label: "signIn.google", logo: googleLogo, brand: "Google" },
  microsoft: { label: "signIn.microsoft", logo: microsoftLogo, brand: "Microsoft" },
} as const;

const busyClass = "aria-disabled:pointer-events-none aria-disabled:opacity-50";

/**
 * Signing in, quietly, wherever a person has a moment for it (#47): the "You" panel, the join
 * form and the create card. A guest sees a button per provider this install has, and nothing
 * when it has none; sign-in is never required. It is a full-page navigation, so the provider's
 * page opens in this tab and comes back here. Someone signed in sees which provider, their name
 * and "Sign out", which starts a fresh guest on this same page: a reload, as the old session's
 * socket cannot carry on, and "My rooms" (#49), which has no other way in: the top bar is full at
 * 320 px. A room may be on a shared screen, so the address shows only where a page asks for it
 * (`showAddress`): the landing page, and nowhere in a room. `only` (#50): a room limited to
 * accounts offers the providers that can pass it, and needs no word that this is optional.
 */
export function SignInRow({
  className,
  showAddress = false,
  only,
}: {
  className?: string;
  showAddress?: boolean;
  only?: readonly SignInProvider[];
}) {
  const t = useT();
  const status = useIdentityStore((state) => state.status);
  const email = useIdentityStore((state) => state.email);
  const name = useIdentityStore((state) => state.name);
  const provider = useIdentityStore((state) => state.provider);
  const signedIn = useIdentityStore(isSignedIn);
  const [offered] = useState(signInProviders);
  const providers = only ? offered.filter((id) => only.includes(id)) : offered;
  const [busy, setBusy] = useState<SignInProvider | "out" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // Back from the provider through the browser's history, this page may return as it was left.
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) setBusy(null);
    };
    window.addEventListener("pageshow", restored);
    return () => window.removeEventListener("pageshow", restored);
  }, []);

  async function run(action: SignInProvider | "out", go: () => Promise<void>) {
    // The buttons stay focusable while busy (aria-disabled), so a second press lands here.
    if (busy) return;
    setBusy(action);
    setFailure(null);
    try {
      // On success the page goes away: the buttons stay busy until it does.
      await go();
    } catch (error) {
      setFailure(failureMessage(t, codeOf(error)));
      setBusy(null);
    }
  }

  if (!signedIn && (status !== "ready" || providers.length === 0)) return null;
  const shown = showAddress ? email : name;
  return (
    <div data-sign-in className={cn("flex flex-col gap-3", className)}>
      {signedIn ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="m-0 flex min-w-0 flex-col text-sm text-ink-2">
            {provider === null
              ? t("signIn.signedInAs")
              : t("signIn.signedInWith", { provider: PROVIDERS[provider].brand })}
            {shown !== null && (
              <bdi data-account className="font-medium wrap-anywhere text-ink">
                {shown}
              </bdi>
            )}
          </p>
          <div className="flex flex-wrap gap-2 sm:shrink-0">
            <Link to="/rooms" data-my-rooms-link className={buttonVariants({ variant: "outline" })}>
              {t("myRooms.title")}
            </Link>
            <Button
              variant="outline"
              className={busyClass}
              aria-disabled={busy !== null || undefined}
              onClick={() =>
                run("out", async () => {
                  await signOut();
                  window.location.reload();
                })
              }
            >
              {busy === "out" ? t("signIn.signingOut") : t("signIn.signOut")}
            </Button>
          </div>
        </div>
      ) : (
        <>
          {only ? null : <p className="m-0 text-sm text-ink-2">{t("signIn.hint")}</p>}
          <div className="grid gap-2 sm:flex sm:flex-wrap">
            {providers.map((id) => (
              <Button
                key={id}
                variant="outline"
                data-sign-in-provider={id}
                className={busyClass}
                aria-disabled={busy !== null || undefined}
                onClick={() => run(id, async () => window.location.assign(await startSignIn(id)))}
              >
                <img src={PROVIDERS[id].logo} alt="" width={18} height={18} />
                {t(PROVIDERS[id].label)}
              </Button>
            ))}
          </div>
        </>
      )}
      {failure && (
        <p role="alert" className="m-0 flex items-start gap-2 text-sm">
          <OctagonXIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-bad" />
          {failure}
        </p>
      )}
    </div>
  );
}
