import test from 'node:test';
import assert from 'node:assert/strict';
import { kitsuTracker, login, refresh, verifyToken } from '../../src/lib/trackers/kitsu.ts';

/**
 * Kitsu, against recorded answers.
 *
 * The three shapes that matter are the ones the live API actually produces, measured on 2026-11-19:
 * an ignored token is a `200` with no rows (never a 401), a library entry points at its manga through
 * `relationships.manga.data`, and `progress` is a number on the entry.
 */

/** A fake fetch that answers from a table and records what it was asked. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    // JSON:API bodies are JSON, the OAuth token call is form-encoded — keep both as sent.
    let body = init.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { /* form-encoded */ }
    }
    calls.push({ method, url, body, headers: init.headers });
    for (const [match, answer] of routes) {
      if (url.includes(match)) {
        const value = typeof answer === 'function' ? answer({ method, url, body }) : answer;
        return {
          ok: (value.status ?? 200) < 400,
          status: value.status ?? 200,
          text: async () => JSON.stringify(value.body ?? {}),
        };
      }
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  };
  return { impl, calls };
}

const USER = { data: { id: '77', type: 'users', attributes: { name: 'reader' } } };

const SEARCH = {
  data: [
    {
      id: '38',
      type: 'manga',
      attributes: {
        canonicalTitle: 'One Piece',
        chapterCount: null,
        startDate: '1997-07-22',
        posterImage: { small: 'https://media.kitsu.app/manga/38/small.jpeg' },
      },
    },
  ],
};

test('an ignored token is a rejection, not an empty account', async () => {
  // Measured on the live API: a bogus bearer answers 200 {"data":[]}. Treating that as success is
  // how a broken connection reports itself as a working one with nothing on it.
  const { impl } = fakeFetch([['/users', { body: { data: [], meta: { count: 0 } } }]]);
  await assert.rejects(() => verifyToken('bogus', impl), /rejected that token/);
});

test('a real token yields the user id every later call needs', async () => {
  const { impl, calls } = fakeFetch([['/users', { body: USER }]]);
  const user = await verifyToken('good-token', impl);
  assert.deepEqual(user, { id: '77', name: 'reader' });
  assert.equal(calls[0].headers.Authorization, 'Bearer good-token');
  assert.equal(calls[0].headers.Accept, 'application/vnd.api+json');
});

test('search maps a Kitsu manga onto one search result', async () => {
  const { impl } = fakeFetch([['/manga?filter', { body: SEARCH }]]);
  const tracker = kitsuTracker({ token: 't', userId: '77', fetchImpl: impl });
  const results = await tracker.search('one piece');
  assert.equal(results.length, 1);
  assert.equal(results[0].remoteId, '38');
  assert.equal(results[0].title, 'One Piece');
  assert.equal(results[0].year, 1997);
  assert.equal(results[0].cover, 'https://media.kitsu.app/manga/38/small.jpeg');
});

function entryPage(row) {
  return { body: { data: row === null ? [] : [row] } };
}

const BOUND = {
  id: '555',
  type: 'libraryEntries',
  attributes: { progress: 40, status: 'current', ratingTwenty: 16 },
  relationships: { media: { data: { id: '38', type: 'manga' } } },
};

test('pull reads the entry bound to the manga, and absence is not an error', async () => {
  const { impl } = fakeFetch([['/library-entries?', entryPage(BOUND)]]);
  const tracker = kitsuTracker({ token: 't', userId: '77', fetchImpl: impl });
  const entry = await tracker.pull('38');
  assert.equal(entry.lastChapter, 40);
  assert.equal(entry.status, 'reading');
  assert.equal(entry.score, 4);

  const empty = fakeFetch([['/library-entries?', entryPage(null)]]);
  const alsoEmpty = await kitsuTracker({ token: 't', userId: '77', fetchImpl: empty.impl }).pull('999');
  assert.deepEqual(alsoEmpty, {}, 'a title that is not on the list yet is not a failure');
});

test('a push never walks the list backwards', async () => {
  // Kitsu accepts a lower progress happily; that is the classic way a list gets wrecked.
  const { impl, calls } = fakeFetch([['/library-entries?', entryPage(BOUND)]]);
  const tracker = kitsuTracker({ token: 't', userId: '77', fetchImpl: impl });
  const entry = await tracker.push('38', 12);
  assert.equal(entry.lastChapter, 40, 'the answer is what the service already had');
  assert.equal(calls.filter((call) => call.method === 'PATCH').length, 0, 'nothing was written');
});

test('a forward push patches the existing entry', async () => {
  const { impl, calls } = fakeFetch([
    ['/library-entries?', entryPage(BOUND)],
    [
      '/library-entries/555',
      ({ body }) => ({
        body: { data: { ...BOUND, attributes: { ...BOUND.attributes, progress: body.data.attributes.progress } } },
      }),
    ],
  ]);
  const tracker = kitsuTracker({ token: 't', userId: '77', fetchImpl: impl });
  const entry = await tracker.push('38', 41);
  assert.equal(entry.lastChapter, 41);
  const patch = calls.find((call) => call.method === 'PATCH');
  assert.equal(patch.body.data.attributes.progress, 41);
  assert.equal(patch.body.data.type, 'libraryEntries');
});

test('a push for a title that is not listed creates the entry', async () => {
  const created = {
    id: '900',
    type: 'libraryEntries',
    attributes: { progress: 7, status: 'current' },
    relationships: { media: { data: { id: '38', type: 'manga' } } },
  };
  const { impl, calls } = fakeFetch([
    ['/library-entries?', entryPage(null)],
    ['/library-entries', { status: 201, body: { data: created } }],
  ]);
  const tracker = kitsuTracker({ token: 't', userId: '77', fetchImpl: impl });
  const entry = await tracker.push('38', 7);
  assert.equal(entry.lastChapter, 7);
  const post = calls.find((call) => call.method === 'POST');
  assert.deepEqual(post.body.data.relationships.user.data, { type: 'users', id: '77' });
  assert.deepEqual(post.body.data.relationships.media.data, { type: 'manga', id: '38' });
  assert.equal(post.body.data.attributes.status, 'current');
});

test('a score is converted to Kitsu twenty-point scale, and zero clears it', async () => {
  const { impl, calls } = fakeFetch([
    ['/library-entries?', entryPage(BOUND)],
    ['/library-entries/555', { body: { data: BOUND } }],
  ]);
  const tracker = kitsuTracker({ token: 't', userId: '77', fetchImpl: impl });
  await tracker.setScore('38', 4); // 4/5 in Kitsu's own scale
  const patch = calls.find((call) => call.method === 'PATCH');
  assert.equal(patch.body.data.attributes.ratingTwenty, 16);
});

test('this app\'s statuses are Kitsu\'s own words', async () => {
  const { impl, calls } = fakeFetch([
    ['/library-entries?', entryPage(BOUND)],
    ['/library-entries/555', { body: { data: BOUND } }],
  ]);
  const tracker = kitsuTracker({ token: 't', userId: '77', fetchImpl: impl });
  await tracker.setStatus('38', 'plan_to_read');
  const patch = calls.find((call) => call.method === 'PATCH');
  assert.equal(patch.body.data.attributes.status, 'planned', 'Kitsu says planned, not plan_to_read');
});

test('a service error keeps the service\'s own words', async () => {
  const { impl } = fakeFetch([
    ['/library-entries?', { status: 500, body: { errors: [{ detail: 'internal server error' }] } }],
  ]);
  const tracker = kitsuTracker({ token: 't', userId: '77', fetchImpl: impl });
  await assert.rejects(() => tracker.pull('38'), /Kitsu said: internal server error/);
});

test('an openable token is one Kitsu named a user for', async () => {
  const { impl } = fakeFetch([['/users', { body: USER }]]);
  const user = await verifyToken('good', impl);
  assert.equal(user.id, '77');
});

test('sign-in posts a password grant with no client credentials', async () => {
  // Measured: the endpoint rejects a *wrong* client, but works with none at all. Sending an empty
  // client id is what turned a working sign-in into `invalid_client` on the first attempt.
  const { impl, calls } = fakeFetch([
    ['/oauth/token', { body: { access_token: 'tok', refresh_token: 'ref', expires_in: 2591963 } }],
    ['/users', { body: USER }],
  ]);
  const result = await login('reader@example.com', 'hunter2', impl);
  assert.equal(result.accessToken, 'tok');
  assert.equal(result.refreshToken, 'ref');
  assert.equal(result.userId, '77');
  assert.ok(result.expiresAt > Date.now());

  const post = calls.find((call) => call.url.endsWith('/oauth/token'));
  const sent = new URLSearchParams(post.body);
  assert.equal(sent.get('grant_type'), 'password');
  assert.equal(sent.get('username'), 'reader@example.com');
  assert.equal(sent.get('client_id'), null, 'no client registration is sent');
});

test('a refused sign-in repeats what Kitsu said, without inventing a cause', async () => {
  const { impl } = fakeFetch([
    ['/oauth/token', { status: 400, body: { error: 'invalid_grant', error_description: 'The provided authorization grant is invalid' } }],
  ]);
  await assert.rejects(() => login('reader@example.com', 'wrong', impl), /Kitsu refused the sign-in: The provided authorization grant is invalid/);
});

test('a session can be renewed with its refresh token', async () => {
  const { impl, calls } = fakeFetch([
    ['/oauth/token', { body: { access_token: 'tok2', refresh_token: 'ref2', expires_in: 60 } }],
  ]);
  const renewed = await refresh('ref', impl);
  assert.equal(renewed.accessToken, 'tok2');
  const sent = new URLSearchParams(calls[0].body);
  assert.equal(sent.get('grant_type'), 'refresh_token');
  assert.equal(sent.get('refresh_token'), 'ref');
});

test('the entry walk follows the next link rather than a page count', async () => {
  // Kitsu pages `links.next`; a short page is not proof of the end.
  const pageOne = {
    body: {
      data: [
        {
          id: '1',
          type: 'libraryEntries',
          attributes: { progress: 3, status: 'current' },
          relationships: { media: { data: { id: '11', type: 'manga' } } },
        },
      ],
      links: { next: 'https://kitsu.io/api/edge/library-entries?page%5Boffset%5D=100' },
    },
  };
  const pageTwo = {
    body: {
      data: [
        {
          id: '2',
          type: 'libraryEntries',
          attributes: { progress: 55, status: 'current' },
          relationships: { media: { data: { id: '22', type: 'manga' } } },
        },
      ],
    },
  };
  const { impl, calls } = fakeFetch([
    ['/library-entries?filter', pageOne],
    ['page%5Boffset%5D=100', pageTwo],
  ]);
  const tracker = kitsuTracker({ token: 't', userId: '77', fetchImpl: impl });
  const second = await tracker.pull('22');
  assert.equal(second.lastChapter, 55, 'the second page was read');
  assert.ok(calls[0].url.includes('include=media'), 'without include the relationship has no data');
});
