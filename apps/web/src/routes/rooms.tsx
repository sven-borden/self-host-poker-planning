import { createFileRoute } from "@tanstack/react-router";
import { loadCopy } from "../i18n/i18n.ts";
import { MyRoomsPage } from "../rooms/my-rooms-page.tsx";

// A lazy route (`autoCodeSplitting`): only signed-in people need this page, so nothing of it
// joins the landing page's or the room route's JavaScript. Its words load as the route's data, in
// the page's language (U6), so the page shows once they are in.
export const Route = createFileRoute("/rooms")({
  loader: () => loadCopy("myRooms"),
  component: MyRoomsPage,
});
