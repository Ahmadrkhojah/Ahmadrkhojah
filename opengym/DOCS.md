# openGym

Self-hosted gym and body-weight log: routines, set logging, rest timer, records, charts, and an
iPhone/Android app. Upstream: https://github.com/DuarteSantos8/openGym (AGPL-3.0). The exercise
pictures are licensed to openGym only; don't reuse them elsewhere.

## How it is reached
One port, `8780/tcp`, plain http: `http://<this box>:8780/`. Use it from the home network or over
a private VPN such as Tailscale (WireGuard encrypts the traffic). Never forward the port on the
router and never publish it with Tailscale Funnel.

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
- `webhooks`: lets a profile send signed webhooks (workout finished, record, weigh-in), also to
  addresses on the home network, for example a Home Assistant webhook trigger. While it is on,
  every signed-in profile can make the app send requests into your home network, so keep sign-up
  invite-only and invite only people you trust. Off by default.
- `default_lang`: language for new profiles.

## Data and backup
Everything lives in the app's `/data/opengym` (users, sessions, workouts, uploads). Include this app
in your backups. Memory: the API is capped at 256 MB of JavaScript heap; nginx is small.

## Turn it off
Stop the app. Nothing else depends on it.
