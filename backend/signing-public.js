// backend/signing-public.js · the public signing page (briefing page 10, "Not finished")
//
// "A route that accepts a signing code instead of a staff session, serves only that
// signer's pages and saves only their boxes."
//
// Rules kept from the in-office signer view:
//   · a 6-character code per signer; 5 wrong tries lock it; staff unlock with a fresh code
//   · the signer sees only their own pages and boxes; a note for the office is never shown
//   · every signature is stamped by the server with its own time and address
//   · when everyone has signed, the server builds the signed PDF once (not here: that
//     stays in esign.js, this module just says "all done" and hands over)
//
// Plain node:http handlers, no framework, to match the CRM. `signings` is the store
// interface (in production, StorePg.asServer; in tests, an in-memory map).

const crypto = require('node:crypto');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const MAX_TRIES = 5;

function newCode() {
  const bytes = crypto.randomBytes(6);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

// Codes are stored hashed, like passwords: a database read never reveals a usable code.
function hashCode(code, salt) {
  return crypto.scryptSync(code.toUpperCase(), salt, 32).toString('hex');
}

function makePublicSigning({ signings, now = () => new Date(), rateLimit = makeRateLimit() }) {
  // signings: { bySigningId(id), signerByCode(signingId, code) -> {signer, signing} | null,
  //             bumpTries(signerId), lock(signerId), saveBoxes(signerId, boxes, stamp), allSigned(signingId) }

  async function lookup(signingId, code, ip) {
    if (!rateLimit.allow(ip)) return { status: 429, error: 'Too many tries from this connection. Wait a minute.' };
    if (!/^[A-Z2-9]{6}$/i.test(code || '')) return { status: 400, error: 'A code is 6 letters and numbers.' };
    const signing = await signings.bySigningId(signingId);
    if (!signing || signing.status === 'completed' || signing.status === 'cancelled') return { status: 404, error: 'This signing is no longer open.' };

    // Constant-time check against every signer's hash, so timing says nothing about which signer exists.
    let found = null;
    for (const s of signing.signers) {
      const h = hashCode(code, s.codeSalt);
      if (crypto.timingSafeEqual(Buffer.from(h), Buffer.from(s.codeHash)) && !found) found = s;
    }
    if (!found) {
      // count the wrong try against every still-open signer of this signing
      for (const s of signing.signers) if (!s.signedAt && !s.lockedAt) await signings.bumpTries(s.id);
      for (const s of signing.signers) if (s.tries + 1 >= MAX_TRIES && !s.lockedAt) await signings.lock(s.id);
      return { status: 403, error: 'That code is not right.' };
    }
    if (found.lockedAt) return { status: 423, error: 'This code is locked after 5 wrong tries. Ask the office for a fresh one.' };
    if (found.signedAt) return { status: 409, error: 'You have already signed.' };
    if (!found.turn) return { status: 425, error: 'It is not your turn yet; you will get a text when it is.' };
    return { status: 200, signing, signer: found };
  }

  // GET /sign/:signingId?code=XXXXXX  → only this signer's pages and boxes, no office notes
  async function view(signingId, code, ip) {
    const r = await lookup(signingId, code, ip);
    if (r.status !== 200) return r;
    const mine = r.signing.boxes.filter((b) => b.signerId === r.signer.id);
    return {
      status: 200,
      body: {
        title: r.signing.title,
        signer: { name: r.signer.name, role: r.signer.role },
        pages: r.signing.pages.filter((p) => mine.some((b) => b.page === p.n)).map((p) => ({ n: p.n, imageUrl: p.signedUrl })),
        boxes: mine.map((b) => ({ id: b.id, page: b.page, kind: b.kind, x: b.x, y: b.y, w: b.w, h: b.h, required: b.required })),
        // deliberately absent: other signers, office notes, the document's file path
      },
    };
  }

  // POST /sign/:signingId  { code, boxes: [{ id, value }] }  → saves only this signer's boxes
  async function submit(signingId, code, boxes, ip, userAgent) {
    const r = await lookup(signingId, code, ip);
    if (r.status !== 200) return r;
    const mine = new Map(r.signing.boxes.filter((b) => b.signerId === r.signer.id).map((b) => [b.id, b]));
    const clean = [];
    for (const b of boxes || []) {
      const def = mine.get(b.id);
      if (!def) return { status: 403, error: 'That box is not yours.' };
      if (def.kind === 'signature' || def.kind === 'initials') {
        if (!/^data:image\/png;base64,[A-Za-z0-9+/=]{100,200000}$/.test(b.value || '')) return { status: 400, error: `Please sign the ${def.kind} box.` };
      } else if (def.kind === 'tick') {
        if (b.value !== true) return { status: 400, error: 'Please tick the box.' };
      } else if (typeof b.value !== 'string' || b.value.length > 200) {
        return { status: 400, error: 'Too long.' };
      }
      clean.push({ id: b.id, kind: def.kind, value: b.value });
    }
    for (const def of mine.values()) {
      if (def.required && !clean.some((c) => c.id === def.id)) return { status: 400, error: `The ${def.kind} box on page ${def.page} is needed.` };
    }
    const stamp = { at: now().toISOString(), ip, userAgent: String(userAgent || '').slice(0, 200) };
    await signings.saveBoxes(r.signer.id, clean, stamp);
    const done = await signings.allSigned(r.signing.id);
    return { status: 200, body: { signed: true, everyoneSigned: done } };
  }

  return { view, submit, newCode, hashCode };
}

// A small per-IP limiter: 20 tries a minute. In production this moves to a shared table
// so several API processes agree (briefing page 18).
function makeRateLimit({ perMinute = 20, now = Date.now } = {}) {
  const hits = new Map();
  return {
    allow(ip) {
      const t = now();
      const arr = (hits.get(ip) || []).filter((x) => t - x < 60000);
      arr.push(t);
      hits.set(ip, arr);
      return arr.length <= perMinute;
    },
  };
}

module.exports = { makePublicSigning, makeRateLimit, newCode, hashCode, MAX_TRIES };
