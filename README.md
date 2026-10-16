# CampusVibe

Random video and text chat, only for students with an `@srmist.edu.in` email.

## Run it on your laptop

```bash
npm install
npm start
```

Open https://localhost:3000. With no email key set, login codes are printed in the terminal instead of being emailed.

To test with two people, use two different browsers (for example Chrome and Safari) and two different `@srmist.edu.in` addresses. You can't be matched with your own email.

## Put it online (Render)

1. Push this folder to a **private** GitHub repo. `.gitignore` already keeps out `.env`, the `.pem` files and `data/`.
2. On https://render.com, click **New → Web Service** and pick the repo.
   - Build command: `npm install`
   - Start command: `npm start`
3. Under **Environment**, add:
   - `NODE_ENV` = `production`
   - `SESSION_SECRET` = a long random string (run `openssl rand -hex 32` to make one)
   - `RESEND_API_KEY` and `EMAIL_FROM`: see "Sending login emails" below
   - TURN relay (`CLOUDFLARE_TURN_*`, `METERED_*` or `TURN_*`): see "Making video work on campus Wi-Fi" below
4. Optional, so bans survive restarts: add a **Disk** mounted at `/var/data` and set `DATA_DIR=/var/data`. This needs a paid plan. Without it, bans reset whenever the server restarts.

Render gives you a free `https://your-app.onrender.com` link. Free servers go to sleep when nobody is using them, so the first visit can take about 30 seconds.

## Sending login emails

1. Create a free account at https://resend.com.
2. Add and verify a domain you own. Without one, Resend only sends to your own address.
3. Create an API key and put it in `RESEND_API_KEY`.
4. Set `EMAIL_FROM` to an address on that domain, e.g. `login@yourdomain.com`.

## Making video work on campus Wi-Fi

Campus and mobile networks often block direct video connections, so two people on different networks just see a black screen. A TURN server relays the video when that happens. Set up **one** of these on Render (Environment tab), then redeploy:

**Option A: Cloudflare TURN (recommended, 1,000 GB/month free)**
1. Cloudflare dashboard → **Realtime → TURN Server → Create**.
2. Copy the **Turn Token ID** and **API Token** into:
   - `CLOUDFLARE_TURN_KEY_ID`
   - `CLOUDFLARE_TURN_API_TOKEN`

**Option B: Metered TURN (free tier)**
1. Sign up at https://www.metered.ca/stun-turn and create an app.
2. Set `METERED_DOMAIN` (e.g. `yourapp.metered.live`) and `METERED_API_KEY` (from the TURN credentials page).

**Option C: any other TURN server** with fixed credentials: `TURN_URLS` (comma-separated), `TURN_USERNAME`, `TURN_CREDENTIAL`.

Options A and B create fresh credentials automatically. When the server starts, the log says whether a TURN relay is set up.

## Moderation

- If 3 different people report someone within 7 days, that person is banned for 24 hours. Change this with `REPORTS_TO_BAN` and `BAN_HOURS`.
- Reports and bans are saved in `data/moderation.json`.
- To ban someone permanently, set `"until": null` for their email in that file, then restart the server.
- Every report is also printed in the server log.
