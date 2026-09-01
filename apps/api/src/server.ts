import compress from "@fastify/compress";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { LayeredCache } from "@orbitwatch/cache";
import type { Database } from "@orbitwatch/database";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { ZodError } from "zod";

import { safeDetail } from "./redact.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerSatelliteRoutes } from "./routes/satellites.js";

/**
 * The OrbitWatch HTTP API.
 *
 * A standalone Fastify service rather than Next.js route handlers, because the iOS and
 * Android apps must not depend on Next.js internals. Web, mobile and any future client
 * talk to exactly the same service.
 *
 * `buildServer` takes its dependencies as arguments and never reads the environment.
 * That is what lets the whole surface be tested against `InMemoryDatabase` through
 * `.inject()`, with no network, no database and no credentials.
 */

export interface ServerDependencies {
  readonly database: Database;
  readonly cache: LayeredCache;
  /** Reported by /health. */
  readonly version?: string;
  /** Injectable clock, so freshness assertions are not timing-dependent. */
  readonly now?: () => Date;
  /** Allowed browser origins. Omit to allow same-origin only. */
  readonly corsOrigins?: readonly string[];
  readonly logger?: boolean;
  /**
   * Requests per minute per client.
   *
   * The API propagates orbits and reads a shared database on behalf of every client, so
   * an unbounded caller can degrade the service for everyone. This is our own limit and
   * is unrelated to the provider fetch guard, which protects third parties from us.
   */
  readonly rateLimitPerMinute?: number;
}

export interface ApiContext {
  readonly database: Database;
  readonly cache: LayeredCache;
  readonly now: () => Date;
  readonly startedAt: Date;
  readonly version: string;
}

const DEFAULT_RATE_LIMIT_PER_MINUTE = 120;

/** An error already shaped as an API envelope, carrying its own status. */
interface PreformattedError {
  readonly statusCode: number;
  readonly error: { readonly code: string; readonly message: string };
}

function isPreformattedError(value: unknown): value is PreformattedError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<PreformattedError>;
  return (
    typeof candidate.statusCode === "number" &&
    typeof candidate.error === "object" &&
    candidate.error !== null &&
    typeof candidate.error.code === "string"
  );
}

export async function buildServer(
  dependencies: ServerDependencies,
): Promise<FastifyInstance> {
  const now = dependencies.now ?? (() => new Date());

  const app = Fastify({
    logger: dependencies.logger ?? false,
    // Trust the proxy's forwarded headers so rate limiting keys on the real client
    // rather than on the load balancer, which would otherwise share one bucket.
    trustProxy: true,
    // Bound the request body. Every endpoint here is a GET; a large body is either a
    // mistake or an attack, and neither deserves memory.
    bodyLimit: 64 * 1024,
  });

  const context: ApiContext = {
    database: dependencies.database,
    cache: dependencies.cache,
    now,
    startedAt: now(),
    version: dependencies.version ?? "0.0.0",
  };

  // The catalog endpoint serves every tracked object in one response: 10.9 MB of
  // highly repetitive JSON, which gzip takes to 1.5 MB — a 7.4x reduction measured on
  // the real 16,468-object payload. Compression is registered before the routes so it
  // applies to all of them.
  //
  // The 1 KB threshold keeps small responses uncompressed, where the CPU cost and the
  // few bytes of framing outweigh anything saved.
  await app.register(compress, {
    global: true,
    threshold: 1024,
    encodings: ["br", "gzip", "deflate"],
  });

  await app.register(cors, {
    origin:
      dependencies.corsOrigins === undefined ? false : [...dependencies.corsOrigins],
    methods: ["GET"],
  });

  await app.register(rateLimit, {
    max: dependencies.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE,
    timeWindow: "1 minute",
    // /health must answer even for a client that has exhausted its budget: a monitor
    // being rate limited would report an outage that is not happening.
    allowList: (request) => request.url.startsWith("/health"),
    // @fastify/rate-limit passes this object straight to the error handler with no
    // statusCode of its own, so the status is carried explicitly and stripped from the
    // body below. Without it the handler cannot tell a 429 from an internal failure.
    errorResponseBuilder: (_request, context_) => ({
      statusCode: 429,
      error: {
        code: "RATE_LIMITED",
        message: `Rate limit exceeded. Try again in ${Math.ceil(context_.ttl / 1000)}s.`,
      },
    }),
  });

  /**
   * One error shape for every failure.
   *
   * Internal errors deliberately do not reach the client: a stack trace or a driver
   * message can carry table names, query text, or a connection string. It is logged in
   * full and reported as a generic failure.
   */
  app.setErrorHandler((error: FastifyError | ZodError | unknown, request, reply) => {
    // Some plugins hand the handler an already-shaped envelope rather than an Error.
    // Forwarded verbatim so one response shape survives the whole surface.
    if (isPreformattedError(error)) {
      return reply.status(error.statusCode).send({ error: error.error });
    }

    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: "INVALID_REQUEST",
          message: "The request parameters were not valid.",
          details: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      });
    }

    const fastifyError = error as FastifyError;
    const status = fastifyError.statusCode ?? 500;

    if (status >= 500) {
      request.log.error({ err: error }, "Unhandled error");
      // The client is told nothing beyond "it failed". A driver message or stack trace
      // can carry table names, query text or a connection string.
      return reply.status(status).send({
        error: { code: "INTERNAL_ERROR", message: "An internal error occurred." },
      });
    }

    return reply.status(status).send({
      error: {
        code: fastifyError.code ?? "REQUEST_FAILED",
        message: safeDetail(fastifyError.message) ?? "Request failed.",
      },
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: {
        code: "NOT_FOUND",
        message: `No route for ${request.method} ${request.url}`,
      },
    }),
  );

  await registerHealthRoutes(app, context);
  await registerProviderRoutes(app, context);
  await registerSatelliteRoutes(app, context);

  return app;
}
