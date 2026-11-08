/**
 * Conference-room meetings: who sits where while a meeting is calling or running. The host (the Floor
 * Manager) takes the head chair `sm-seat-conf-host`, whoever made the video sits first, then the rest of the
 * crew fill `sm-seat-conf-1..10` (office-layout/generate.js). No conference room in the layout = no seats.
 */
import type { SmMeeting } from './smClient.js';

export const CONF_HOST_SEAT = 'sm-seat-conf-host';
export const CONF_SEAT_PREFIX = 'sm-seat-conf-';
const CONF_SEATS = 10;

/** The meeting that should pull the crew into the conference room right now, if any. */
export const liveMeeting = (meetings: SmMeeting[] | undefined): SmMeeting | null =>
  (meetings ?? []).find((m) => m.status === 'in-meeting') ?? (meetings ?? []).find((m) => m.status === 'calling') ?? null;

/** crew id → conference seat uid. `hasSeat` says whether the layout has that chair. */
export function meetingSeats(meeting: SmMeeting, crewIds: string[], hasSeat: (uid: string) => boolean): Map<string, string> {
  const out = new Map<string, string>();
  if (hasSeat(CONF_HOST_SEAT) && crewIds.includes(meeting.host)) out.set(meeting.host, CONF_HOST_SEAT);
  const rest = crewIds.filter((id) => id !== meeting.host).sort((a, b) => Number(b === meeting.by) - Number(a === meeting.by));
  let n = 1;
  for (const id of rest) {
    while (n <= CONF_SEATS && !hasSeat(`${CONF_SEAT_PREFIX}${n}`)) n++;
    if (n > CONF_SEATS) break;
    out.set(id, `${CONF_SEAT_PREFIX}${n++}`);
  }
  return out;
}

/** What the host says, in order; the video follows the last line. */
export function briefing(m: SmMeeting, nameOf: (id: string | null) => string): string[] {
  return [
    `Thanks for joining! ${m.video ? `${nameOf(m.by)} finished a video for you` : m.pdf ? `${nameOf(m.by)} designed a PDF for you` : 'The team has something to show you'}: ${m.title}.`,
    ...(m.summary ? [m.summary] : []),
    ...m.points,
    m.video ? "Let's watch it." : m.pdf ? "Here it is — ask me about any page." : "That's everything — give me a new task if you want changes.",
  ];
}
