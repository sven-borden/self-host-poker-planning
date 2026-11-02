import { createFileRoute } from "@tanstack/react-router";
import { MyRoomsPage } from "../rooms/my-rooms-page.tsx";

// A lazy route (`autoCodeSplitting`): only signed-in people need this page, so nothing of it
// joins the landing page's or the room route's JavaScript.
export const Route = createFileRoute("/rooms")({
  component: MyRoomsPage,
});
