/**
 * API tests for the reminder router.
 *
 * They drive `createRemindersRouter` over the real storage layer — an in-memory
 * database opened through `createDatabase` and wrapped by `createReminderStore`
 * — through supertest, so no port is bound, no fixture file is written and no
 * network is reached. The router is mounted exactly as `server/src/app.ts`
 * mounts it: the JSON parser, then the router at `/api`, then the error
 * middleware. The clock is a pinned accessor, which is what makes the
 * past-due refusal, the creation instant and the notification claim
 * deterministic: the router and the store read the same instant, so the whole
 * server-side picture of time is fixed by one value.
 */

import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createDatabase } from '../data/database';
import { createReminderStore, type ReminderStore } from '../data/reminderStore';
import { errorHandler } from '../middleware/errorHandler';
import { createRemindersRouter } from './reminders';
import type { Reminder } from '../types';

/** The instant every test's clock reports, and therefore every server-stamped field. */
const NOW_ISO = '2026-06-01T10:00:00.000Z';

/** A due instant comfortably after {@link NOW_ISO}. */
const FUTURE_ISO = '2026-06-01T10:05:00.000Z';

/** A second future instant, so two reminders can differ or share a due time. */
const LATER_ISO = '2026-06-01T11:30:00.000Z';

/** A due instant before {@link NOW_ISO}. */
const PAST_ISO = '2026-05-31T10:00:00.000Z';

/** The pinned clock: the router's `now` and the store's `now` are this one accessor. */
const fixedNow = (): string => NOW_ISO;

/** Mounts the router the way `server/src/app.ts` will, over the given store. */
function buildApp(store: ReminderStore, now: () => string = fixedNow): express.Express {
  const app = express();

  app.use(express.json());
  app.use('/api', createRemindersRouter({ store, now }));
  app.use(errorHandler);

  return app;
}

/** A store over a fresh in-memory database, sharing the pinned clock. */
function buildStore(): ReminderStore {
  return createReminderStore(createDatabase(':memory:'), fixedNow);
}

/**
 * A store whose every operation fails the way a storage failure does. Used for
 * the 500 path: the failure is raised inside a handler and reaches the error
 * middleware, which is the only place a 500 body is produced. Its message
 * carries text and a path, so the assertions below can show that neither
 * reaches the response.
 */
const STORAGE_FAILURE_TEXT = 'storage unavailable: /private/path/reminders.sqlite';

const failingStore: ReminderStore = {
  create: (): Reminder => {
    throw new Error(STORAGE_FAILURE_TEXT);
  },
  list: (): Reminder[] => {
    throw new Error(STORAGE_FAILURE_TEXT);
  },
  get: (): Reminder | undefined => {
    throw new Error(STORAGE_FAILURE_TEXT);
  },
  complete: (): Reminder | undefined => {
    throw new Error(STORAGE_FAILURE_TEXT);
  },
  markNotified: (): Reminder | undefined => {
    throw new Error(STORAGE_FAILURE_TEXT);
  },
  remove: (): boolean => {
    throw new Error(STORAGE_FAILURE_TEXT);
  },
};

const GENERIC_FAILURE_BODY = { error: 'Something went wrong. Please try again.' };

describe('POST /api/reminders', () => {
  it('creates a reminder, returning 201 and exactly the six camelCase fields', async () => {
    const app = buildApp(buildStore());

    const res = await request(app)
      .post('/api/reminders')
      .send({ text: '  Call the dentist  ', dueAt: FUTURE_ISO });

    expect(res.status).toBe(201);
    expect(Object.keys(res.body)).toEqual([
      'id',
      'text',
      'dueAt',
      'completed',
      'notifiedAt',
      'createdAt',
    ]);
    expect(res.body.text).toBe('Call the dentist');
    expect(res.body.dueAt).toBe(FUTURE_ISO);
    expect(res.body.completed).toBe(false);
    expect(res.body.notifiedAt).toBeNull();
    expect(res.body.createdAt).toBe(NOW_ISO);
    expect(res.body.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('stores the due instant byte-for-byte as it was received', async () => {
    const app = buildApp(buildStore());
    const sentDueAt = '2026-06-01T10:05:00.123456Z';

    const created = await request(app)
      .post('/api/reminders')
      .send({ text: 'Keep the instant', dueAt: sentDueAt });

    const listed = await request(app).get('/api/reminders');

    expect(created.body.dueAt).toBe(sentDueAt);
    expect(listed.body[0].dueAt).toBe(sentDueAt);
  });

  it('ignores identity-bearing body fields instead of honouring them', async () => {
    const store = buildStore();
    const app = buildApp(store);

    const res = await request(app).post('/api/reminders').send({
      text: 'Water the plants',
      dueAt: FUTURE_ISO,
      id: 'hacked',
      completed: true,
      notifiedAt: '2020-01-01T00:00:00.000Z',
      createdAt: '2020-01-01T00:00:00.000Z',
    });

    expect(res.status).toBe(201);
    expect(res.body.id).not.toBe('hacked');
    expect(res.body.completed).toBe(false);
    expect(res.body.notifiedAt).toBeNull();
    expect(res.body.createdAt).toBe(NOW_ISO);
    // The stored row carries the server's values too, not merely the response.
    expect(store.get(res.body.id)).toEqual(res.body);
  });

  it.each([
    ['an empty text', { text: '', dueAt: FUTURE_ISO }, 'Enter a reminder text.', 'text'],
    ['a whitespace-only text', { text: '   ', dueAt: FUTURE_ISO }, 'Enter a reminder text.', 'text'],
    ['an absent text', { dueAt: FUTURE_ISO }, 'Enter a reminder text.', 'text'],
    ['a non-string text', { text: 42, dueAt: FUTURE_ISO }, 'Enter a reminder text.', 'text'],
    [
      'a text of 281 characters',
      { text: 'x'.repeat(281), dueAt: FUTURE_ISO },
      'Reminder text must be 280 characters or fewer.',
      'text',
    ],
    ['an absent due time', { text: 'Read the docs' }, 'Enter a valid due date and time.', 'dueAt'],
    [
      'an unparseable due time',
      { text: 'Read the docs', dueAt: 'not-a-date' },
      'Enter a valid due date and time.',
      'dueAt',
    ],
    [
      'a due time equal to the current instant',
      { text: 'Read the docs', dueAt: NOW_ISO },
      'The due time must be in the future.',
      'dueAt',
    ],
    [
      'a due time in the past',
      { text: 'Read the docs', dueAt: PAST_ISO },
      'The due time must be in the future.',
      'dueAt',
    ],
  ])('refuses %s with 400, the rule message and its field, saving nothing', async (
    _label,
    body,
    message,
    field,
  ) => {
    const store = buildStore();
    const app = buildApp(store);

    const res = await request(app).post('/api/reminders').send(body);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: message, field });
    // Nothing was persisted: a refused input reaches no store call.
    expect(store.list()).toEqual([]);
  });

  it('accepts a text of exactly 280 characters', async () => {
    const app = buildApp(buildStore());

    const res = await request(app)
      .post('/api/reminders')
      .send({ text: 'x'.repeat(280), dueAt: FUTURE_ISO });

    expect(res.status).toBe(201);
    expect(res.body.text).toHaveLength(280);
  });

  it('refuses a body that is not valid JSON with 400 and no field key', async () => {
    const app = buildApp(buildStore());

    const res = await request(app)
      .post('/api/reminders')
      .set('content-type', 'application/json')
      .send('{');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Request body must be valid JSON.' });
    expect(Object.keys(res.body)).toEqual(['error']);
  });

  it.each([
    ['a JSON array body', '[]', { error: 'Enter a reminder text.', field: 'text' }],
    ['a JSON null body', 'null', { error: 'Request body must be valid JSON.' }],
    ['a JSON string body', '"a bare string"', { error: 'Request body must be valid JSON.' }],
    ['a JSON number body', '42', { error: 'Request body must be valid JSON.' }],
  ])('refuses %s with 400 rather than a 500', async (_label, rawBody, expectedBody) => {
    const store = buildStore();
    const app = buildApp(store);

    const res = await request(app)
      .post('/api/reminders')
      .set('content-type', 'application/json')
      .send(rawBody);

    // An array is a body the parser accepts and the first input rule refuses; a
    // JSON primitive is not a valid request body at all and is refused by the
    // parser. Neither may surface as a 500, and neither may save a row.
    expect(res.status).toBe(400);
    expect(res.body).toEqual(expectedBody);
    expect(store.list()).toEqual([]);
  });

  it('refuses a request with no body at all with 400, not 500', async () => {
    const store = buildStore();
    const app = buildApp(store);

    const res = await request(app).post('/api/reminders');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Enter a reminder text.', field: 'text' });
    expect(store.list()).toEqual([]);
  });

  it('answers 500 with the generic body and no storage detail when the write fails', async () => {
    const res = await request(buildApp(failingStore))
      .post('/api/reminders')
      .send({ text: 'Anything', dueAt: FUTURE_ISO });

    expect(res.status).toBe(500);
    expect(res.body).toEqual(GENERIC_FAILURE_BODY);
    expect(JSON.stringify(res.body)).not.toContain('storage unavailable');
    expect(JSON.stringify(res.body)).not.toContain('/private/path');
    expect(JSON.stringify(res.body)).not.toContain('at ');
  });
});

describe('GET /api/reminders', () => {
  it('returns 200 and an empty array for an empty table', async () => {
    const res = await request(buildApp(buildStore())).get('/api/reminders');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('orders by dueAt ascending and breaks a shared due time by id', async () => {
    const app = buildApp(buildStore());

    const later = await request(app).post('/api/reminders').send({ text: 'later', dueAt: LATER_ISO });
    const tieOne = await request(app)
      .post('/api/reminders')
      .send({ text: 'tie one', dueAt: FUTURE_ISO });
    const tieTwo = await request(app)
      .post('/api/reminders')
      .send({ text: 'tie two', dueAt: FUTURE_ISO });

    const res = await request(app).get('/api/reminders');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.body.map((reminder: Reminder) => reminder.dueAt)).toEqual([
      FUTURE_ISO,
      FUTURE_ISO,
      LATER_ISO,
    ]);
    expect([res.body[0].id, res.body[1].id]).toEqual(
      [tieOne.body.id, tieTwo.body.id].sort(),
    );
    expect(res.body[2].id).toBe(later.body.id);
  });

  it('reflects a persisted change on the next read', async () => {
    const app = buildApp(buildStore());

    const created = await request(app)
      .post('/api/reminders')
      .send({ text: 'Read me back', dueAt: FUTURE_ISO });
    await request(app).patch(`/api/reminders/${created.body.id}/complete`);

    const res = await request(app).get('/api/reminders');

    expect(res.body[0].completed).toBe(true);
  });

  it('answers 500 with the generic body when the read fails', async () => {
    const res = await request(buildApp(failingStore)).get('/api/reminders');

    expect(res.status).toBe(500);
    expect(res.body).toEqual(GENERIC_FAILURE_BODY);
    expect(JSON.stringify(res.body)).not.toContain('storage unavailable');
  });
});

describe('PATCH /api/reminders/:id/complete', () => {
  it('marks a reminder complete and returns the persisted reminder', async () => {
    const store = buildStore();
    const app = buildApp(store);
    const created = await request(app)
      .post('/api/reminders')
      .send({ text: 'Ship the build', dueAt: FUTURE_ISO });

    const res = await request(app).patch(`/api/reminders/${created.body.id}/complete`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.body.id);
    expect(res.body.completed).toBe(true);
    expect(res.body.text).toBe('Ship the build');
    expect(store.get(created.body.id)?.completed).toBe(true);
  });

  it('returns an already completed reminder unchanged rather than reporting it missing', async () => {
    const app = buildApp(buildStore());
    const created = await request(app)
      .post('/api/reminders')
      .send({ text: 'Ship the build', dueAt: FUTURE_ISO });

    const first = await request(app).patch(`/api/reminders/${created.body.id}/complete`);
    const second = await request(app).patch(`/api/reminders/${created.body.id}/complete`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  it('returns 404 with the not-found body for an unknown id', async () => {
    const res = await request(buildApp(buildStore())).patch('/api/reminders/no-such-id/complete');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Reminder not found.' });
  });

  it('answers 500 with the generic body when the write fails', async () => {
    const res = await request(buildApp(failingStore)).patch('/api/reminders/any-id/complete');

    expect(res.status).toBe(500);
    expect(res.body).toEqual(GENERIC_FAILURE_BODY);
    expect(JSON.stringify(res.body)).not.toContain('storage unavailable');
  });
});

describe('PATCH /api/reminders/:id/notified', () => {
  it('records the claim and returns the reminder carrying it', async () => {
    const app = buildApp(buildStore());
    const created = await request(app)
      .post('/api/reminders')
      .send({ text: 'Ring the bell', dueAt: FUTURE_ISO });

    const res = await request(app).patch(`/api/reminders/${created.body.id}/notified`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.body.id);
    expect(res.body.notifiedAt).toBe(NOW_ISO);
  });

  it('answers 200 with the first claim intact when the claim is repeated', async () => {
    const store = buildStore();
    const app = buildApp(store);
    const created = await request(app)
      .post('/api/reminders')
      .send({ text: 'Ring the bell', dueAt: FUTURE_ISO });

    const first = await request(app).patch(`/api/reminders/${created.body.id}/notified`);
    const repeated = await request(app)
      .patch(`/api/reminders/${created.body.id}/notified`)
      .send({ notifiedAt: '2000-01-01T00:00:00.000Z' });

    // The claim is durable and is won once: a repeat is a known reminder in the
    // state the caller asked for, and the recorded instant never moves.
    expect(repeated.status).toBe(200);
    expect(repeated.body.notifiedAt).toBe(first.body.notifiedAt);
    expect(store.get(created.body.id)?.notifiedAt).toBe(NOW_ISO);
  });

  it('returns 404 for an unknown id', async () => {
    const res = await request(buildApp(buildStore())).patch('/api/reminders/no-such-id/notified');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Reminder not found.' });
  });

  it('answers 500 with the generic body when the claim fails', async () => {
    const res = await request(buildApp(failingStore)).patch('/api/reminders/any-id/notified');

    expect(res.status).toBe(500);
    expect(res.body).toEqual(GENERIC_FAILURE_BODY);
    expect(JSON.stringify(res.body)).not.toContain('storage unavailable');
  });
});

describe('DELETE /api/reminders/:id', () => {
  it('removes a reminder with 204 and no body at all', async () => {
    const store = buildStore();
    const app = buildApp(store);
    const created = await request(app)
      .post('/api/reminders')
      .send({ text: 'Throw this away', dueAt: FUTURE_ISO });

    const res = await request(app).delete(`/api/reminders/${created.body.id}`);

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(store.get(created.body.id)).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it('removes a completed reminder too', async () => {
    const store = buildStore();
    const app = buildApp(store);
    const created = await request(app)
      .post('/api/reminders')
      .send({ text: 'Finished thing', dueAt: FUTURE_ISO });
    await request(app).patch(`/api/reminders/${created.body.id}/complete`);

    const res = await request(app).delete(`/api/reminders/${created.body.id}`);

    expect(res.status).toBe(204);
    expect(store.get(created.body.id)).toBeUndefined();
  });

  it('returns 404 on a repeated delete and for an unknown id', async () => {
    const app = buildApp(buildStore());
    const created = await request(app)
      .post('/api/reminders')
      .send({ text: 'Already gone', dueAt: FUTURE_ISO });
    await request(app).delete(`/api/reminders/${created.body.id}`);

    const repeated = await request(app).delete(`/api/reminders/${created.body.id}`);
    const unknown = await request(app).delete('/api/reminders/no-such-id');

    expect(repeated.status).toBe(404);
    expect(repeated.body).toEqual({ error: 'Reminder not found.' });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({ error: 'Reminder not found.' });
  });

  it('answers 500 with the generic body when the removal fails', async () => {
    const res = await request(buildApp(failingStore)).delete('/api/reminders/any-id');

    expect(res.status).toBe(500);
    expect(res.body).toEqual(GENERIC_FAILURE_BODY);
    expect(JSON.stringify(res.body)).not.toContain('storage unavailable');
  });
});
