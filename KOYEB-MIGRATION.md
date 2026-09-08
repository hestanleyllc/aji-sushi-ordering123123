# AJI SUSHI — Koyeb migration notes

This build is compatible with Koyeb's Node.js buildpack.

## Important: persistent data

The application stores live data in `DATA_DIR/data.json` and dish images in `DATA_DIR/images/`.
Do **not** run the production restaurant on a Koyeb Free or Eco instance with local disk only: local storage is ephemeral and Free/Eco cannot attach a Koyeb Volume.

For a direct migration without changing the storage architecture:

1. Use a **Standard** Koyeb instance in Washington, D.C. (the smallest Standard size can be tested first).
2. Create and attach a Koyeb Volume to the service.
3. Mount it at `/data`.
4. Set `DATA_DIR=/data`.
5. Copy the current Render `data.json` and `images/` contents to that volume before switching DNS.
6. Copy all existing environment variables from Render (ADMIN_USER, ADMIN_PASSWORD, SESSION_SECRET, Stripe/Twilio/VAPID/etc. as applicable).
7. Koyeb can use the existing `npm start`; the app already listens on `process.env.PORT`.
8. Verify `/healthz`, customer ordering, kitchen login, order acceptance, printing, Stripe/Twilio/push, and image loading before moving the custom domain.

## Bandwidth fixes included in this build

- Kitchen order fallback polling: 1 second -> 30 seconds. SSE remains the instant update path.
- Kitchen site-info refresh now uses a small `/api/site-info` response instead of downloading the whole menu/config every 20 seconds.
- Customer full-config refresh: 20 seconds -> 60 seconds.

These changes reduce HTTP response traffic substantially even if you stay on Render.


### Kitchen live-update bandwidth optimization
The kitchen board uses SSE as the primary real-time channel. While SSE is connected there is no periodic order polling. If SSE disconnects, a 3-second fallback poll starts automatically and stops immediately when SSE reconnects.
