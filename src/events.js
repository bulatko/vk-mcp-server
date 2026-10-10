/**
 * Community events through VK's Bots Long Poll.
 *
 * A community token is refused the reads that tell what is going on in a
 * community — comments (wall.getComments), likes (likes.getList), the wall
 * itself — yet VK pushes the same things as events to a community that
 * listens: a new comment with its text and ID, who liked which post, who
 * joined or left. Checked live on 2026-10-10. The price is time: VK keeps no
 * history, so only what happens while the server listens is ever seen.
 */

/** How long VK holds a poll open when nothing happens; also the longest wait a caller may ask for. */
export const WAIT_SECONDS = 25;
/** Events kept for reading; older ones are dropped and reported as missed. */
export const MAX_BUFFERED = 500;
// "Someone is typing" arrives for every keystroke burst and would bury the rest.
const IGNORED = new Set(['message_typing_state']);

/**
 * What vk_events_listen turns on unless asked for something else: what the
 * community's managers would want to react to. Payments, shop orders and the
 * like are left to whoever asks for them by name.
 */
export const DEFAULT_EVENT_TYPES = [
  'wall_post_new',
  'wall_repost',
  'wall_reply_new',
  'wall_reply_edit',
  'wall_reply_delete',
  'wall_reply_restore',
  'like_add',
  'like_remove',
  'group_join',
  'group_leave',
  'message_new',
  'message_reaction_event',
  'poll_vote_new',
  'photo_comment_new',
  'video_comment_new',
  'board_post_new',
  'user_block',
  'user_unblock',
];

/** A pause that ends early when the signal aborts, so it never holds the process open. */
const pause = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

export class CommunityEvents {
  /**
   * @param call VK API call (method, params) → response, throwing on VK errors
   * @param groupId the community whose events to receive
   */
  constructor(call, groupId) {
    this.call = call;
    this.groupId = groupId;
    this.events = [];
    this.seq = 0;
    this.stopped = null;
    this.since = new Date().toISOString();
    this.waiters = new Set();
    this.controller = new AbortController();
  }

  /** Gets an event server from VK and starts polling it; resolves once polling has begun. */
  async start() {
    this.server = await this.call('groups.getLongPollServer', { group_id: this.groupId });
    this.loop();
  }

  /** Ends polling; reading still returns what was received. */
  stop(reason) {
    if (this.stopped) return;
    this.stopped = reason;
    this.controller.abort();
    this.wake();
  }

  async loop() {
    const { signal } = this.controller;
    let backoff = 1000;
    while (!signal.aborted) {
      let reply;
      // One poll's own abort: on stop, or when VK holds it past WAIT_SECONDS,
      // which means a dead connection. (AbortSignal.any needs Node 20.3.)
      const poll = new AbortController();
      const abortPoll = () => poll.abort();
      signal.addEventListener('abort', abortPoll, { once: true });
      const deadline = setTimeout(abortPoll, (WAIT_SECONDS + 10) * 1000);
      try {
        const { server, key, ts } = this.server;
        const url = `${server}?act=a_check&key=${encodeURIComponent(key)}&ts=${encodeURIComponent(ts)}&wait=${WAIT_SECONDS}`;
        const response = await fetch(url, { signal: poll.signal });
        reply = await response.json();
        backoff = 1000;
      } catch {
        if (signal.aborted) return;
        await pause(backoff, signal);
        backoff = Math.min(backoff * 2, 60000);
        continue;
      } finally {
        clearTimeout(deadline);
        signal.removeEventListener('abort', abortPoll);
      }

      // 1: events were lost and the server says where to resume.
      // 2 and 3: the key or the whole session expired, so ask VK for a new one.
      if (reply.failed === 1) {
        this.server.ts = reply.ts;
        continue;
      }
      if (reply.failed) {
        try {
          this.server = await this.call('groups.getLongPollServer', { group_id: this.groupId });
        } catch (error) {
          // A VK refusal (Long Poll switched off by an admin, the token revoked)
          // will not pass by waiting; a network failure might.
          if (error.vkCode) {
            this.stop(`VK stopped handing out the event server: ${error.message}`);
            return;
          }
          await pause(backoff, signal);
          backoff = Math.min(backoff * 2, 60000);
        }
        continue;
      }

      this.server.ts = reply.ts;
      for (const update of reply.updates ?? []) this.push(update);
    }
  }

  push(update) {
    if (IGNORED.has(update.type)) return;
    this.events.push({ seq: ++this.seq, type: update.type, at: new Date().toISOString(), object: update.object });
    if (this.events.length > MAX_BUFFERED) this.events.shift();
    this.wake();
  }

  wake() {
    for (const waiter of this.waiters) waiter();
  }

  /**
   * Events after the cursor, oldest first. With wait, holds until one arrives
   * or the wait runs out — the way to follow a community without a busy loop.
   */
  async read({ after = 0, types, wait = 0, limit = 50 } = {}) {
    const wanted = types?.length ? new Set(types) : null;
    const matches = (event) => event.seq > after && (!wanted || wanted.has(event.type));

    if (wait > 0 && !this.stopped && !this.events.some(matches)) {
      await new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.waiters.delete(check);
          resolve();
        };
        const check = () => {
          if (this.stopped || this.events.some(matches)) done();
        };
        const timer = setTimeout(done, Math.min(wait, WAIT_SECONDS) * 1000);
        this.waiters.add(check);
      });
    }

    const found = this.events.filter(matches);
    const page = found.slice(0, Math.max(1, Math.min(limit, 200)));
    const more = found.length > page.length;
    // Events after the cursor that the buffer no longer holds.
    const oldest = this.events[0]?.seq ?? this.seq + 1;
    const missed = Math.max(0, oldest - 1 - after);

    return {
      listening: !this.stopped,
      ...(this.stopped && { stopped_because: this.stopped }),
      since: this.since,
      events: page,
      // Pass back as `after`. Past the last event returned when there is more,
      // past everything received so far otherwise.
      cursor: more ? page.at(-1).seq : Math.max(after, this.seq),
      more,
      ...(missed && { missed }),
    };
  }
}
