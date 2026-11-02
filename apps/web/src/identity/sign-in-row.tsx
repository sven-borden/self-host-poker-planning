import type { SignInProvider } from "@pp/protocol";
import { OctagonXIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { useT } from "../i18n/hooks.ts";
import { cn } from "../lib/utils.ts";
import { codeOf, failureMessage } from "../room/failure.ts";
import { useIdentityStore } from "../stores/identity-store.ts";
import googleLogo from "./google.svg";
import { signOut, startSignIn } from "./identity.ts";
import microsoftLogo from "./microsoft.svg";
import { signInProviders } from "./sign-in.ts";

const PROVIDERS = {
  google: { label: "signIn.google", logo: googleLogo },
  microsoft: { label: "signIn.microsoft", logo: microsoftLogo },
} as const;

const busyClass = "aria-disabled:pointer-events-none aria-disabled:opacity-50";

/**
 * Signing in, quietly, wherever a person has a moment for it (#47): the "You" panel, the join
 * form and the create card. A guest sees a button per provider this install has, and nothing
 * when it has none; sign-in is never required. It is a full-page navigation, so the provider's
 * page opens in this tab and comes back here. Someone signed in sees the address and "Sign
 * out", which starts a fresh guest on this same page: a reload, as the old session's socket
 * cannot carry on. The address is shown to its owner here and nowhere else.
 */
export function SignInRow({ className }: { className?: string }) {
  const t = useT();
  const status = useIdentityStore((state) => state.status);
  const email = useIdentityStore((state) => state.email);
  const [providers] = useState(signInProviders);
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

  if (email === null && (status !== "ready" || providers.length === 0)) return null;
  return (
    <div data-sign-in className={cn("flex flex-col gap-3", className)}>
      {email !== null ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="m-0 flex min-w-0 flex-col text-sm text-ink-2">
            {t("signIn.signedInAs")}
            <bdi data-account className="font-medium wrap-anywhere text-ink">
              {email}
            </bdi>
          </p>
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
      ) : (
        <>
          <p className="m-0 text-sm text-ink-2">{t("signIn.hint")}</p>
          <div className="grid gap-2 sm:flex sm:flex-wrap">
            {providers.map((provider) => (
              <Button
                key={provider}
                variant="outline"
                data-sign-in-provider={provider}
                className={busyClass}
                aria-disabled={busy !== null || undefined}
                onClick={() =>
                  run(provider, async () => window.location.assign(await startSignIn(provider)))
                }
              >
                <img src={PROVIDERS[provider].logo} alt="" width={18} height={18} />
                {t(PROVIDERS[provider].label)}
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
