# Getting a VK token

**Short version: if you want the assistant to do anything beyond reading public
pages, you need a community token.** It is three clicks, needs no app, and is
the only kind VK still lets post, edit or upload.

That is not a preference, it is what VK now permits. Three kinds of token exist
and here is what each actually reaches, measured against the live API:

| Token | How you get it | What it can do |
|---|---|---|
| **Community** | Community → Manage → API usage → Access tokens | Everything, as the community: read walls and members, post, edit, delete, comment, upload photos, read statistics |
| **VK ID** (`vk2.a…`) | `npx vk-mcp-server --login` | Read public profiles, walls and community info. Nothing else — see below |
| **Service key** | App page, on any app | The same three reads, and nothing else |

**The catch with VK ID tokens.** `--login` walks VK's current sign-in flow and
hands you a token, and it looks like the full user token older guides describe.
It is not. VK issues these to *sign a person in*, and keeps most API methods
closed to them: posting, photos, friends, feeds and statistics all answer
`1051 — method is unavailable with current profile type`. No combination of
scopes changes it, and the older flow that did grant full user tokens now
answers `Security Error` for any app created since. If you have hit 1051 with a
token that VK accepted and an account with every right, this is why.

So `--login` is worth running only when public reads are genuinely all you
need — and then the service key does the same with less ceremony.

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

## VK ID token — 5 steps, your own app

**Read this first:** what comes out of these five steps reads public profiles,
walls and community info, and refuses everything else with error 1051. If you
came here to let the assistant post, go back and make a community token — this
flow cannot give you that, whatever scopes you tick.

Still useful in one case: reading public data as a signed-in person, without an
app of somebody else's between you and VK.

You need your own VK application, because a token is bound to the app that
issued it: use somebody else's app ID, and if VK ever blocks that app your token
dies with it and nothing in the error says why.

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
  the simplest answer and covers most remote setups — and the only one that can
  write, whatever else you try.
- **Sign in from the server's own browser.** The binding follows the browser
  that authorises, so run one *on the server*: open the printed URL in a
  headless browser there and sign in by QR code, scanning it with your phone.
  The IP that authorises is then the IP that calls the API, and the token
  survives. Verified against the live API — no 1130 afterwards.
- **Paste the redirect back.** With no browser on the server at all, open the
  URL anywhere, let the callback page fail to load, and paste the address it
  tried to open into `--login`. This delivers the code, but the token stays
  bound to whichever browser signed in.
- **Point the callback at a public URL.** Set `VK_LOGIN_REDIRECT` to an address
  that reaches the helper (through nginx, say) and register it as a trusted
  redirect. Same caveat: it solves delivery, not the binding.

Worth repeating: all of this concerns a VK ID token, which reads public data
and refuses to write. If the goal is posting, only the first option applies.

---

## What the scopes mean

A **community token** asks you to tick permissions when you create it, and they
map directly to tools:

| Permission | Unlocks |
|---|---|
| `wall` | reading the wall, posting, editing, deleting, commenting |
| `photos` | reading albums, uploading photos for posts |
| `manage` | community statistics |

Tick `wall` and `photos` unless you know you need less.

`--login` requests `wall,friends,groups,photos,stats,offline` as well, but on a
VK ID token those scopes do not open the matching methods: VK grants the scope
and still answers `1051`. Do not spend time adjusting them — the limit is the
kind of token, not the permissions on it.

---

## If something goes wrong

Run `npx vk-mcp-server --check` first. It reports which of the three token
types you have, who it acts as, and what it can reach.

| What you see | What it means |
|---|---|
| `Security Error` while authorising | The old OAuth flow, which VK no longer opens to apps created since. `--login` uses the current VK ID flow instead — but see what that token can do, above. |
| `error 8: Application is blocked` | The app that issued the token is blocked. Create your own (step 1 above) and issue a fresh token. |
| `error 5` with `subcode 1130` | IP binding — see [Remote installs](#remote-installs). |
| `error 5` otherwise | The token expired or was revoked. Run `--login` again. |
| `error 1051` or `error 28` | The token's kind is not allowed to call that method — a service key and a VK ID token both hit this. Only a community token reaches the rest. |
| `error 15: Access denied` | The data is restricted — a private profile, or a community that hides its members. |
