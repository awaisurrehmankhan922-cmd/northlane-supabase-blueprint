# Phone bridge

The small program between TINKLE (the hosted Asterisk system from Commerce Business Systems) and the CRM's existing `POST /api/phone/event` endpoint. One Node file, no npm packages.

```
Yealink T87W ──SIP──▶ TINKLE (Asterisk) ──AMI / webhook──▶ bridge.js ──HTTPS + X-Phone-Key──▶ CRM /api/phone/event
                                                                                                    │
                                                            negotiator's browser ◀── SSE / Realtime ─┘  "07700 900123 · Alice Landlord · ringing 201"
```

## Which mode

Ask the supplier one question: *"How can a third-party CRM receive call events: AMI, a webhook, or neither?"*

| Supplier offers | `MODE` | Where the bridge runs | Click-to-dial |
|---|---|---|---|
| AMI access (what their other integrations use) | `ami` | A small machine on the office network, or a VPS joined to the supplier by VPN. AMI is **never** exposed to the internet. | Yes: AMI `Originate` rings the person's own handset, then dials. |
| Webhooks / an HTTP push API | `webhook` | Anywhere with HTTPS (the same host as the CRM is fine). Verified by shared key or HMAC, plus an IP allow-list. | Only if their API has a dial call. |
| Nothing | `yealink` | On the office network: each handset's Action URLs call the bridge directly. | No; `tel:` links stay as today. |

## Security, in all modes

- Every post to the CRM carries `X-Phone-Key` from the environment. The CRM answers 503 until that key is set, 400 for a wrong shape.
- Webhook mode: refuse before reading. Signature or key is checked with a constant-time compare; events older than two minutes are ignored (replay); the sender's address must be on `ALLOW_FROM`.
- The bridge never reads contact data. It knows numbers and extensions, nothing else. Matching the caller to a contact happens on the CRM server, under the signed-in negotiator's permissions.
- Internal extension-to-extension calls are ignored, so the call log holds outside callers only.
- Duplicate Asterisk events (`Newchannel` and `DialBegin` for the same call) are posted once.
- A failed post is retried five times with back-off, then logged loudly. Nothing is dropped silently.

## Running

```bash
cp ../.env.example .env   # fill in PHONE_EVENT_KEY, CRM_URL, and the mode's settings
MODE=ami AMI_HOST=10.0.0.5 AMI_USER=crm AMI_SECRET=... EXTENSIONS=201,202,203 node bridge.js
```

As a service: `systemd` unit with `Restart=always`, or a tiny Docker image. Memory use is a few MB.

## Testing without a phone system

`npm run test:unit` runs `test/05-phone-bridge.test.js`: a fake Asterisk server feeds a call that rings 201, is answered by 201 and transferred to 203, and a fake CRM checks it receives exactly `ringing`, `answered`, `transferred` with the four fields and the key header. The webhook and Yealink handlers are tested the same way.

## Event mapping (from the briefing, page 21)

| Asterisk AMI | CRM event | Note |
|---|---|---|
| `Newchannel` / `DialBegin` with an outside caller and an extension | `ringing` | once per call |
| `BridgeEnter` | `answered` | the extension that picked up, which may differ from the one that rang |
| `BlindTransfer` / `AttendedTransfer` | `transferred` | may repeat, each with the new extension |
| `Hangup` before any answer | `missed` | no hang-up detection after an answer: the person ends the call in the CRM with notes |
