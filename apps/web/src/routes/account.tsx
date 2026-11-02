import { createFileRoute } from "@tanstack/react-router";
import { AccountPage } from "../account/account-page.tsx";

// A lazy route (`autoCodeSplitting`): only signed-in people need this page, so nothing of it, its
// words included, joins the landing page's or the room route's JavaScript.
export const Route = createFileRoute("/account")({
  component: AccountPage,
});
