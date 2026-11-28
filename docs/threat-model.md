# Threat model

What MixOS protects you from, what it doesn't, and what it assumes, on one
page. The detail, and the reasons, are in the
[security architecture](security-architecture.md).

## The trust model

**MixOS is built to run apps you wrote or have read.** Every app and connector
runs inside the MixOS server, with the server's power. MixOS gives an app only
what its `app.json` declares, and checks its code before it runs, but that
check reads the code: it isn't a sandbox. Code written to get around it can
reach everything the server can.

An app or a connector from mixos.org is someone else's code. MixOS checks that
what you install is exactly the release that was published: signed, hashed and
pinned to one commit. It doesn't check that the code is safe. Read what it will
run before you register it.

## What it protects against, and what's left

| If this happens | What MixOS does | What's still exposed |
|---|---|---|
| **An app's code is malicious or compromised** | The build refuses an app that reads the server's environment, reaches the network directly, or imports anything off a short list. At runtime the app gets only what its manifest declares: its own tables, the connector methods it may call, the hosts it listed. It can't widen any of them. Its database queries run as its own role, so Postgres refuses one that reaches another app's tables or the platform's, however it's written. An admin can switch an app off, and none of its code runs from the next request. ([§24](security-architecture.md#24-environment-containment), [§16.1](security-architecture.md#161-what-an-app-can-reach-on-a-connector), [§8](security-architecture.md#where-authorization-actually-happens), [§3.1](security-architecture.md#31-user-to-app-access-control)) | Code written to dodge the build's check runs inside the server. It can reach every key, the whole database and every connector's credentials. |
| **A package MixOS uses is malicious** | Apps can't add packages. MixOS's own are pinned by its lockfile, and CI fails on a high-severity advisory in any that ship. ([§30](security-architecture.md#30-dependency-supply-chain)) | A compromised package runs with the server's full power. |
| **A route in an app has a bug** | Around every handler, the platform checks sign-in, access, roles, CSRF, the input's and output's shape, rate limits and budgets, and keeps error details from the browser. A query that names another app's tables or the platform's is refused by the database. ([§1](security-architecture.md#1-request-lifecycle), [§8](security-architecture.md#where-authorization-actually-happens)) | Whatever that app can reach: its own data, and its connectors' methods. A bug that runs an attacker's code is the first row. |
| **Someone steals a person's session** | Session cookies can't be read by scripts, and another site can't send them with a post or a script. Changing data through an app's API also needs a token only MixOS's own pages get. An admin can sign someone out everywhere, and changing a password does it too. Admin rights are re-checked on every request. ([§12](security-architecture.md#12-session-cookie-security), [§7](security-architecture.md#7-csrf-protection)) | Until they're signed out, the thief is that person. An admin's session can configure connectors, switch apps on and make API keys. There is no second factor. |
| **The database password leaks** | Connector credentials, people's account tokens and secret app settings are encrypted with keys that aren't in the database. Passwords are bcrypt hashes, and MCP tokens and API keys are kept only as HMACs. ([§5](security-architecture.md#5-environment-secrets), [§8](security-architecture.md#8-database-access-model)) | Everything else can be read and changed: every app's data, the people, the audit log. The attacker can make themselves an admin. Keep the database off the public internet. |
| **A key leaks** | Each key protects one thing and is changed on its own. An encryption key is useless without the database. ([§5](security-architecture.md#5-environment-secrets)) | With the database, that key's secrets: every shared connector credential, for one. A signing key works on its own: `AUTH_SECRET` forges sign-ins, `APP_UNLOCK_SECRET` opens password-protected apps, and `CRON_SECRET` runs scheduled jobs. Changing an encryption key means entering what it protected again, except the GitHub App's, which has a command that re-encrypts it. |
| **A shared connector token is stolen** | One token per connector, shared by every app and person that uses it. MixOS decides which apps may call which methods. A change needs the app to ask for it and an admin to allow it, and until then MixOS doesn't ask an OAuth provider for the connector's write permissions. Admin → Connectors shows each app that uses it, what it may call, and what it called in the last 30 days. ([§3.4](security-architecture.md#34-connector-credential-scope), [§16.1](security-architecture.md#161-what-an-app-can-reach-on-a-connector)) | The token can do everything its permissions allow at the provider, outside MixOS. Disabling the connector doesn't revoke it: revoke it at the provider, then enter a new one. |

## What MixOS doesn't protect against

- An admin acting in bad faith. Admins hold every credential.
- An app or connector you chose to install doing what it was written to do.
- Someone who controls your host, your repository or your deploy settings.
- A breach at a service a connector talks to.

Found a way around something on this page? Report it privately: see
[SECURITY.md](../SECURITY.md).
