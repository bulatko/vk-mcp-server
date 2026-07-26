# Getting a VK token

VK will not let an application read your data until you tell it to. There are
two ways to do that, and which one you want depends on whose data you are after.
Both take about two minutes.

| You want to… | Use | Needs a VK app? |
|---|---|---|
| Read and post in a community you manage | **Community token** | No |
| Read your own feed, friends, groups; search; act as yourself | **User token** | Yes, your own |

If you only ever wanted "let the assistant run my community", take the first
one. It is three clicks and there is no OAuth involved.

**Not the service key.** VK also hands out a *service key* on every app page,
and it is the easiest of the three to obtain — which is why people reach for it
first and conclude the server is broken. Measured against the live API, it
opens three of the nineteen tools: `vk_users_get`, `vk_wall_get` and
`vk_groups_get_by_id`. Everything else — photos, reactions, search, members,
individual posts, statistics — refuses it with error 1051 or 28. Use it only if
public profiles and walls are genuinely all you need.

---

## Community token — 3 steps, no app

1. Open the community you manage → **Manage** (right-hand menu).
2. Find **API usage** — recent VK builds file it under **Advanced** in that
   menu — then **Access tokens** → **Create token**.
3. Tick **wall**, **photos** and, if you want the assistant to see statistics,
   **manage**. Confirm, and copy the token.

The page lives in the full web version; the mobile app has no API section at
all, so on a phone you need a browser with "desktop site" turned on.

That is the whole thing. The token does not expire and is not tied to your
browser, so it keeps working from any machine — including a server.

Give it to the server as `VK_ACCESS_TOKEN`, then check what it can do:

```bash
VK_ACCESS_TOKEN=vk1.a... npx vk-mcp-server --check
```

A community token acts *as the community*. It cannot read your friends or your
newsfeed — that is expected, not a misconfiguration.

---

## User token — 5 steps, your own app

You need your own VK application. Not because this is unusual, but because a
token is bound to the app that issued it: if you use somebody else's app ID and
VK ever blocks that app, your token dies with it and nothing in the error says
why. Two minutes now saves that.

### 1. Create the app

Open **https://vk.com/editapp?act=create**

- **Title**: anything — `My assistant` will do. Only you see it.
- **Platform**: **Standalone** (a desktop or mobile app, not a website).

Click create. VK may ask to confirm by phone.

### 2. Copy the App ID

You land on the app's settings. The **App ID** (a number like `54470067`) is at
the top. Keep it — it is not a secret.

### 3. Allow the callback address

In the app's settings, find **Trusted redirect URI** (under the VK ID or
OAuth section) and add exactly:

```
http://127.0.0.1:8790/callback
```

This is where VK hands the token back to the helper running on your machine.
Without it VK refuses the sign-in.

> Running the server on a different machine than your browser — a VPS, a
> home server? Read [Remote installs](#remote-installs) first. VK ties the
> token to the IP that signs in, so the straightforward route will not work.

### 4. Run the helper

```bash
npx vk-mcp-server --login <YOUR_APP_ID>
```

It opens VK in your browser. Approve the request, and the token is printed in
the terminal.

### 5. Give the token to your client

Claude Desktop: paste it into the extension's settings field. Anything else:
set `VK_ACCESS_TOKEN`. Then confirm it works:

```bash
VK_ACCESS_TOKEN=vk2.a... npx vk-mcp-server --check
```

---

## Remote installs

VK binds a user token to the IP address that authorised it. When the browser
you sign in with is on your laptop and the server runs on a VPS, the token
works for a minute or so and then every call fails with:

```
error 5, subcode 1130: access_token was given to another ip address
```

The token is fine. The requests are simply arriving from somewhere else.

Ways around it:

- **Use a community token.** Not tied to a browser session or an IP. This is
  the simplest answer and covers most remote setups.
- **Authorise from the server.** Forward the helper's port to your machine
  (`ssh -L 8790:127.0.0.1:8790 user@server`), run `--login` on the server, and
  open the printed URL locally — the callback then returns over the tunnel.
  The token is still bound to your browser's IP, so this only helps when the
  server and browser share an outbound address.
- **Point the callback at a public URL.** Set `VK_LOGIN_REDIRECT` to an address
  that reaches the helper (through nginx, say) and register it as a trusted
  redirect. This solves delivery of the code, not the IP binding.

---

## What the scopes mean

`--login` asks for `wall,friends,groups,photos,stats,offline`. Each maps to
tools you would otherwise find missing:

| Scope | Unlocks |
|---|---|
| `wall` | reading walls, posting, editing, deleting, commenting |
| `friends` | `vk_friends_get` |
| `groups` | your communities, joining |
| `photos` | reading albums, uploading photos for posts |
| `stats` | community statistics (you must be an admin) |
| `offline` | a longer-lived token |

Asking for less is fine — the tools you did not authorise will simply return an
error explaining which permission is missing.

---

## If something goes wrong

Run `npx vk-mcp-server --check` first. It reports which of the three token
types you have, who it acts as, and what it can reach.

| What you see | What it means |
|---|---|
| `Security Error` while authorising | The old implicit OAuth flow, which VK retired. Use `--login`, which uses the current VK ID flow. |
| `error 8: Application is blocked` | The app that issued the token is blocked. Create your own (step 1 above) and issue a fresh token. |
| `error 5` with `subcode 1130` | IP binding — see [Remote installs](#remote-installs). |
| `error 5` otherwise | The token expired or was revoked. Run `--login` again. |
| `error 1051` or `error 28` | That is a service token; it cannot call user methods. Use a user or community token. |
| `error 15: Access denied` | The data is restricted — a private profile, or a community that hides its members. |
