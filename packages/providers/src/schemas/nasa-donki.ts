import { z } from "zod";

/**
 * NASA DONKI — the CCMC's Database Of Notifications, Knowledge, Information.
 *
 * Verified against a real production response captured on 2026-09-02 (74 notifications
 * across August 2026); see `fixtures/nasa-donki-notifications.json` and the manifest.
 *
 * WHAT IT ADDS OVER NOAA SWPC
 * NOAA reports the CURRENT level on the R/S/G scales — a number describing right now.
 * DONKI publishes discrete EVENTS with narrative: a coronal mass ejection was observed,
 * a geomagnetic storm began, a radiation belt enhancement was detected. The two answer
 * different questions, and for a tracker the events matter because they are what
 * precede the drag and radiation conditions that degrade propagation accuracy.
 *
 * MESSAGE TYPES, AS OBSERVED
 * The captured window contained CME, GST, FLR, SEP, RBE, IPS, MPC and Report. The
 * enum is deliberately open at the bottom: NASA adds types, and a new one must not
 * fail an ingestion that could otherwise store it.
 */

/**
 * Known DONKI message types.
 *
 * CME  coronal mass ejection      GST  geomagnetic storm
 * FLR  solar flare                SEP  solar energetic particle
 * RBE  radiation belt enhancement IPS  interplanetary shock
 * MPC  magnetopause crossing      Report  a periodic summary
 */
export const DONKI_MESSAGE_TYPES = [
  "CME",
  "GST",
  "FLR",
  "SEP",
  "RBE",
  "IPS",
  "MPC",
  "Report",
] as const;

export type DonkiMessageType = (typeof DONKI_MESSAGE_TYPES)[number];

/**
 * `messageIssueTime` arrives as "2026-08-31T16:51Z" — minute precision, no seconds.
 *
 * That is valid ISO 8601 and `new Date` handles it, but the missing seconds are worth
 * naming: anything that reconstructs the string by formatting the Date will not round
 * trip, and a comparison against a seconds-precision timestamp is off by up to a minute.
 */
const donkiTimestamp = z.string().refine(
  (value) => !Number.isNaN(new Date(value).getTime()),
  "Expected a parseable DONKI timestamp",
);

export const donkiNotificationSchema = z
  .object({
    messageType: z.string(),
    /** e.g. "20260831-AL-004". Stable, and unique per notification. */
    messageID: z.string(),
    messageURL: z.string(),
    messageIssueTime: donkiTimestamp,
    /**
     * The full narrative, as published: a long pre-formatted block beginning with
     * "## Message Type: ...". Stored verbatim rather than parsed into fields — its
     * layout is prose written for humans and varies by message type, so extracting
     * structure from it would be inventing data NASA did not publish.
     */
    messageBody: z.string(),
  })
  .passthrough();

export const donkiNotificationsResponseSchema = z.array(donkiNotificationSchema);

export type DonkiNotification = z.infer<typeof donkiNotificationSchema>;

/** A notification, normalised for storage. */
export interface SolarEvent {
  readonly id: string;
  readonly type: string;
  /** True when the type is one this product recognises and can explain. */
  readonly known: boolean;
  readonly issuedAt: Date;
  readonly url: string;
  readonly body: string;
  /** First meaningful line of the narrative, for a list view. */
  readonly summary: string;
}

/**
 * The first line of the body that carries information.
 *
 * DONKI bodies open with several `##` header lines — the database name, the message
 * type, the issue date, the id — before any content. Showing those in a list would
 * fill it with boilerplate, so they are skipped, and the first real sentence is used.
 * If there is none, the summary is empty rather than a fabricated one.
 */
export function summariseDonkiBody(body: string): string {
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("##")) continue;
    return line.length > 200 ? `${line.slice(0, 197)}...` : line;
  }
  return "";
}

export function toSolarEvents(input: unknown): readonly SolarEvent[] {
  const notifications = donkiNotificationsResponseSchema.parse(input);

  /*
   * No per-record salvage here, unlike SatNOGS DB.
   *
   * DONKI is a single curated NASA service, not a community database: a notification
   * whose issue time will not parse means the format changed, and the schema above
   * refuses it loudly rather than letting this quietly drop records until an event
   * list is silently incomplete. An event list missing a geomagnetic storm because one
   * record was skipped is worse than an ingestion that failed and said so.
   */
  return notifications.map((notification) => ({
    id: notification.messageID,
    type: notification.messageType,
    known: (DONKI_MESSAGE_TYPES as readonly string[]).includes(notification.messageType),
    issuedAt: new Date(notification.messageIssueTime),
    url: notification.messageURL,
    body: notification.messageBody,
    summary: summariseDonkiBody(notification.messageBody),
  }));
}
