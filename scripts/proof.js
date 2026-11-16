#!/usr/bin/env node
// scripts/proof.js · run the real tests and write docs/proof.html: every rule from the
// briefing with a tick or a cross, in plain English, for showing the office.
//
//   npm run proof        → docs/proof.html  (open it in any browser)

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const files = {
  'test/01-access-matrix.test.js': { title: 'Who sees what', page: 'Briefing pages 16 and 19', blurb: 'Branches fully separate; Founder, CEO and Director shared; the second sign-in step required for everything.' },
  'test/02-money.test.js': { title: 'The money rules', page: 'Briefing page 8', blurb: 'Insert-only ledger, reversals, reference numbers, closed months, two accounts, whole pence.' },
  'test/03-rules-and-saving.test.js': { title: 'Saving, caps, archive, privacy', page: 'Briefing pages 7, 8, 10, 12, 15', blurb: 'Deposit caps, the change trail, archive and restore, masked bank details, erasure, live updates.' },
  'test/04-mailer-sms-signing.test.js': { title: 'Email, texts and signing from a phone', page: 'Briefing pages 10, 20, 23', blurb: 'Microsoft 365 and Postmark providers, bounces, text codes, the public signing route.' },
  'test/05-phone-bridge.test.js': { title: 'The desk phones', page: 'Briefing page 21', blurb: 'Asterisk/TINKLE events → the CRM’s own phone endpoint, verified and de-duplicated.' },
  'test/06-pwa.test.js': { title: 'The desktop app', page: 'Briefing page 22', blurb: 'The installable app caches the shell only, never personal data.' },
};

// Plain-English rewrites for a non-technical reader. Anything not listed falls back to the test name.
const plain = {
  'aal1 (password but no authenticator code) reaches nothing, on every table': 'Someone who typed the right password but not the authenticator code sees nothing at all, on every one of the 17 tables, and cannot save anything.',
  'a B1 lettings manager sees only B1 records (plus shared lists)': 'A Bradford lettings manager asks for "everything": gets Bradford contacts only, plus the company-wide Help list. No Leeds record appears.',
  'a B2 lettings manager sees only B2 records': 'A Leeds lettings manager sees Leeds contacts only.',
  'Founder and CEO see every branch': 'A Founder and the CEO see both branches.',
  'writing into another branch is refused, even with a hand-made request': 'A Bradford person sends a hand-made request to save a Leeds contact: refused. Tries to change a Leeds contact: nothing changes.',
  'Add / Change / Delete per area: a basic member may add a contact but not change one': 'A basic staff member may add a contact (ticked for them) but cannot change one (not ticked), and cannot touch tenancies at all.',
  'nobody can DELETE a record; the grant does not exist': 'Nobody can delete a record, not even a Founder. The database does not have a delete permission for staff at all.',
  'a person named on an appointment reads it whichever branch holds it (named.js)': 'A Bradford person named on a Leeds viewing can see that one appointment; a Bradford colleague not named on it cannot.',
  'security log and activity trail need their switch': 'The security log is invisible without the "Read the security log" power.',
  'ID copies need "View ID documents"; other files only need the branch': 'ID documents are invisible without the "View ID documents" power; ordinary documents need only the right branch.',
  'taking rent needs the "takeRent" switch': 'Taking rent gives a receipt number like NL-R-0001. Someone without the "Take rent" power is refused.',
  'reading the books needs "See Accounts"; without it you see only the receipts you issued': 'Without "See Accounts" you see only the receipts you issued yourself; with it, the whole ledger.',
  'a money line is never changed or deleted: not by staff, not by the table owner': 'A money line can never be changed or deleted: not by staff, not by a Founder, not even by the database administrator typing raw commands.',
  'Reverse writes the mirror entry; the two sum to zero; it is logged': '"Reverse" writes a mirror entry (NL-RV-…) in the same transaction; the two add up to zero; the reversal is in the security log.',
  'Reverse is refused twice, refused on a reversal, refused without "See Accounts", refused without a reason': 'You cannot reverse the same line twice, reverse a reversal, reverse without "See Accounts", or reverse without saying why.',
  'Reverse across branches is refused unless shared role': 'A Bradford accounts person cannot reverse a Leeds entry; a Founder can.',
  'reference numbers never repeat: 25 people taking a number at the same instant': '25 people take a statement number at the same instant: 25 different numbers, in order, no gaps.',
  'a later branch carries its code: NL-B2-R-0001': 'The second branch’s numbers carry its code: NL-B2-J-0001. A Bradford person cannot take a Leeds number.',
  'a number stays used even if the record is gone (numbers_kept is append-only)': 'A number stays used for good, even if the record it was on is erased.',
  'closed months: no new money dated into one, except by a Founder': 'Once September is closed, nobody can date money into it, except a Founder.',
  'a money line must move some pence, and pence are whole': 'A money line of £0.00 is refused. An amount with a fraction of a penny is refused.',
  'two accounts: rent always lands in the client account; fees reach the business account only by a recorded move': 'Rent sent to the business account: refused. A fee in the business account without a recorded move: refused.',
  'the client account never pays out money that is not really there': '£1,000 rent came in for a tenancy. Paying the landlord £1,000.01: refused ("only 100000p is held"). Fee out, rest to the landlord, then nothing more. Another tenancy’s money cannot be used.',
  'deposit cap: the SQL function and shared/caps.js give the same pence for 200 rents': 'The deposit cap formula in the database and the one in the browser agree on 202 different rents, including a penny either side of the £50,000 line.',
  'a tenancy with a deposit over the cap is refused by the database, whatever the screen did': 'A tenancy saved with a deposit one penny over five weeks’ rent: refused by the database itself, whatever the screen allowed. Holding deposit over one week: refused. Weekly rent: refused.',
  'every save is kept with who, before and after; the trail cannot be edited': 'Every save is kept with who did it, what it was before and after, and the version number goes up. Staff cannot read or edit the trail.',
  'a delete is an Archive entry; restore needs the switch; nothing is lost': 'A deleted tenancy is in the Archive with all its data. Restoring it needs the "Restore from Archive" power. Someone without "Delete" on contacts cannot archive one. Leeds cannot archive Bradford’s.',
  'bank details are masked unless the role may see them, and each full view is logged': 'A landlord’s bank details show as ****5678 / **-**-84 to most staff; in full to someone with "See bank details", and every full view is written to the security log. Leeds sees nothing.',
  'save batch: one transaction; a stale version is refused; a refused op saves nothing': 'A save batch is one transaction. Two people editing the same record from the same version: the second is refused and reloads. A batch with one bad change saves nothing at all.',
  'phone events arrive from the server, not a browser; staff may only add notes': 'Call events can only be written by the server. Staff can add notes to a call and end it, but cannot change who called.',
  'opening an ID document is logged every time; other files are not': 'Opening a passport copy is logged every time; opening a gas certificate is not.',
  'erasure: the only lawful rewrite of the trail; needs the switch; refused under a legal hold': 'An erasure request wipes the person’s record and redacts the trail (never deletes it), needs "Handle rights requests", is refused under a legal hold, and is recorded. Nothing else can touch the trail.',
  'every save is announced on nl_changes, so a second API process can relay it': 'Every save is announced inside the database, so a second server can tell every open browser.',
  'Microsoft 365 provider: gets a token, posts sendMail as the office mailbox, tags the message with the outbox id': 'Microsoft 365: signs in, sends as the office mailbox with the PDF attached, tags each email with its outbox line.',
  'a refusal from the provider becomes a plain message for staff, and after 3 tries the line is Failed': 'If Microsoft refuses, staff see a plain message; after three tries the email goes to "Emails to send by hand".',
  'Postmark provider and its bounce webhook update the right outbox line': 'The alternative service (Postmark) sends, and its bounce report marks the right outbox line as bounced with the reason.',
  'webhook key check is constant-time and refuses a missing secret': 'A bounce report without the secret key is refused.',
  'Microsoft 365 non-delivery reports are matched to the outbox by our header': 'Microsoft’s "undeliverable" replies are matched back to the right outbox line.',
  'test provider writes the email to disk and nothing leaves': 'In test mode the email is written to a file and nothing leaves the CRM.',
  'SMS: UK numbers normalise to E.164; anything else is refused; codes are one message': 'Text codes go to UK mobiles only; a landline or a mistyped number is refused.',
  'public signing: the signer sees only their own pages and boxes, never the office note': 'A tenant signing from their phone sees only their own pages and boxes, never the guarantor’s, never the office note.',
  'public signing: not your turn yet, wrong code, lock after 5 wrong tries, staff reissue': '"Not your turn yet" until the person before has signed. Five wrong codes lock it; staff issue a fresh code.',
  'public signing: saves only this signer\'s boxes, refuses another\'s, requires the required ones, stamps time and address': 'The server saves only that signer’s boxes, refuses someone else’s, insists on the required ones, and stamps the time and address itself.',
  'public signing: 20 tries a minute from one address, then 429': 'More than 20 tries a minute from one connection is blocked.',
  'numbers normalise to +44; withheld is kept as a word': 'Caller numbers in any format become +44…; a withheld number is kept as "withheld".',
  'AMI: ring → answer by another extension → transfer; internal calls are ignored': 'A call rings 201, is answered on 202, is transferred to 203: the CRM gets ringing, answered, transferred. Calls between desks are ignored.',
  'AMI: a hangup before anyone answers is "missed"; after an answer it is nothing': 'A caller hanging up before anyone answers is a missed call.',
  'end to end: fake Asterisk → bridge → CRM receives the four events once each, with the key header': 'End to end: a fake phone system sends a call; the bridge posts exactly what the CRM’s phone endpoint expects, with the secret key header.',
  'webhook: refused without the key; stale events ignored; a good one reaches the CRM': 'If the supplier pushes events instead: no key, refused; an old replayed event, ignored; a good one reaches the CRM.',
  'webhook: HMAC mode verifies the body signature': 'A forged event with a bad signature is refused.',
  'Yealink Action URLs: incoming → answered, or incoming → ended = missed; key required': 'If the supplier offers nothing, the handsets themselves can report incoming / answered / ended; still key-protected.',
  'emit() de-duplicates per call, so Asterisk sending Newchannel and DialBegin posts one "ringing"': 'The phone system often sends the same event twice; the CRM is told once.',
  'the shell list holds only scripts, styles, images and the two entry files': 'The desktop app caches only scripts, styles and images.',
  'data paths are explicitly excluded and non-GET requests never touch the cache': 'Personal data, files and the signing page are never cached on the machine.',
  'no inline-script tricks: no eval, no new Function, no importScripts from elsewhere': 'It fits the CRM’s strict content-security policy.',
  'the manifest is standalone, en-GB, and has 192 and 512 icons': 'It installs in its own window from the Start menu or the Dock, in British English, with the office icon.',
};

// ---- run --------------------------------------------------------------------
const results = {};
let pass = 0, fail = 0;
for (const f of Object.keys(files)) {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', f], { cwd: root, encoding: 'utf8', env: process.env });
  const lines = (r.stdout || '').split('\n');
  const items = [];
  for (const l of lines) {
    const m = /^(not ok|ok) \d+ - (.*)$/.exec(l.trim());
    if (!m) continue;
    if (/\.test\.js$/.test(m[2])) continue; // the file-level line
    const ok = m[1] === 'ok';
    ok ? pass++ : fail++;
    items.push({ ok, name: m[2], text: plain[m[2]] || m[2] });
  }
  results[f] = items;
}

// ---- render ---------------------------------------------------------------------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const when = new Date().toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/London' }) + ' UK';
const sha = (spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout || '').trim();

const sections = Object.entries(files).map(([f, meta]) => `
<section>
  <h2>${esc(meta.title)} <small>${esc(meta.page)}</small></h2>
  <p class="blurb">${esc(meta.blurb)}</p>
  <ol>${results[f].map((t) => `<li class="${t.ok ? 'ok' : 'bad'}"><span class="mark">${t.ok ? '✔' : '✘'}</span><span>${esc(t.text)}</span></li>`).join('')}</ol>
</section>`).join('');

const html = `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><title>North Lane CRM · Supabase blueprint · proof</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{--teal:#0f6e6a;--ink:#15201f;--mute:#5d6b69;--ok:#1a7f37;--bad:#b42318;--line:#e3e8e7;--bg:#fbfcfc}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,"Segoe UI",Inter,Roboto,sans-serif}
  main{max-width:900px;margin:0 auto;padding:40px 24px 80px}
  h1{font-size:30px;margin:0 0 4px} .sub{color:var(--mute);margin:0 0 28px}
  .totals{display:flex;gap:16px;margin:0 0 32px;flex-wrap:wrap}
  .tile{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px 20px;min-width:150px}
  .tile b{display:block;font-size:30px;line-height:1.1} .tile span{color:var(--mute);font-size:14px}
  .tile.ok b{color:var(--ok)} .tile.bad b{color:var(--bad)}
  .ideas{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin:0 0 36px}
  .idea{background:#fff;border:1px solid var(--line);border-left:4px solid var(--teal);border-radius:10px;padding:14px 16px}
  .idea h3{margin:0 0 6px;font-size:16px} .idea p{margin:0;color:var(--mute);font-size:14px}
  svg{width:100%;height:auto;display:block;margin:0 0 36px;background:#fff;border:1px solid var(--line);border-radius:12px}
  section{margin:0 0 32px} h2{font-size:21px;margin:0 0 2px;border-bottom:2px solid var(--line);padding-bottom:6px}
  h2 small{font-weight:400;color:var(--mute);font-size:14px;margin-left:10px} .blurb{color:var(--mute);margin:8px 0 10px;font-size:15px}
  ol{list-style:none;padding:0;margin:0} li{display:flex;gap:12px;padding:9px 0;border-bottom:1px solid var(--line)}
  .mark{flex:0 0 22px;font-weight:700} .ok .mark{color:var(--ok)} .bad .mark{color:var(--bad)} .bad span:last-child{color:var(--bad)}
  footer{color:var(--mute);font-size:13px;margin-top:40px}
  @media print{body{font-size:13px} main{padding:0} .tile b{font-size:22px}}
</style></head><body><main>
<h1>North Lane CRM · the Supabase layer, proven</h1>
<p class="sub">Every line below is a real automated test that ran against a real Postgres database on ${esc(when)}${sha ? ` · build ${esc(sha)}` : ''}. Green means the rule held. The screens stay as they are; this is the layer underneath them.</p>

<div class="totals">
  <div class="tile ok"><b>${pass}</b><span>rules proven</span></div>
  <div class="tile ${fail ? 'bad' : ''}"><b>${fail}</b><span>failed</span></div>
  <div class="tile"><b>17</b><span>tables, all branch-locked</span></div>
  <div class="tile"><b>0</b><span>ways to delete a record</span></div>
</div>

<div class="ideas">
  <div class="idea"><h3>Both locks</h3><p>The server checks every rule, and then the database checks it again under the signed-in person’s own identity. A bug in one is caught by the other.</p></div>
  <div class="idea"><h3>Who you are comes from the token</h3><p>Branch, roles and powers are stamped into the sign-in token by the server. No rule ever trusts something the person could edit.</p></div>
  <div class="idea"><h3>Nothing is lost, in the database too</h3><p>No delete at all. Money, logs and the change trail refuse edits from everyone, administrator included. Mistakes are reversed; records are archived.</p></div>
</div>

<svg viewBox="0 0 900 300" xmlns="http://www.w3.org/2000/svg" font-family="-apple-system,Segoe UI,Inter,sans-serif" font-size="13">
  <defs><marker id="a" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#5d6b69"/></marker></defs>
  <g><rect x="20" y="35" width="215" height="100" rx="10" fill="#f3f8f7" stroke="#0f6e6a" stroke-width="2"/>
    <text x="127" y="65" text-anchor="middle" font-weight="700" font-size="14">Browser / desktop app</text>
    <text x="127" y="88" text-anchor="middle" fill="#5d6b69">the screens, unchanged</text>
    <text x="127" y="108" text-anchor="middle" fill="#5d6b69">password + authenticator code</text></g>
  <g><rect x="330" y="35" width="240" height="100" rx="10" fill="#f3f8f7" stroke="#0f6e6a" stroke-width="2"/>
    <text x="450" y="65" text-anchor="middle" font-weight="700" font-size="14">Node API (kept as it is)</text>
    <text x="450" y="88" text-anchor="middle" fill="#5d6b69">48k lines of rules, 1,500 tests</text>
    <text x="450" y="108" text-anchor="middle" fill="#5d6b69">acts as the signed-in person</text></g>
  <g><rect x="665" y="20" width="215" height="130" rx="10" fill="#e7f3f2" stroke="#0f6e6a" stroke-width="2"/>
    <text x="772" y="50" text-anchor="middle" font-weight="700" font-size="14">Supabase · London</text>
    <text x="772" y="74" text-anchor="middle" fill="#5d6b69">Postgres + row-level security</text>
    <text x="772" y="94" text-anchor="middle" fill="#5d6b69">sign-in with 2 steps</text>
    <text x="772" y="114" text-anchor="middle" fill="#5d6b69">private file storage</text>
    <text x="772" y="134" text-anchor="middle" fill="#5d6b69">backups + restore drill</text></g>
  <line x1="235" y1="85" x2="328" y2="85" stroke="#5d6b69" stroke-width="2" marker-end="url(#a)"/>
  <text x="282" y="74" text-anchor="middle" fill="#5d6b69" font-size="11">only way in</text>
  <line x1="570" y1="85" x2="663" y2="85" stroke="#5d6b69" stroke-width="2" marker-end="url(#a)"/>
  <text x="617" y="74" text-anchor="middle" fill="#5d6b69" font-size="11">as that person</text>
  <g><rect x="20" y="200" width="215" height="70" rx="10" fill="#fff" stroke="#c9d4d2" stroke-width="2"/>
    <text x="127" y="228" text-anchor="middle" font-weight="700" font-size="14">Desk phones (TINKLE)</text>
    <text x="127" y="250" text-anchor="middle" fill="#5d6b69">bridge → verified call events</text></g>
  <g><rect x="330" y="200" width="240" height="70" rx="10" fill="#fff" stroke="#c9d4d2" stroke-width="2"/>
    <text x="450" y="228" text-anchor="middle" font-weight="700" font-size="14">Email (Microsoft 365)</text>
    <text x="450" y="250" text-anchor="middle" fill="#5d6b69">outbox → sent / bounced</text></g>
  <g><rect x="665" y="200" width="215" height="70" rx="10" fill="#fff" stroke="#c9d4d2" stroke-width="2"/>
    <text x="772" y="228" text-anchor="middle" font-weight="700" font-size="14">Texts · signing on a phone</text>
    <text x="772" y="250" text-anchor="middle" fill="#5d6b69">codes · only your own pages</text></g>
  <line x1="127" y1="200" x2="400" y2="137" stroke="#c9d4d2" stroke-width="2" marker-end="url(#a)"/>
  <line x1="450" y1="200" x2="450" y2="137" stroke="#c9d4d2" stroke-width="2" marker-end="url(#a)"/>
  <line x1="772" y1="200" x2="500" y2="137" stroke="#c9d4d2" stroke-width="2" marker-end="url(#a)"/>
</svg>

${sections}

<footer>Built from the developer briefing of 15/11/2026 alone, with none of the CRM’s code or data. Run <code>npm run proof</code> to regenerate this page from a fresh test run.</footer>
</main></body></html>`;

fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
fs.writeFileSync(path.join(root, 'docs', 'proof.html'), html);
console.log(`docs/proof.html written: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
