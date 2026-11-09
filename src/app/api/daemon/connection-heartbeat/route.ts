import { NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext } from "@/lib/auth";
import { touchConnection } from "@/services/daemon-connection.service";
import { sweepExpiredCliLeasesForConnection } from "@/services/daemon-session.service";

const bodySchema = z.object({
  connectionUuid: z.string().min(1),
  connectedAt: z.string().datetime({ offset: true }),
});

export const POST = withErrorHandler(async (request: NextRequest) => {
  const auth = await getAuthContext(request);
  if (!auth || auth.type !== "agent") {
    return errors.unauthorized();
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errors.badRequest("Invalid JSON body");
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return errors.validationError(parsed.error.flatten());
  }

  const acknowledged = await touchConnection(
    auth.companyUuid,
    {
      uuid: parsed.data.connectionUuid,
      connectedAt: new Date(parsed.data.connectedAt),
    },
    auth.actorUuid,
  );

  if (!acknowledged) {
    return errors.notFound("Connection");
  }

  // cli-agent-session-sync D4 trigger 2: piggyback the expired-CLI-lease sweep on the
  // origin daemon's heartbeat (no server timer). Best-effort — it swallows + logs its own
  // errors, so a sweep failure never fails the heartbeat acknowledgment.
  await sweepExpiredCliLeasesForConnection(auth.companyUuid, parsed.data.connectionUuid);

  return success({ acknowledged: true });
});
