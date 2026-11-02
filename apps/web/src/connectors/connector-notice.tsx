import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useT } from "../i18n/hooks.ts";
import { clearConnectorResult, connectorResult, SYSTEM_NAMES } from "./connector.ts";

/**
 * A connection that came back with no room to come back to (#54, ADR-030): the server could not
 * tell which one, because the `state` was spent, swept or not this session's, or the limit was
 * reached first. The person left a room for this, so the page says what happened and the way back.
 */
export function ConnectorNotice() {
  const t = useT();
  const [result] = useState(connectorResult);
  useEffect(() => clearConnectorResult, []);
  if (result === null) return null;
  const system = SYSTEM_NAMES.jira;
  return (
    <p role="status" data-connector-notice={result} className="m-0 mb-4 text-sm">
      {result === "connected"
        ? t("connector.result.connected", { system })
        : result === "cancelled"
          ? t("connector.result.cancelled", { system })
          : t("connector.result.lost", { system })}{" "}
      <Link to="/rooms" className="text-spruce underline underline-offset-2">
        {t("myRooms.title")}
      </Link>
    </p>
  );
}
