# openGym

Self-hosted gym and body-weight log: routines, set logging, rest timer, records, charts, and an
iPhone/Android app. Upstream: https://github.com/DuarteSantos8/openGym (AGPL-3.0). The exercise
pictures are licensed to openGym only; don't reuse them elsewhere.

## How it is reached
One port, `8780/tcp`, plain http: `http://<this box>:8780/`. Use it from the home network or over
a private VPN such as Tailscale (WireGuard encrypts the traffic). Never forward the port on the
router and never publish it with Tailscale Funnel.

To use it from anywhere without a VPN, put it behind an https reverse proxy (for example the NGINX
SSL proxy app with an extra server block) and set `origin` to that https address. The sign-in page
is then public: keep `invite_only` on and use a strong password. The proxy must overwrite
`X-Forwarded-For` with the client's address; the app trusts that header only from the Supervisor
network (172.30.32.0/23), so its per-address sign-in limits see real visitors. One origin only:
after switching to https, sign-in at the plain http address stops working.

Passkeys need https, so on this plain-http address you sign in with **name + password**
(`password_login`, on by default).

## First start
Sign-up is invite-only (`invite_only`, on). While the app has no profile yet, the log shows a
one-time invite code. Open the app, choose **Create new profile**, pick a password and paste the
code. That first profile is the app's admin; the code stops working once used. More people need a
code from Settings → Account → Admin dashboard.

## Options
- `origin`: the exact address you open the app at (scheme, host, port). Sessions and links use it.
- `password_login`, `invite_only`, `allow_guest`: sign-in rules (guests keep data only in the browser).
- `webhooks`: lets a profile send signed webhooks (workout finished, record, weigh-in). Plain http
  and private addresses are allowed ONLY to Home Assistant itself (the Supervisor gateway, the name
  `homeassistant`): this app patches upstream's "whole home network" rule at build time, so a
  signed-in profile cannot make the app call other devices on your network. Use
  `http://homeassistant:8123/api/webhook/<id>`. Off by default.
- `default_lang`: language for new profiles.

## House sidecar (0.2.0): plans that load themselves, invites, workout events
A small helper (`/og/house.mjs`) runs next to openGym as the same user. It opens no port. It talks to
openGym only through openGym's own local admin socket (commands `house.*`, `/og/house-cmds.mjs`),
so every change goes through openGym's own code: invites like the admin dashboard makes them, plans
written like an API token's write. If it stops, openGym keeps running.

It reads this app's own config folder (on the host `/addon_configs/<slug>/plans/`):
- `manifest.json`: who gets what. Example:
  ```json
  { "dry_run": false, "follow": "me",
    "people": [
      { "tag": "me", "label": "Me", "match": { "owner": true }, "plan": "me-plan.json" },
      { "tag": "friend", "label": "Friend", "match": { "names": ["friend"] }, "plan": "friend-plan.json", "invite": 1 } ] }
  ```
  `tag` is lowercase letters, digits and `-`; `plan` is a file in the same folder (an openGym plan
  file, kg). A person's profile is the owner (`"owner": true`), else the profile that used the invite
  made for their tag, else a profile with one of `names`.
- What happens: `"invite": N` makes one invite code for the person (noted `house:<tag>`), written to
  `invites.json` (0600) and once to this log. Raise N for a fresh code. Once the person's profile
  exists and has synced once, their plan is merged in, once: routines added as new ones, custom
  exercises reused by name, programmes added (not started), the week set only if the profile has
  none. A plan already in the profile (same routine names) is never added again. A copy of the
  profile as it was goes to `/data/opengym/house/backups/` first. `"dry_run": true` only reports.
- `status.json` says where each person is (no codes, no training data).
- With the option `house_webhook` set, the followed person's live workout (`live`), weekly numbers
  (`stats`, Sunday to Saturday) and loaded plans (`plan`) are POSTed to
  `http://homeassistant:8123/api/webhook/<house_webhook>` (the host is fixed).

## Data and backup
Everything lives in the app's `/data/opengym` (users, sessions, workouts, uploads). Include this app
in your backups. Memory: the API is capped at 256 MB of JavaScript heap; nginx is small.

## Turn it off
Stop the app. Nothing else depends on it.
