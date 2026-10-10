import type { Server as HttpServer } from "node:http";
import { Server as SocketIOServer, type Socket } from "socket.io";

/**
 * The real-time transport surface injected from the social module's
 * realtime service (PORCH-047). Structural types only — apps/server
 * performs no domain logic: it maps socket.io lifecycle events onto the
 * service's subscribe/unsubscribe/kill surface and hands each verified
 * channel its emit + close handles back.
 */
export interface RealtimeEndpointLike {
  subscribe(input: {
    token: string | null;
    networkId: unknown;
    channel: { id: string; emit: (envelope: unknown) => void; close: () => void };
  }): Promise<{ did: string; membershipId: string; networkId: string }>;
  unsubscribe(channelId: string): void;
  close(): void;
}

export interface RealtimeGatewayOptions {
  /** The social module's realtime service (assembled by createServerRouter). */
  realtime: RealtimeEndpointLike;
  /** Auth-failure capture sink (PORCH-019 shape); defaults to console.log. */
  log?: ((line: string) => void) | null;
}

/**
 * Attach the hub's real-time event delivery to the hub's own HTTP server
 * (PORCH-047, TS 8 "WebSocket over the hub's existing Express origin"):
 * socket.io intercepts its own path before the Express pipeline, so the
 * SPA fallback stays untouched and the SPA static surface never sees a
 * socket request.
 *
 * Subscribe protocol:
 *   - handshake auth `{ networkId, token }` → the connection IS the
 *     subscription (verified server-side before the socket opens), or
 *   - `events:subscribe` message `{ networkId, token }` → verified at
 *     subscribe time; the ack carries { ok } or { ok: false, code, message }
 *     with the plain-language refusal (no token material, no internals).
 *
 * Delivery: verified channels receive `event` messages carrying the
 * origin envelope (seq-cursor + content-only payload).
 */
export function attachRealtimeGateway(httpServer: HttpServer, deps: RealtimeGatewayOptions): SocketIOServer {
  const io = new SocketIOServer(httpServer, { serveClient: false });
  const subscribeSocket = async (socket: Socket, message: { networkId?: unknown; token?: unknown } = {}) => {
    const token = typeof message.token === "string" ? message.token : null;
    const view = await deps.realtime.subscribe({
      token,
      networkId: message.networkId ?? null,
      channel: {
        id: socket.id,
        emit: (envelope: unknown) => socket.emit("event", envelope),
        close: () => socket.disconnect(true),
      },
    });
    socket.data.realtimeNetworkId = view.networkId;
    return view;
  };
  // Handshake auth `{ networkId, token }`: the connection IS the
  // subscription, verified server-side BEFORE the socket ever opens — a
  // refusal is a refused handshake (client: connect_error), never an open
  // room that closes late.
  io.use(async (socket, next) => {
    const auth = socket.handshake.auth as { networkId?: unknown; token?: unknown } | undefined;
    if (!auth?.token) return next();
    try {
      await subscribeSocket(socket, { networkId: auth.networkId, token: auth.token });
      return next();
    } catch (error) {
      const code = (error as { code?: string }).code ?? "E_NOT_PERMITTED";
      if (deps.log) deps.log(`realtime handshake refused (${code})`);
      return next(new Error((error as Error).message));
    }
  });
  io.on("connection", (socket) => {
    socket.on("events:subscribe", async (message: { networkId?: unknown; token?: unknown }, ack?: (result: Record<string, unknown>) => void) => {
      try {
        const view = await subscribeSocket(socket, message);
        ack?.({ ok: true, networkId: view.networkId, did: view.did });
      } catch (error) {
        const code = (error as { code?: string }).code ?? "E_NOT_PERMITTED";
        ack?.({ ok: false, code, message: (error as Error).message });
      }
    });
    socket.on("events:unsubscribe", () => deps.realtime.unsubscribe(socket.id));
    socket.on("disconnect", () => deps.realtime.unsubscribe(socket.id));
  });
  io.engine.on("connection_error", (error) => {
    if (deps.log) deps.log(`realtime handshake refused: ${String((error as { message?: string }).message ?? "unknown")}`);
  });
  return io;
}

export default attachRealtimeGateway;